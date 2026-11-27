// 单插件独立进程控制器：为每个已启用插件独占派生一个 Electron utilityProcess，
// 管理握手、双向 JSON-RPC、超时、AbortSignal 取消、受限 HTTP/存储/密文代理、崩溃隔离与日志缓冲。
import { utilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PluginError,
  deserializePluginError,
  serializePluginError,
} from '../../../packages/dreamisle-plugin-sdk/src/index.js';
import { scopedFetch } from './scoped-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT_PATH = path.join(__dirname, 'plugin-worker.js');

const INIT_TIMEOUT_MS = 10000;
const SHUTDOWN_TIMEOUT_MS = 2000;
const MAX_HTTP_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_LOG_ENTRIES = 100;

export class PluginProcess {
  constructor({ manifest, entryPath, storage, getConfig, getLocale, onStatusChange }) {
    this.manifest = manifest;
    this.entryPath = entryPath;
    this.storage = storage;
    this.getConfig = getConfig;
    this.getLocale = getLocale;
    this.onStatusChange = onStatusChange;

    this.child = null;
    this.status = 'stopped'; // 'stopped' | 'starting' | 'running' | 'crashed'
    this.lastError = null;
    this.authMeta = { supported: false };
    this.logs = [];

    this.reqSeq = 0;
    this.pending = new Map();
    this.startPromise = null;
    this.stopPromise = null;
    this.childExitPromise = null;
    this.stopping = false;
  }

