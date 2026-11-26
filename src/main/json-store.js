// 轻量原子 JSON 配置存储：替代重依赖的 electron-store（省掉 ajv/conf 等冷导入耗时），
// 保持与原 userData/config.json 100% 兼容的文件格式与损坏恢复语义。
//
// 读操作直接命中内存对象（零重复 readFileSync / JSON.parse）；
// 写操作合并同帧/连续改动并异步原子落盘（临时文件 + rename），退出前由 flushSync 同步兜底。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const FLUSH_DEBOUNCE_MS = 32;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function splitKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  const parts = key.split('.');
  for (const seg of parts) {
    if (!seg || FORBIDDEN_SEGMENTS.has(seg)) return null;
  }
  return parts;
}

function getByPath(root, parts) {
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, parts[i])) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function setByPath(root, parts, value) {
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg];
  }
  const last = parts[parts.length - 1];
  const prev = cur[last];
  if (
    prev === value &&
    (value === null || (typeof value !== 'object' && typeof prev !== 'object'))
  ) {
    return false;
  }
  cur[last] = value;
  return true;
}

function deleteByPath(root, parts) {
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (!isPlainObject(cur) || !Object.hasOwn(cur, seg)) return false;
    cur = cur[seg];
  }
  const last = parts[parts.length - 1];
  if (!isPlainObject(cur) || !Object.hasOwn(cur, last)) return false;
  delete cur[last];
  return true;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JsonStore {
  constructor({ configPath, clearInvalidConfig = false }) {
    this.path = configPath;
    this._dir = path.dirname(configPath);
    this._data = {};
    this._dirty = false;
    this._persisted = true;
    this._writeGen = 0;
    this._flushTimer = null;
    this._writing = null;
    this._seq = 0;

    fs.mkdirSync(this._dir, { recursive: true });
    this._loadSync(clearInvalidConfig);
  }

  _loadSync(clearInvalidConfig) {
    let raw;
    try {
      raw = fs.readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this._data = {};
        return;
      }
      throw error;
    }

    if (raw.trim() === '') {
      if (clearInvalidConfig) {
        this._data = {};
        return;
      }
      throw new SyntaxError('Unexpected end of JSON input');
    }

    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        throw new SyntaxError('Config root must be a JSON object');
      }
      this._data = parsed;
    } catch (error) {
      if (clearInvalidConfig && error?.name === 'SyntaxError') {
        this._data = {};
        return;
      }
      throw error;
    }
  }

  get(key, defaultValue = undefined) {
    const parts = splitKey(key);
    if (!parts) return defaultValue;
    const value = getByPath(this._data, parts);
    return value === undefined ? defaultValue : value;
  }

  has(key) {
    const parts = splitKey(key);
    if (!parts) return false;
    return getByPath(this._data, parts) !== undefined;
  }

  set(keyOrObject, value) {
    let changed = false;
    if (isPlainObject(keyOrObject)) {
      for (const [k, v] of Object.entries(keyOrObject)) {
        const parts = splitKey(k);
        if (!parts) continue;
        if (v === undefined) {
          if (deleteByPath(this._data, parts)) changed = true;
        } else if (setByPath(this._data, parts, v)) {
          changed = true;
        }
      }
    } else {
      const parts = splitKey(keyOrObject);
      if (!parts) return;
      if (value === undefined) {
        changed = deleteByPath(this._data, parts);
      } else {
        changed = setByPath(this._data, parts, value);
      }
    }
    if (changed) this._scheduleFlush();
  }

  delete(key) {
    const parts = splitKey(key);
    if (!parts) return;
    if (deleteByPath(this._data, parts)) {
      this._scheduleFlush();
    }
  }

  _scheduleFlush() {
    this._dirty = true;
    this._persisted = false;
    this._writeGen++;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushAsync();
    }, FLUSH_DEBOUNCE_MS);
  }

  _serialize() {
    return JSON.stringify(this._data, null, '\t');
  }

  _flushAsync() {
    if (!this._dirty) return;
    if (this._writing) return;

    this._writing = (async () => {
      while (this._dirty) {
        const gen = this._writeGen;
        this._dirty = false;
        const payload = this._serialize();
        const tmpPath = `${this.path}.tmp-${process.pid}-${++this._seq}`;
        try {
          await fsp.mkdir(this._dir, { recursive: true });
          await fsp.writeFile(tmpPath, payload, 'utf8');
          // 写盘期间若有更新的同步/异步改动，放弃过期临时文件避免旧数据覆盖新数据
          if (gen !== this._writeGen) {
            await fsp.unlink(tmpPath).catch(() => {});
            continue;
          }
          let renamed = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await fsp.rename(tmpPath, this.path);
              renamed = true;
              break;
            } catch (err) {
              if (attempt < 2 && err && RENAME_RETRY_CODES.has(err.code)) {
                await sleepMs(20 * (attempt + 1));
                continue;
              }
              throw err;
            }
          }
          if (!renamed && gen === this._writeGen) {
            await fsp.writeFile(this.path, payload, 'utf8');
            await fsp.unlink(tmpPath).catch(() => {});
          }
          if (gen === this._writeGen && !this._dirty) {
            this._persisted = true;
          }
        } catch (error) {
          await fsp.unlink(tmpPath).catch(() => {});
          if (gen !== this._writeGen) continue;
          // Windows 杀软短锁导致 rename 失败时退回直接写盘，避免丢配置
          try {
            await fsp.writeFile(this.path, payload, 'utf8');
            if (gen === this._writeGen && !this._dirty) {
              this._persisted = true;
            }
          } catch (fallbackErr) {
            console.warn('[Dreamisle] failed to persist config.json', fallbackErr || error);
          }
        }
      }
    })().finally(() => {
      this._writing = null;
      if (this._dirty && !this._flushTimer) {
        this._scheduleFlush();
      }
    });
  }

  flushSync() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (!this._dirty && this._persisted) return;
    this._dirty = false;
    this._writeGen++;
    const payload = this._serialize();
    const tmpPath = `${this.path}.tmp-${process.pid}-${++this._seq}`;
    try {
      fs.mkdirSync(this._dir, { recursive: true });
      fs.writeFileSync(tmpPath, payload, 'utf8');
      try {
        fs.renameSync(tmpPath, this.path);
      } catch {
        fs.writeFileSync(this.path, payload, 'utf8');
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      }
      this._persisted = true;
    } catch (error) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      console.warn('[Dreamisle] failed to flush config.json synchronously', error);
    }
  }
}
