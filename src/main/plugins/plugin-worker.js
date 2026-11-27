// 独立插件宿主子进程（运行在 Electron utilityProcess 中，每个已启用插件独占一个进程）。
// 负责加载插件 ESM 入口、注入受控 PluginContext（网络/存储/密文均经主进程代理校验）、
// 通过 process.parentPort 做 JSON-RPC 2.0 调度与 AbortSignal 取消传播。
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  API_VERSION,
  PluginError,
  serializePluginError,
  validateAlbum,
  validateAuthAccount,
  validateBrowseSection,
  validateConfigSchema,
  validateCoverSource,
  validateLyricsPayload,
  validatePlaylist,
  validateStreamSource,
  validateTrack,
} from '../../../packages/dreamisle-plugin-sdk/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_SRC_DIR = path.resolve(__dirname, '../../../packages/dreamisle-plugin-sdk/src');

// 注册 ESM 解析钩子：让安装在 userData/plugins/<id>/ 且未自带 node_modules 的第三方插件
// 可以直接 `import { definePlugin, PluginError } from 'dreamisle-plugin-sdk'`。
const sdkBaseUrl = pathToFileURL(SDK_SRC_DIR + path.sep).href;
const loaderHookCode = `
const SDK_MAP = {
  'dreamisle-plugin-sdk': ${JSON.stringify(new URL('index.js', sdkBaseUrl).href)},
  'dreamisle-plugin-sdk/uri': ${JSON.stringify(new URL('uri.js', sdkBaseUrl).href)},
  'dreamisle-plugin-sdk/validate': ${JSON.stringify(new URL('validate.js', sdkBaseUrl).href)},
  'dreamisle-plugin-sdk/errors': ${JSON.stringify(new URL('errors.js', sdkBaseUrl).href)},
};
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(SDK_MAP, specifier)) {
    return { url: SDK_MAP[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
if (typeof module.register === 'function') {
  module.register(`data:text/javascript;base64,${Buffer.from(loaderHookCode).toString('base64')}`);
}

const port = process.parentPort;
if (!port) {
  process.exit(1);
}

let plugin = null;
let pluginId = '';
let currentLocale = 'zh-CN';
let currentConfig = {};
const configListeners = new Set();

// 反向 RPC（worker -> main）：用于 http.fetch / storage / secrets
let hostReqSeq = 0;
const hostPending = new Map();
// 正向 RPC（main -> worker）在途取消表
const activeControllers = new Map();

function post(msg) {
  port.postMessage(msg);
}

function invokeHost(method, params) {
  return new Promise((resolve, reject) => {
    const id = `h-${++hostReqSeq}`;
    hostPending.set(id, { resolve, reject });
    post({ type: 'host-rpc', id, method, params });
  });
}

function sendLog(level, msg, meta) {
  post({
    type: 'log',
    level,
    message: typeof msg === 'string' ? msg : String(msg),
    meta:
      meta !== undefined
        ? String(typeof meta === 'object' ? JSON.stringify(meta) : meta)
        : undefined,
  });
}

function buildContext() {
  return {
    get pluginId() {
      return pluginId;
    },
    get apiVersion() {
      return API_VERSION;
    },
    get locale() {
      return currentLocale;
    },
    http: {
      async fetch(url, init = {}) {
        const signal = init?.signal;
        if (signal?.aborted) {
          throw new PluginError('TIMEOUT', 'Request aborted');
        }
        let bodyPayload;
        if (typeof init?.body === 'string') {
          bodyPayload = { kind: 'text', data: init.body };
        } else if (init?.body instanceof Uint8Array || ArrayBuffer.isView(init?.body)) {
          bodyPayload = { kind: 'bytes', data: Buffer.from(init.body).toString('base64') };
        }
        const res = await invokeHost('http.fetch', {
          url: String(url),
          method: typeof init?.method === 'string' ? init.method : 'GET',
          headers: init?.headers && typeof init.headers === 'object' ? init.headers : undefined,
          body: bodyPayload,
          timeoutMs: Number.isFinite(init?.timeoutMs) ? init.timeoutMs : 12000,
        });
        const rawBytes = Buffer.from(res.bodyBase64 || '', 'base64');
        return {
          status: res.status,
          ok: res.ok,
          headers: res.headers || {},
          setCookies: Array.isArray(res.setCookies) ? res.setCookies : [],
          async text() {
            return rawBytes.toString('utf8');
          },
          async json() {
            return JSON.parse(rawBytes.toString('utf8'));
          },
          async arrayBuffer() {
            return rawBytes.buffer.slice(
              rawBytes.byteOffset,
              rawBytes.byteOffset + rawBytes.byteLength
            );
          },
        };
      },
    },
    storage: {
      get: (key) => invokeHost('storage.get', { key }),
      set: (key, value) => invokeHost('storage.set', { key, value }),
      delete: (key) => invokeHost('storage.delete', { key }),
      clear: () => invokeHost('storage.clear', {}),
    },
    secrets: {
      get: (key) => invokeHost('secrets.get', { key }),
      set: (key, value) => invokeHost('secrets.set', { key, value }),
      delete: (key) => invokeHost('secrets.delete', { key }),
    },
    config: {
      async getAll() {
        return { ...currentConfig };
      },
      async get(key) {
        return Object.hasOwn(currentConfig, key) ? currentConfig[key] : undefined;
      },
      onChange(listener) {
        if (typeof listener !== 'function') return () => {};
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      },
    },
    logger: {
      debug: (msg, meta) => sendLog('debug', msg, meta),
      info: (msg, meta) => sendLog('info', msg, meta),
      warn: (msg, meta) => sendLog('warn', msg, meta),
      error: (msg, meta) => sendLog('error', msg, meta),
    },
  };
}

function ensureMethod(obj, name, groupName) {
  if (!obj || typeof obj[name] !== 'function') {
    throw new PluginError('UNSUPPORTED', `Plugin does not implement ${groupName}.${name}`);
  }
  return obj[name].bind(obj);
}

function normalizePage(res, itemValidator) {
  const rawItems = Array.isArray(res?.items) ? res.items : [];
  const items = rawItems.map(itemValidator).filter(Boolean);
  return {
    items,
    hasMore: res?.hasMore === true,
    total: Number.isInteger(res?.total) && res.total >= 0 ? res.total : undefined,
  };
}

async function dispatchRpc(method, params, signal) {
  if (!plugin) throw new PluginError('INTERNAL_ERROR', 'Plugin not activated');

  switch (method) {
    case 'source.searchTracks': {
      const fn = ensureMethod(plugin.source, 'searchTracks', 'source');
      const res = await fn(String(params?.query || ''), {
        page: Math.max(1, Number(params?.page) || 1),
        pageSize: Math.min(100, Math.max(1, Number(params?.pageSize) || 30)),
        signal,
      });
      return normalizePage(res, validateTrack);
    }
    case 'source.searchAlbums': {
      const fn = ensureMethod(plugin.source, 'searchAlbums', 'source');
      const res = await fn(String(params?.query || ''), {
        page: Math.max(1, Number(params?.page) || 1),
        pageSize: Math.min(100, Math.max(1, Number(params?.pageSize) || 30)),
        signal,
      });
      return normalizePage(res, validateAlbum);
    }
    case 'source.searchPlaylists': {
      const fn = ensureMethod(plugin.source, 'searchPlaylists', 'source');
      const res = await fn(String(params?.query || ''), {
        page: Math.max(1, Number(params?.page) || 1),
        pageSize: Math.min(100, Math.max(1, Number(params?.pageSize) || 30)),
        signal,
      });
      return normalizePage(res, validatePlaylist);
    }
    case 'source.getAlbumTracks': {
      const fn = ensureMethod(plugin.source, 'getAlbumTracks', 'source');
      const res = await fn(String(params?.albumId || ''), { signal });
      return {
        album: validateAlbum(res?.album),
        tracks: (Array.isArray(res?.tracks) ? res.tracks : []).map(validateTrack).filter(Boolean),
      };
    }
    case 'source.getPlaylistTracks': {
      const fn = ensureMethod(plugin.source, 'getPlaylistTracks', 'source');
      const res = await fn(String(params?.playlistId || ''), {
        page: Math.max(1, Number(params?.page) || 1),
        pageSize: Math.min(200, Math.max(1, Number(params?.pageSize) || 50)),
        signal,
      });
      return {
        playlist: validatePlaylist(res?.playlist),
        tracks: normalizePage(res?.tracks, validateTrack),
      };
    }
    case 'source.getHomeSections': {
      if (!plugin.source?.getHomeSections) return [];
      const res = await plugin.source.getHomeSections({ signal });
      return (Array.isArray(res) ? res : []).map(validateBrowseSection).filter(Boolean);
    }
    case 'source.getUserPlaylists': {
      if (!plugin.source?.getUserPlaylists) return [];
      const res = await plugin.source.getUserPlaylists({ signal });
      return (Array.isArray(res) ? res : []).map(validatePlaylist).filter(Boolean);
    }
    case 'source.resolveStream': {
      const fn = ensureMethod(plugin.source, 'resolveStream', 'source');
      const raw = await fn(params?.track, { quality: params?.quality || 'lossless', signal });
      const stream = validateStreamSource(raw);
      if (!stream) throw new PluginError('NOT_FOUND', 'Plugin returned invalid StreamSource');
      return stream;
    }
    case 'source.getCover': {
      if (!plugin.source?.getCover) return null;
      const raw = await plugin.source.getCover(params?.track, { signal });
      return validateCoverSource(raw);
    }
    case 'lyrics.getLyrics': {
      if (!plugin.lyrics?.getLyrics) return null;
      const raw = await plugin.lyrics.getLyrics(params?.track, { signal });
      return validateLyricsPayload(raw);
    }
    case 'lyrics.matchLyrics': {
      if (!plugin.lyrics?.matchLyrics) return null;
      const raw = await plugin.lyrics.matchLyrics(params?.query, { signal });
      return validateLyricsPayload(raw);
    }
    case 'auth.describe': {
      if (!plugin.auth) return { supported: false };
      const formFields = plugin.auth.form?.fields
        ? validateConfigSchema(plugin.auth.form.fields).value
        : [];
      return {
        supported: true,
        hasQr: Boolean(plugin.auth.qr?.start && plugin.auth.qr?.poll),
        hasForm: Boolean(plugin.auth.form?.submit && formFields.length > 0),
        formFields,
      };
    }
    case 'auth.getAccount': {
      const fn = ensureMethod(plugin.auth, 'getAccount', 'auth');
      return validateAuthAccount(await fn());
    }
    case 'auth.logout': {
      const fn = ensureMethod(plugin.auth, 'logout', 'auth');
      await fn();
      return { ok: true };
    }
    case 'auth.qrStart': {
      const fn = ensureMethod(plugin.auth?.qr, 'start', 'auth.qr');
      const res = await fn();
      return {
        key: String(res?.key || ''),
        qrText: typeof res?.qrText === 'string' ? res.qrText : undefined,
        qrDataUrl:
          typeof res?.qrDataUrl === 'string' && res.qrDataUrl.startsWith('data:image/')
            ? res.qrDataUrl
            : undefined,
        expiresInSec: Number.isFinite(res?.expiresInSec) ? res.expiresInSec : 180,
        tip: typeof res?.tip === 'string' ? res.tip.slice(0, 200) : undefined,
      };
    }
    case 'auth.qrPoll': {
      const fn = ensureMethod(plugin.auth?.qr, 'poll', 'auth.qr');
      const res = await fn(String(params?.key || ''));
      const status = ['pending', 'scanned', 'confirmed', 'expired'].includes(res?.status)
        ? res.status
        : 'pending';
      return {
        status,
        message: typeof res?.message === 'string' ? res.message.slice(0, 200) : undefined,
        account: res?.account ? validateAuthAccount(res.account) : undefined,
      };
    }
    case 'auth.formSubmit': {
      const fn = ensureMethod(plugin.auth?.form, 'submit', 'auth.form');
      return validateAuthAccount(await fn(params?.values || {}));
    }
    case 'lifecycle.onTrackChange': {
      if (typeof plugin.lifecycle?.onTrackChange === 'function') {
        await plugin.lifecycle.onTrackChange(params);
      }
      return { ok: true };
    }
    case 'lifecycle.onPlaybackState': {
      if (typeof plugin.lifecycle?.onPlaybackState === 'function') {
        await plugin.lifecycle.onPlaybackState(params);
      }
      return { ok: true };
    }
    case 'lifecycle.onTrackComplete': {
      if (typeof plugin.lifecycle?.onTrackComplete === 'function') {
        await plugin.lifecycle.onTrackComplete(params);
      }
      return { ok: true };
    }
    case 'shutdown': {
      if (typeof plugin.deactivate === 'function') {
        await plugin.deactivate();
      }
      return { ok: true };
    }
    default:
      throw new PluginError('UNSUPPORTED', `Unknown RPC method: ${method}`);
  }
}

port.on('message', async (event) => {
  const msg = event?.data ?? event;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'host-rpc-res') {
    const pending = hostPending.get(msg.id);
    if (!pending) return;
    hostPending.delete(msg.id);
    if (msg.error) {
      pending.reject(
        new PluginError(msg.error.code || 'INTERNAL_ERROR', msg.error.message || 'Host RPC failed')
      );
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  if (msg.type === 'init') {
    try {
      pluginId = msg.pluginId;
      currentLocale = msg.locale || 'zh-CN';
      currentConfig = msg.config && typeof msg.config === 'object' ? { ...msg.config } : {};

      const mod = await import(pathToFileURL(msg.entryPath).href);
      const def = mod?.default || mod;
      if (!def || typeof def !== 'object') {
        throw new PluginError('INTERNAL_ERROR', 'Plugin entry must export default plugin object');
      }
      plugin = def;

      const ctx = buildContext();
      if (typeof plugin.activate === 'function') {
        await plugin.activate(ctx);
      }
      const authMeta = plugin.auth
        ? await dispatchRpc('auth.describe', {}, new AbortController().signal)
        : { supported: false };
      post({ type: 'ready', authMeta });
    } catch (err) {
      post({ type: 'init-error', error: serializePluginError(err) });
    }
    return;
  }

  if (msg.type === 'config-changed') {
    currentConfig = msg.config && typeof msg.config === 'object' ? { ...msg.config } : {};
    for (const listener of configListeners) {
      try {
        listener({ ...currentConfig });
      } catch (err) {
        sendLog('error', `config.onChange listener error: ${err?.message || err}`);
      }
    }
    return;
  }

  if (msg.type === 'locale-changed') {
    currentLocale = msg.locale || 'zh-CN';
    return;
  }

  if (msg.type === 'cancel') {
    const ac = activeControllers.get(msg.id);
    if (ac) {
      ac.abort();
      activeControllers.delete(msg.id);
    }
    return;
  }

  if (msg.type === 'rpc') {
    const ac = new AbortController();
    activeControllers.set(msg.id, ac);
    try {
      const result = await dispatchRpc(msg.method, msg.params, ac.signal);
      post({ type: 'rpc-res', id: msg.id, result });
      if (msg.method === 'shutdown') {
        setTimeout(() => process.exit(0), 20);
      }
    } catch (err) {
      post({ type: 'rpc-res', id: msg.id, error: serializePluginError(err) });
    } finally {
      activeControllers.delete(msg.id);
    }
  }
});

process.on('uncaughtException', (err) => {
  sendLog('error', `Uncaught exception: ${err?.stack || err?.message || err}`);
  setTimeout(() => process.exit(1), 30);
});

process.on('unhandledRejection', (reason) => {
  sendLog('error', `Unhandled rejection: ${reason?.stack || reason?.message || reason}`);
});
