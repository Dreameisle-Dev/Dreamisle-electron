// 按 pluginId 强隔离的持久化 KV 存储与系统级加密凭据存储（Electron safeStorage）。
// 普通数据落盘 userData/plugin-data/<pluginId>/storage.json；
// 敏感凭据（Cookie / Token）落盘 secrets.enc.json，Windows 走 DPAPI、macOS 走 Keychain。
import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isValidPluginId } from '../../../packages/dreamisle-plugin-sdk/src/index.js';

const MAX_STORAGE_KEYS = 500;
const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
const MAX_SECRET_KEYS = 64;
const MAX_SECRET_LEN = 32 * 1024;

function getPluginDataRoot() {
  return path.join(app.getPath('userData'), 'plugin-data');
}

function getPluginDataDir(pluginId) {
  if (!isValidPluginId(pluginId)) throw new Error(`Invalid pluginId: ${pluginId}`);
  return path.join(getPluginDataRoot(), pluginId);
}

async function readJsonSafe(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

export function createPluginStorage(pluginId) {
  const dir = getPluginDataDir(pluginId);
  const storageFile = path.join(dir, 'storage.json');
  const secretsFile = path.join(dir, 'secrets.enc.json');

  let kvCache = null;
  let kvWriteChain = Promise.resolve();
  let secretsCache = null;
  let secretsWriteChain = Promise.resolve();

  async function ensureKv() {
    if (!kvCache) kvCache = await readJsonSafe(storageFile, {});
    return kvCache;
  }

  async function persistKv() {
    const snapshot = { ...(kvCache || {}) };
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORAGE_BYTES) {
      throw new Error('Plugin storage size limit exceeded (2MB)');
    }
    kvWriteChain = kvWriteChain.then(() => writeJsonAtomic(storageFile, snapshot)).catch(() => {});
    return kvWriteChain;
  }

  async function ensureSecrets() {
    if (!secretsCache) secretsCache = await readJsonSafe(secretsFile, {});
    return secretsCache;
  }

  async function persistSecrets() {
    const snapshot = { ...(secretsCache || {}) };
    secretsWriteChain = secretsWriteChain
      .then(() => writeJsonAtomic(secretsFile, snapshot))
      .catch(() => {});
    return secretsWriteChain;
  }

  return {
    async get(key) {
      if (typeof key !== 'string' || !key || key.length > 256) return undefined;
      const kv = await ensureKv();
      return Object.hasOwn(kv, key) ? kv[key] : undefined;
    },
    async set(key, value) {
      if (typeof key !== 'string' || !key || key.length > 256) {
        throw new Error('Invalid storage key');
      }
      const kv = await ensureKv();
      if (!Object.hasOwn(kv, key) && Object.keys(kv).length >= MAX_STORAGE_KEYS) {
        throw new Error('Plugin storage key limit exceeded');
      }
      kv[key] = value;
      await persistKv();
    },
    async delete(key) {
      if (typeof key !== 'string' || !key) return;
      const kv = await ensureKv();
      if (Object.hasOwn(kv, key)) {
        delete kv[key];
        await persistKv();
      }
    },
    async clear() {
      kvCache = {};
      await persistKv();
    },

    async getSecret(key) {
      if (typeof key !== 'string' || !key || key.length > 128) return null;
      const map = await ensureSecrets();
      if (!Object.hasOwn(map, key)) return null;
      const entry = map[key];
      if (!entry || typeof entry !== 'object') return null;
      try {
        if (entry.enc === true) {
          if (!safeStorage.isEncryptionAvailable()) return null;
          return safeStorage.decryptString(Buffer.from(entry.data, 'base64'));
        }
        return typeof entry.data === 'string' ? entry.data : null;
      } catch {
        return null;
      }
    },
    async setSecret(key, value) {
      if (typeof key !== 'string' || !key || key.length > 128) {
        throw new Error('Invalid secret key');
      }
      if (typeof value !== 'string' || value.length > MAX_SECRET_LEN) {
        throw new Error('Invalid secret value');
      }
      const map = await ensureSecrets();
      if (!Object.hasOwn(map, key) && Object.keys(map).length >= MAX_SECRET_KEYS) {
        throw new Error('Plugin secret key limit exceeded');
      }
      if (safeStorage.isEncryptionAvailable()) {
        map[key] = {
          enc: true,
          data: safeStorage.encryptString(value).toString('base64'),
        };
      } else {
        map[key] = { enc: false, data: value };
      }
      await persistSecrets();
    },
    async deleteSecret(key) {
      if (typeof key !== 'string' || !key) return;
      const map = await ensureSecrets();
      if (Object.hasOwn(map, key)) {
        delete map[key];
        await persistSecrets();
      }
    },
  };
}

export async function deletePluginData(pluginId) {
  if (!isValidPluginId(pluginId)) return;
  const dir = getPluginDataDir(pluginId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