  pushLog(level, message, meta) {
    this.logs.push({
      ts: Date.now(),
      level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
      message: String(message || '').slice(0, 1000),
      meta: meta !== undefined ? String(meta).slice(0, 500) : undefined,
    });
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
    }
  }

  setStatus(nextStatus, errorMsg = null) {
    this.status = nextStatus;
    this.lastError = errorMsg;
    if (this.onStatusChange) this.onStatusChange(this.manifest.id, nextStatus, errorMsg);
  }

  async start() {
    if (this.status === 'running' && this.child) return;
    if (this.startPromise) return this.startPromise;

    this.stopping = false;
    this.setStatus('starting', null);

    this.startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        this.startPromise = null;
        if (err) reject(err);
        else resolve();
      };

      let child;
      try {
        child = utilityProcess.fork(WORKER_SCRIPT_PATH, [], {
          serviceName: `dreamisle-plugin-${this.manifest.id}`,
          stdio: 'pipe',
        });
      } catch (err) {
        this.setStatus('crashed', err.message);
        finish(err);
        return;
      }

      this.child = child;
      this.childExitPromise = new Promise((res) => {
        child.once('exit', () => res());
      });
      // Electron utilityProcess 在触发 'spawn' 前调用 kill() 可能返回 false；
      // 若在派生完成前已被停止或替换，必须在 spawn 瞬间补杀，杜绝孤儿进程残留。
      child.once('spawn', () => {
        if (this.stopping || this.child !== child) {
          try {
            child.kill();
          } catch {}
        }
      });
      const initTimer = setTimeout(() => {
        const err = new PluginError('TIMEOUT', 'Plugin activation timed out');
        this.pushLog('error', err.message);
        this.killNow('crashed', err.message);
        finish(err);
      }, INIT_TIMEOUT_MS);

      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8').trim();
        if (text) this.pushLog('error', text);
      });

      child.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (this.child !== child) return;

        if (msg.type === 'ready') {
          if (this.stopping) {
            this.killNow('stopped', null);
            finish(new PluginError('INTERNAL_ERROR', 'Plugin stopped during activation'));
            return;
          }
          this.authMeta = msg.authMeta || { supported: false };
          this.setStatus('running', null);
          this.pushLog('info', `Plugin v${this.manifest.version} activated (PID ${child.pid})`);
          finish(null);
          return;
        }

        if (msg.type === 'init-error') {
          const err = deserializePluginError(msg.error);
          this.pushLog('error', `Activation failed: ${err.message}`);
          this.killNow('crashed', err.message);
          finish(err);
          return;
        }

        if (msg.type === 'log') {
          this.pushLog(msg.level, msg.message, msg.meta);
          return;
        }

        if (msg.type === 'host-rpc') {
          this.handleHostRpc(child, msg);
          return;
        }

        if (msg.type === 'rpc-res') {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (entry.cleanupAbort) entry.cleanupAbort();
          if (msg.error) entry.reject(deserializePluginError(msg.error));
          else entry.resolve(msg.result);
        }
      });

      child.on('exit', (code) => {
        if (this.child === child) this.child = null;
        const wasStopping = this.stopping;
        const exitMsg = wasStopping
          ? null
          : this.lastError || `Plugin process exited unexpectedly (code ${code})`;

        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          if (entry.cleanupAbort) entry.cleanupAbort();
          entry.reject(new PluginError('INTERNAL_ERROR', exitMsg || 'Plugin stopped'));
          this.pending.delete(id);
        }

        if (!settled) {
          this.setStatus(wasStopping ? 'stopped' : 'crashed', exitMsg);
          finish(new PluginError('INTERNAL_ERROR', exitMsg || 'Plugin stopped'));
        } else if (!wasStopping && this.status !== 'crashed') {
          this.pushLog('error', exitMsg);
          this.setStatus('crashed', exitMsg);
        } else if (wasStopping) {
          this.setStatus('stopped', null);
        }
      });

      child.postMessage({
        type: 'init',
        pluginId: this.manifest.id,
        entryPath: this.entryPath,
        manifest: this.manifest,
        locale: this.getLocale(),
        config: this.getConfig(),
      });
    });

    return this.startPromise;
  }

  async handleHostRpc(child, msg) {
    const reply = (payload) => {
      if (this.child === child) {
        try {
          child.postMessage({ type: 'host-rpc-res', id: msg.id, ...payload });
        } catch {}
      }
    };

    try {
      const { method, params } = msg;
      if (method === 'http.fetch') {
        const result = await this.executeScopedHttpFetch(params);
        reply({ result });
      } else if (method === 'storage.get') {
        reply({ result: await this.storage.get(params?.key) });
      } else if (method === 'storage.set') {
        await this.storage.set(params?.key, params?.value);
        reply({ result: true });
      } else if (method === 'storage.delete') {
        await this.storage.delete(params?.key);
        reply({ result: true });
      } else if (method === 'storage.clear') {
        await this.storage.clear();
        reply({ result: true });
      } else if (method === 'secrets.get') {
        if (!this.manifest.permissions?.secrets) {
          throw new PluginError('PERMISSION_DENIED', 'Plugin did not declare secrets permission');
        }
        reply({ result: await this.storage.getSecret(params?.key) });
      } else if (method === 'secrets.set') {
        if (!this.manifest.permissions?.secrets) {
          throw new PluginError('PERMISSION_DENIED', 'Plugin did not declare secrets permission');
        }
        await this.storage.setSecret(params?.key, params?.value);
        reply({ result: true });
      } else if (method === 'secrets.delete') {
        if (!this.manifest.permissions?.secrets) {
          throw new PluginError('PERMISSION_DENIED', 'Plugin did not declare secrets permission');
        }
        await this.storage.deleteSecret(params?.key);
        reply({ result: true });
      } else {
        throw new PluginError('UNSUPPORTED', `Unknown host RPC: ${method}`);
      }
    } catch (err) {
      reply({ error: serializePluginError(err) });
    }
  }

  async executeScopedHttpFetch(params) {
    const timeoutMs = Math.min(30000, Math.max(1000, Number(params?.timeoutMs) || 12000));
    let body;
    if (params?.body?.kind === 'text') {
      body = params.body.data;
    } else if (params?.body?.kind === 'bytes') {
      body = Buffer.from(params.body.data, 'base64');
    }

    const res = await scopedFetch(params?.url, this.manifest.permissions, {
      method: typeof params?.method === 'string' ? params.method.toUpperCase() : 'GET',
      headers: params?.headers && typeof params.headers === 'object' ? params.headers : undefined,
      body,
      timeoutMs,
    });

    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength > MAX_HTTP_RESPONSE_BYTES) {
      throw new PluginError('NETWORK_ERROR', 'HTTP response exceeded 10MB limit');
    }

    const headers = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];

    return {
      status: res.status,
      ok: res.ok,
      headers,
      setCookies,
      bodyBase64: Buffer.from(arrayBuf).toString('base64'),
    };
  }

  async invoke(method, params = {}, { timeoutMs = 10000, signal = null } = {}) {
    if (this.status !== 'running' || !this.child) {
      throw new PluginError('INTERNAL_ERROR', `Plugin "${this.manifest.id}" is not running`);
    }
    if (signal?.aborted) {
      throw new PluginError('TIMEOUT', 'Request aborted');
    }

    const id = `r-${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (cleanupAbort) cleanupAbort();
        try {
          this.child?.postMessage({ type: 'cancel', id });
        } catch {}
        reject(new PluginError('TIMEOUT', `RPC ${method} timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      let cleanupAbort = null;
      if (signal) {
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          try {
            this.child?.postMessage({ type: 'cancel', id });
          } catch {}
          reject(new PluginError('TIMEOUT', `RPC ${method} aborted`));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }

      this.pending.set(id, { resolve, reject, timer, cleanupAbort });
      try {
        this.child.postMessage({ type: 'rpc', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        if (cleanupAbort) cleanupAbort();
        reject(new PluginError('INTERNAL_ERROR', err?.message || 'Failed to send RPC'));
      }
    });
  }

  pushConfig(config) {
    if (this.status === 'running' && this.child) {
      try {
        this.child.postMessage({ type: 'config-changed', config });
      } catch {}
    }
  }

  pushLocale(locale) {
    if (this.status === 'running' && this.child) {
      try {
        this.child.postMessage({ type: 'locale-changed', locale });
      } catch {}
    }
  }

  killNow(nextStatus = 'stopped', errorMsg = null) {
    const child = this.child;
    this.child = null;
    this.setStatus(nextStatus, errorMsg);
    if (child) {
      try {
        child.kill();
      } catch {}
    }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;

    this.stopPromise = (async () => {
      const child = this.child;
      const exitPromise = this.childExitPromise;
      if (!child) {
        this.setStatus('stopped', null);
        return;
      }

      // 仅在已完成初始化并处于 running 状态时才尝试优雅 shutdown；
      // 若仍在 starting 中途被停止，直接终止子进程避免挂起或遗留孤儿进程。
      if (this.status === 'running') {
        try {
          await this.invoke('shutdown', {}, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
        } catch {}
      }

      if (this.child === child) {
        this.child = null;
      }
      try {
        child.kill();
      } catch {}

      // 等待子进程真正退出（最多 1s），若在 shutdown 期间已退出则会立即 resolve
      if (exitPromise) {
        let timer = null;
        await Promise.race([
          exitPromise,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
        if (timer) clearTimeout(timer);
      }

      this.setStatus('stopped', null);
    })().finally(() => {
      this.stopPromise = null;
    });

    return this.stopPromise;
  }
}
