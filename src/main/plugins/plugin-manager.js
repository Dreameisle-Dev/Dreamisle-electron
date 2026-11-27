// 插件管理器（主进程单例）：扫描已安装插件、为每个已启用插件维护独立 utilityProcess、
// 统一管理曲目快照、流解析缓存、封面下载、在线歌词及本地无歌词兜底缓存、以及播放生命周期派发。
import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PluginError,
  formatMediaUrl,
  formatTrackUri,
  parseTrackUri,
  serializePluginError,
  validateTrack,
} from '../../../packages/dreamisle-plugin-sdk/src/index.js';
import { getMainWindow } from '../window.js';
import {
  clearPluginStoredState,
  getLanguage,
  getPluginEnabledIds,
  getPluginStoredConfig,
  setPluginEnabledId,
  setPluginStoredConfig,
} from '../store.js';
import { assertUrlAllowed } from './permissions.js';
import { scopedFetch } from './scoped-fetch.js';
import { createPluginStorage } from './storage.js';
import {
  getPluginsRootDir,
  installPluginFromFolder,
  installPluginFromZip,
  scanInstalledPlugins,
  uninstallPluginFiles,
} from './installer.js';
import { PluginProcess } from './plugin-process.js';

const MAX_TRACK_SNAPSHOTS = 2000;
const MAX_STREAM_CACHE = 200;
const DEFAULT_STREAM_TTL_MS = 15 * 60 * 1000;
const STREAM_REFRESH_MARGIN_MS = 60 * 1000;
const MAX_COVER_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const COVER_DOWNLOAD_TIMEOUT_MS = 10000;
const MAX_COVER_DOWNLOAD_CONCURRENCY = 6;

const installedPlugins = new Map(); // id -> scanned entry
const pluginProcesses = new Map(); // id -> PluginProcess (1 utilityProcess per enabled plugin)
const pluginLifecycleOps = new Map(); // id -> 串行化启停/重启/卸载的互斥链，杜绝并发 fork 风暴
const startingWorkers = new Map(); // id -> 进行中的单飞启动 Promise，并发调用直接复用同一进程
const restartingWorkers = new Map(); // id -> 进行中的单飞重启 Promise，连点或并发重启合并为一次
const pluginStorages = new Map(); // id -> storage adapter
const trackSnapshots = new Map(); // dream-track://... -> PluginTrack
const streamCache = new Map(); // `${pluginId}:${trackId}:${quality}` -> { stream, expiresAt }
const coverCacheInflight = new Map();

let notifyTimer = null;
let lastNotifiedSummaryJson = '';
let disposing = false;

// 按插件 ID 串行化所有生命周期变更（start / stop / restart / install / uninstall）
function runPluginLifecycleOp(pluginId, fn) {
  const prev = pluginLifecycleOps.get(pluginId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  pluginLifecycleOps.set(pluginId, next);
  next.finally(() => {
    if (pluginLifecycleOps.get(pluginId) === next) {
      pluginLifecycleOps.delete(pluginId);
    }
  });
  return next;
}

let coverDownloadActive = 0;
const coverDownloadWaiters = [];

function runWithCoverSlot(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      coverDownloadActive++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          coverDownloadActive--;
          const next = coverDownloadWaiters.shift();
          if (next) next();
        });
    };
    if (coverDownloadActive < MAX_COVER_DOWNLOAD_CONCURRENCY) start();
    else coverDownloadWaiters.push(start);
  });
}

let initialized = false;
let initPluginsPromise = null;
let lyricsCacheDirPromise = null;

function getLyricsCacheDir() {
  if (!lyricsCacheDirPromise) {
    const dir = path.join(app.getPath('userData'), 'lyrics-cache');
    lyricsCacheDirPromise = fs
      .mkdir(dir, { recursive: true })
      .then(() => dir)
      .catch(() => null);
  }
  return lyricsCacheDirPromise;
}

function getStorageFor(pluginId) {
  let st = pluginStorages.get(pluginId);
  if (!st) {
    st = createPluginStorage(pluginId);
    pluginStorages.set(pluginId, st);
  }
  return st;
}

function flushRendererPluginsChanged() {
  notifyTimer = null;
  const win = getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const summaries = listPluginSummaries();
  const json = JSON.stringify(summaries);
  if (json === lastNotifiedSummaryJson) return;
  lastNotifiedSummaryJson = json;
  win.webContents.send('plugins:changed', summaries);
}

function notifyRendererPluginsChanged({ immediate = false } = {}) {
  if (immediate) {
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    flushRendererPluginsChanged();
    return;
  }
  if (notifyTimer) return;
  notifyTimer = setTimeout(flushRendererPluginsChanged, 40);
}

export function notifyRendererStreamError(songUri, err) {
  const win = getMainWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('plugins:stream-error', {
      songUri,
      error: serializePluginError(err),
    });
  }
}

function setTrackSnapshot(songUri, pluginTrack) {
  if (!songUri || !pluginTrack) return;
  trackSnapshots.delete(songUri);
  trackSnapshots.set(songUri, pluginTrack);
  if (trackSnapshots.size > MAX_TRACK_SNAPSHOTS) {
    const oldest = trackSnapshots.keys().next().value;
    trackSnapshots.delete(oldest);
  }
}

export function registerSongSnapshots(songs) {
  if (!Array.isArray(songs)) return;
  for (const song of songs) {
    if (!song || typeof song.path !== 'string') continue;
    const parsed = parseTrackUri(song.path);
    if (!parsed) continue;
    const track = validateTrack({
      id: song.trackId || parsed.trackId,
      title: song.title || parsed.trackId,
      artist: song.artist || 'Unknown',
      album: song.album || null,
      duration: song.duration ?? null,
      trackNo: song.trackNo ?? null,
      discNo: song.discNo ?? null,
      year: song.year ?? null,
      artworkUrl: song.artworkUrl || null,
      extra: song.pluginMeta,
    });
    if (track) setTrackSnapshot(song.path, track);
  }
}

export function toDreamisleSong(pluginId, rawTrack) {
  const track = validateTrack(rawTrack);
  if (!track) return null;
  const uri = formatTrackUri(pluginId, track.id);
  setTrackSnapshot(uri, track);
  return {
    path: uri,
    url: formatMediaUrl(pluginId, track.id),
    title: track.title,
    artist: track.artist,
    album: track.album,
    trackNo: track.trackNo,
    discNo: track.discNo,
    year: track.year,
    duration: track.duration,
    bitrate: null,
    sampleRate: null,
    bitsPerSample: null,
    codec: null,
    source: 'plugin',
    pluginId,
    trackId: track.id,
    artworkUrl: track.artworkUrl,
    pluginMeta: track.extra,
  };
}

function resolveEffectiveConfigSync(manifest) {
  const stored = getPluginStoredConfig(manifest.id);
  const out = {};
  for (const field of manifest.configSchema || []) {
    if (field.secret) continue;
    if (Object.hasOwn(stored, field.key)) out[field.key] = stored[field.key];
    else if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

async function resolveFullConfigForWorker(manifest) {
  const base = resolveEffectiveConfigSync(manifest);
  const storage = getStorageFor(manifest.id);
  for (const field of manifest.configSchema || []) {
    if (!field.secret) continue;
    const val = await storage.getSecret(`__cfg__:${field.key}`);
    if (val !== null) base[field.key] = val;
    else if (field.default !== undefined) base[field.key] = field.default;
  }
  return base;
}

export async function getPluginConfigForUi(pluginId) {
  const entry = installedPlugins.get(pluginId);
  if (!entry?.manifest) return { values: {}, secretSet: {} };
  const values = resolveEffectiveConfigSync(entry.manifest);
  const secretSet = {};
  const storage = getStorageFor(pluginId);
  for (const field of entry.manifest.configSchema || []) {
    if (!field.secret) continue;
    const existing = await storage.getSecret(`__cfg__:${field.key}`);
    secretSet[field.key] = existing !== null && existing.length > 0;
  }
  return { values, secretSet };
}

export async function savePluginConfigFromUi(pluginId, incoming) {
  const entry = installedPlugins.get(pluginId);
  if (!entry?.manifest) throw new Error('Plugin not found');

  const raw = incoming && typeof incoming === 'object' ? incoming : {};
  const plain = getPluginStoredConfig(pluginId);
  const storage = getStorageFor(pluginId);

  for (const field of entry.manifest.configSchema || []) {
    if (!Object.hasOwn(raw, field.key)) continue;
    const val = raw[field.key];
    if (field.secret) {
      if (val === null) {
        await storage.deleteSecret(`__cfg__:${field.key}`);
      } else if (typeof val === 'string' && val.length > 0) {
        await storage.setSecret(`__cfg__:${field.key}`, val);
      }
      continue;
    }

    if (field.type === 'boolean') plain[field.key] = Boolean(val);
    else if (field.type === 'number') {
      const n = Number(val);
      if (Number.isFinite(n)) plain[field.key] = n;
    } else if (typeof val === 'string') {
      plain[field.key] = val;
    }
  }

  setPluginStoredConfig(pluginId, plain);

  // 配置变更可能影响音质/接口地址/代理参数，清理该插件的流缓存
  const prefix = `${pluginId}:`;
  for (const key of streamCache.keys()) {
    if (key.startsWith(prefix)) streamCache.delete(key);
  }

  const proc = pluginProcesses.get(pluginId);
  if (proc && proc.status === 'running') {
    const full = await resolveFullConfigForWorker(entry.manifest);
    proc.pushConfig(full);
  }
  return getPluginConfigForUi(pluginId);
}

async function startPluginWorkerUnlocked(pluginId) {
  if (disposing) {
    throw new PluginError('UNSUPPORTED', 'Application is shutting down');
  }
  const entry = installedPlugins.get(pluginId);
  if (!entry || entry.invalid || !entry.manifest) {
    throw new PluginError('INVALID_CONFIG', `Plugin "${pluginId}" is invalid or not installed`);
  }
  if (!getPluginEnabledIds().includes(pluginId)) {
    throw new PluginError('UNSUPPORTED', `Plugin "${pluginId}" is disabled`);
  }

  const existing = pluginProcesses.get(pluginId);
  if (existing && existing.status === 'running' && existing.child) {
    return existing;
  }
  if (existing) {
    await existing.stop().catch(() => {});
    if (pluginProcesses.get(pluginId) === existing) {
      pluginProcesses.delete(pluginId);
    }
  }

  const initialConfig = await resolveFullConfigForWorker(entry.manifest);
  // 等待配置期间若应用退出或插件被禁用/卸载，直接放弃派生
  if (disposing || !getPluginEnabledIds().includes(pluginId) || !installedPlugins.has(pluginId)) {
    throw new PluginError('UNSUPPORTED', `Plugin "${pluginId}" was disabled`);
  }

  let latestConfig = initialConfig;
  const proc = new PluginProcess({
    manifest: entry.manifest,
    entryPath: entry.entryPath,
    storage: getStorageFor(pluginId),
    getConfig: () => latestConfig,
    getLocale: () => getLanguage(),
    onStatusChange: () => notifyRendererPluginsChanged(),
  });
  const origPush = proc.pushConfig.bind(proc);
  proc.pushConfig = (cfg) => {
    latestConfig = cfg;
    origPush(cfg);
  };

  // 双重保险：确保不会覆盖掉任何仍存活的旧进程实例
  const stale = pluginProcesses.get(pluginId);
  if (stale && stale !== proc) {
    stale.killNow('stopped', null);
  }
  pluginProcesses.set(pluginId, proc);
  await proc.start();
  return proc;
}

function startPluginWorker(pluginId) {
  // 单飞去重：若队尾已有在途启动/重启任务，直接复用同一 Promise，绝不重复 fork
  if (startingWorkers.has(pluginId)) {
    return startingWorkers.get(pluginId);
  }
  const existing = pluginProcesses.get(pluginId);
  if (
    existing &&
    existing.status === 'running' &&
    existing.child &&
    !pluginLifecycleOps.has(pluginId)
  ) {
    return Promise.resolve(existing);
  }

  const job = runPluginLifecycleOp(pluginId, () => startPluginWorkerUnlocked(pluginId)).finally(
    () => {
      if (startingWorkers.get(pluginId) === job) {
        startingWorkers.delete(pluginId);
      }
    }
  );
  startingWorkers.set(pluginId, job);
  return job;
}

async function stopPluginWorkerUnlocked(pluginId) {
  const proc = pluginProcesses.get(pluginId);
  if (proc) {
    await proc.stop().catch(() => {});
    if (pluginProcesses.get(pluginId) === proc) {
      pluginProcesses.delete(pluginId);
    }
  }
  // 清理该插件的流缓存
  const prefix = `${pluginId}:`;
  for (const key of streamCache.keys()) {
    if (key.startsWith(prefix)) streamCache.delete(key);
  }
}

function stopPluginWorker(pluginId) {
  // 新排队的停止操作会使此前在途的启动/重启引用失效，确保后续再启用/重启必须排在本次停止之后
  startingWorkers.delete(pluginId);
  restartingWorkers.delete(pluginId);
  return runPluginLifecycleOp(pluginId, () => stopPluginWorkerUnlocked(pluginId));
}

export async function initPlugins() {
  if (initialized) return;
  if (!initPluginsPromise) {
    initPluginsPromise = refreshInstalledPlugins({ startEnabled: true })
      .then(() => {
        initialized = true;
      })
      .finally(() => {
        initPluginsPromise = null;
      });
  }
  await initPluginsPromise;
}

export async function refreshInstalledPlugins({ startEnabled = false } = {}) {
  const scanned = await scanInstalledPlugins();
  installedPlugins.clear();
  for (const item of scanned) {
    installedPlugins.set(item.id, item);
  }

  if (startEnabled) {
    const enabledSet = new Set(getPluginEnabledIds());
    await Promise.all(
      [...installedPlugins.values()]
        .filter((p) => !p.invalid && enabledSet.has(p.id))
        .map((p) => startPluginWorker(p.id).catch(() => {}))
    );
  }

  notifyRendererPluginsChanged({ immediate: true });
  return listPluginSummaries();
}

export function listPluginSummaries() {
  const enabledSet = new Set(getPluginEnabledIds());
  return [...installedPlugins.values()].map((entry) => {
    const proc = pluginProcesses.get(entry.id);
    const enabled = !entry.invalid && enabledSet.has(entry.id);
    return {
      id: entry.id,
      dir: entry.dir,
      invalid: entry.invalid,
      errors: entry.errors || [],
      manifest: entry.manifest,
      enabled,
      status: entry.invalid ? 'invalid' : proc ? proc.status : 'stopped',
      lastError: entry.invalid ? (entry.errors || []).join('；') : proc?.lastError || null,
      authMeta: proc?.authMeta || {
        supported: Boolean(entry.manifest?.capabilities?.includes('auth')),
      },
    };
  });
}

export function getPluginEntry(pluginId) {
  return installedPlugins.get(pluginId) || null;
}

export function getRunningProcess(pluginId) {
  const proc = pluginProcesses.get(pluginId);
  return proc && proc.status === 'running' ? proc : null;
}

export function isPluginEnabledAndInstalled(pluginId) {
  const entry = installedPlugins.get(pluginId);
  if (!entry || entry.invalid) return false;
  return getPluginEnabledIds().includes(pluginId);
}

export async function setPluginEnabled(pluginId, enabled) {
  const entry = installedPlugins.get(pluginId);
  if (!entry || entry.invalid) {
    throw new Error(`插件不可用：${pluginId}`);
  }
  if (enabled) {
    const job = runPluginLifecycleOp(pluginId, async () => {
      setPluginEnabledId(pluginId, true);
      return startPluginWorkerUnlocked(pluginId);
    }).finally(() => {
      if (startingWorkers.get(pluginId) === job) {
        startingWorkers.delete(pluginId);
      }
    });
    startingWorkers.set(pluginId, job);
    await job;
  } else {
    startingWorkers.delete(pluginId);
    restartingWorkers.delete(pluginId);
    await runPluginLifecycleOp(pluginId, async () => {
      setPluginEnabledId(pluginId, false);
      await stopPluginWorkerUnlocked(pluginId);
    });
  }
  notifyRendererPluginsChanged({ immediate: true });
  return listPluginSummaries();
}

export async function restartPlugin(pluginId) {
  const entry = installedPlugins.get(pluginId);
  if (!entry || entry.invalid) throw new Error(`插件不可用：${pluginId}`);

  // 合并并发重启请求：同一插件正在重启时直接复用在途任务，不再排队重复启停
  if (restartingWorkers.has(pluginId)) {
    await restartingWorkers.get(pluginId);
    return listPluginSummaries();
  }

  const job = runPluginLifecycleOp(pluginId, async () => {
    await stopPluginWorkerUnlocked(pluginId);
    setPluginEnabledId(pluginId, true);
    return startPluginWorkerUnlocked(pluginId);
  }).finally(() => {
    if (startingWorkers.get(pluginId) === job) {
      startingWorkers.delete(pluginId);
    }
    if (restartingWorkers.get(pluginId) === job) {
      restartingWorkers.delete(pluginId);
    }
  });
  startingWorkers.set(pluginId, job);
  restartingWorkers.set(pluginId, job);
  await job;
  notifyRendererPluginsChanged({ immediate: true });
  return listPluginSummaries();
}

export async function installPluginFolder(folderPath) {
  const installed = await installPluginFromFolder(folderPath);
  const wasEnabled = getPluginEnabledIds().includes(installed.id);
  await stopPluginWorker(installed.id);
  await refreshInstalledPlugins({ startEnabled: false });
  // 新安装默认启用；覆盖升级保持原先启停状态
  if (wasEnabled || !getPluginEnabledIds().includes(installed.id)) {
    setPluginEnabledId(installed.id, true);
    await startPluginWorker(installed.id).catch(() => {});
  }
  notifyRendererPluginsChanged({ immediate: true });
  return { installed: installed.manifest, plugins: listPluginSummaries() };
}

export async function installPluginZip(zipPath) {
  const installed = await installPluginFromZip(zipPath);
  await stopPluginWorker(installed.id);
  await refreshInstalledPlugins({ startEnabled: false });
  setPluginEnabledId(installed.id, true);
  await startPluginWorker(installed.id).catch(() => {});
  notifyRendererPluginsChanged({ immediate: true });
  return { installed: installed.manifest, plugins: listPluginSummaries() };
}

export async function uninstallPlugin(pluginId) {
  await stopPluginWorker(pluginId);
  pluginStorages.delete(pluginId);
  clearPluginStoredState(pluginId);
  await uninstallPluginFiles(pluginId, { clearData: true });
  await refreshInstalledPlugins({ startEnabled: false });
  return listPluginSummaries();
}

export function getPluginLogs(pluginId) {
  const proc = pluginProcesses.get(pluginId);
  return proc ? [...proc.logs] : [];
}

export function pushLocaleToPlugins(locale) {
  for (const proc of pluginProcesses.values()) {
    proc.pushLocale(locale);
  }
}

// ── 音源与元数据调度 ──

async function requireRunningPlugin(pluginId, capability = null) {
  if (!initialized) {
    await initPlugins().catch(() => {});
  }
  const entry = installedPlugins.get(pluginId);
  if (!entry || entry.invalid) {
    throw new PluginError('NOT_FOUND', `插件 "${pluginId}" 未安装`);
  }
  if (!getPluginEnabledIds().includes(pluginId)) {
    throw new PluginError('UNSUPPORTED', `插件 "${entry.manifest.name}" 未启用`);
  }
  if (capability && !entry.manifest.capabilities.includes(capability)) {
    throw new PluginError('UNSUPPORTED', `插件 "${entry.manifest.name}" 不支持 ${capability}`);
  }
  // 若该插件正处于启动/重启中，直接复用同一单飞 Promise，不向正在停机的旧进程发 RPC，也不二次派生
  if (startingWorkers.has(pluginId)) {
    const proc = await startingWorkers.get(pluginId);
    return { entry, proc };
  }
  let proc = pluginProcesses.get(pluginId);
  if (proc && proc.status === 'running' && proc.child && !pluginLifecycleOps.has(pluginId)) {
    return { entry, proc };
  }
  // 已崩溃的插件不因后台封面/账号探测自动循环重启，需用户显式点击「重启」
  if (proc && proc.status === 'crashed') {
    throw new PluginError(
      'INTERNAL_ERROR',
      proc.lastError || `插件 "${entry.manifest.name}" 已崩溃`
    );
  }
  proc = await startPluginWorker(pluginId);
  return { entry, proc };
}

export async function resolvePluginStream(
  pluginId,
  trackId,
  { quality, forceRefresh = false } = {}
) {
  const targetQuality = quality || 'lossless';
  const cacheKey = `${pluginId}:${trackId}:${quality || 'default'}`;
  const now = Date.now();

  if (!forceRefresh && streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    if (cached.expiresAt - STREAM_REFRESH_MARGIN_MS > now) {
      streamCache.delete(cacheKey);
      streamCache.set(cacheKey, cached);
      return cached;
    }
    streamCache.delete(cacheKey);
  }

  const { entry, proc } = await requireRunningPlugin(pluginId, 'music-source');
  const uri = formatTrackUri(pluginId, trackId);
  const track = trackSnapshots.get(uri) || { id: trackId, title: trackId, artist: 'Unknown' };
  const stream = await proc.invoke(
    'source.resolveStream',
    { track, quality: targetQuality },
    { timeoutMs: 12000 }
  );

  // 校验返回的音频流 URL 同样符合插件网络权限与防 SSRF 约束
  assertUrlAllowed(stream.url, entry.manifest.permissions);

  const expiresAt = stream.expiresAt || now + DEFAULT_STREAM_TTL_MS;
  const record = { stream, permissions: entry.manifest.permissions, expiresAt };
  streamCache.delete(cacheKey);
  streamCache.set(cacheKey, record);
  if (streamCache.size > MAX_STREAM_CACHE) {
    const oldest = streamCache.keys().next().value;
    streamCache.delete(oldest);
  }
  return record;
}

export function invalidatePluginStream(pluginId, trackId, quality) {
  streamCache.delete(`${pluginId}:${trackId}:${quality || 'default'}`);
}

async function downloadCoverWithRetry(url, permissions, headers = undefined) {
  return runWithCoverSlot(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await scopedFetch(url, permissions, {
          headers,
          timeoutMs: COVER_DOWNLOAD_TIMEOUT_MS,
        });
        if (!res.ok) {
          if (attempt === 0 && res.status >= 500) continue;
          return null;
        }
        const ab = await res.arrayBuffer();
        if (!ab.byteLength || ab.byteLength > MAX_COVER_DOWNLOAD_BYTES) return null;
        return {
          buffer: Buffer.from(ab),
          format: res.headers.get('content-type') || 'image/jpeg',
        };
      } catch {
        if (attempt === 0) continue;
        return null;
      }
    }
    return null;
  });
}

export async function fetchPluginCoverBuffer(songUri) {
  const parsed = parseTrackUri(songUri);
  if (!parsed) return null;

  if (coverCacheInflight.has(songUri)) return coverCacheInflight.get(songUri);

  const job = (async () => {
    try {
      const { entry, proc } = await requireRunningPlugin(parsed.pluginId, 'music-source');
      const track = trackSnapshots.get(songUri) || {
        id: parsed.trackId,
        title: parsed.trackId,
        artist: 'Unknown',
      };

      let coverSource = null;
      try {
        coverSource = await proc.invoke('source.getCover', { track }, { timeoutMs: 8000 });
      } catch {}
      if (!coverSource && track.artworkUrl) {
        coverSource = { url: track.artworkUrl };
      }
      if (!coverSource?.url) return null;

      return await downloadCoverWithRetry(
        coverSource.url,
        entry.manifest.permissions,
        coverSource.headers
      );
    } catch {
      return null;
    } finally {
      coverCacheInflight.delete(songUri);
    }
  })();

  coverCacheInflight.set(songUri, job);
  return job;
}

export async function fetchPluginArtworkBuffer(pluginId, artworkUrl) {
  if (typeof pluginId !== 'string' || typeof artworkUrl !== 'string' || !artworkUrl) return null;
  const inflightKey = `art|${pluginId}|${artworkUrl}`;
  if (coverCacheInflight.has(inflightKey)) return coverCacheInflight.get(inflightKey);

  const job = (async () => {
    try {
      if (!initialized) await initPlugins().catch(() => {});
      const entry = installedPlugins.get(pluginId);
      if (!entry || entry.invalid || !getPluginEnabledIds().includes(pluginId)) return null;
      return await downloadCoverWithRetry(artworkUrl, entry.manifest.permissions);
    } catch {
      return null;
    } finally {
      coverCacheInflight.delete(inflightKey);
    }
  })();

  coverCacheInflight.set(inflightKey, job);
  return job;
}

export function hasEnabledMusicSourcePlugin() {
  for (const pluginId of getPluginEnabledIds()) {
    const entry = installedPlugins.get(pluginId);
    if (!entry || entry.invalid || !entry.manifest.capabilities.includes('music-source')) continue;
    if (getRunningProcess(pluginId)) return true;
  }
  return false;
}

// 本地无内嵌封面曲目兜底：向已启用的 music-source 插件询问 source.matchCover（是否启用由插件自身配置控制）
export async function matchOnlineCoverForLocalTrack(songMeta) {
  if (!songMeta?.title) return null;
  if (!initialized) await initPlugins().catch(() => {});

  const query = {
    title: songMeta.title,
    artist: songMeta.artist || '',
    album: songMeta.album || null,
    duration: songMeta.duration ?? null,
  };

  for (const pluginId of getPluginEnabledIds()) {
    const entry = installedPlugins.get(pluginId);
    if (!entry || entry.invalid || !entry.manifest.capabilities.includes('music-source')) continue;
    const proc = getRunningProcess(pluginId);
    if (!proc) continue;
    try {
      const coverSource = await proc.invoke('source.matchCover', { query }, { timeoutMs: 6000 });
      if (!coverSource?.url) continue;
      const downloaded = await downloadCoverWithRetry(
        coverSource.url,
        entry.manifest.permissions,
        coverSource.headers
      );
      if (downloaded?.buffer) return downloaded;
    } catch {}
  }

  return null;
}

export async function fetchPluginLyrics(songUri) {
  const parsed = parseTrackUri(songUri);
  if (!parsed) return null;
  try {
    const { proc } = await requireRunningPlugin(parsed.pluginId);
    const track = trackSnapshots.get(songUri) || {
      id: parsed.trackId,
      title: parsed.trackId,
      artist: 'Unknown',
    };
    const payload = await proc.invoke('lyrics.getLyrics', { track }, { timeoutMs: 7000 });
    return payload ? { pluginLyrics: true, ...payload } : null;
  } catch {
    return null;
  }
}

// 本地无歌词曲目在线兜底：仅当存在已启用且运行中的 lyrics-provider 插件时才触发，
// 具体是否参与本地匹配由各插件自身配置控制，命中结果落盘缓存以供离线复用。
export async function matchOnlineLyricsForLocalTrack(songMeta) {
  if (!songMeta?.title) return null;

  const providers = [];
  for (const pluginId of getPluginEnabledIds()) {
    const entry = installedPlugins.get(pluginId);
    if (!entry || entry.invalid || !entry.manifest.capabilities.includes('lyrics-provider')) {
      continue;
    }
    const proc = getRunningProcess(pluginId);
    if (proc) providers.push(proc);
  }
  if (providers.length === 0) return null;

  const cacheKeyHash = crypto
    .createHash('sha1')
    .update(
      `${songMeta.title}|${songMeta.artist || ''}|${songMeta.album || ''}|${songMeta.duration || ''}`
    )
    .digest('hex');

  const cacheDir = await getLyricsCacheDir();
  const cacheFile = cacheDir ? path.join(cacheDir, `${cacheKeyHash}.json`) : null;
  if (cacheFile) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (cached && typeof cached === 'object') {
        return { pluginLyrics: true, ...cached };
      }
    } catch {}
  }

  for (const proc of providers) {
    try {
      const payload = await proc.invoke(
        'lyrics.matchLyrics',
        {
          query: {
            title: songMeta.title,
            artist: songMeta.artist || '',
            album: songMeta.album || null,
            duration: songMeta.duration ?? null,
          },
        },
        { timeoutMs: 5000 }
      );
      if (payload) {
        if (cacheFile) {
          fs.writeFile(cacheFile, JSON.stringify(payload), 'utf8').catch(() => {});
        }
        return { pluginLyrics: true, ...payload };
      }
    } catch {}
  }

  return null;
}

// ── 探索 / 搜索 / 歌单 / 账号 API ──

export async function searchPluginSource(
  pluginId,
  { type = 'tracks', query = '', page = 1, pageSize = 30 }
) {
  const { proc } = await requireRunningPlugin(pluginId, 'music-source');
  const method =
    type === 'albums'
      ? 'source.searchAlbums'
      : type === 'playlists'
        ? 'source.searchPlaylists'
        : 'source.searchTracks';
  const res = await proc.invoke(method, { query, page, pageSize }, { timeoutMs: 9000 });
  if (type === 'tracks') {
    return {
      ...res,
      items: (res.items || []).map((t) => toDreamisleSong(pluginId, t)).filter(Boolean),
    };
  }
  return res;
}

export async function getPluginHome(pluginId) {
  const { proc } = await requireRunningPlugin(pluginId, 'music-source');
  const sections = await proc.invoke('source.getHomeSections', {}, { timeoutMs: 9000 });
  return (sections || []).map((sec) => ({
    ...sec,
    items:
      sec.kind === 'tracks'
        ? (sec.items || []).map((t) => toDreamisleSong(pluginId, t)).filter(Boolean)
        : sec.items || [],
  }));
}

export async function getPluginUserPlaylists(pluginId) {
  const { proc } = await requireRunningPlugin(pluginId, 'music-source');
  return proc.invoke('source.getUserPlaylists', {}, { timeoutMs: 9000 });
}

export async function getPluginUserAlbums(pluginId) {
  const { proc } = await requireRunningPlugin(pluginId, 'music-source');
  return proc.invoke('source.getUserAlbums', {}, { timeoutMs: 9000 });
}

export async function getPluginAlbumTracks(pluginId, albumId) {
  const { proc } = await requireRunningPlugin(pluginId, 'music-source');
  const res = await proc.invoke('source.getAlbumTracks', { albumId }, { timeoutMs: 9000 });
  return {
    album: res.album,
    tracks: (res.tracks || []).map((t) => toDreamisleSong(pluginId, t)).filter(Boolean),
  };
}

export async function getPluginPlaylistTracks(pluginId, playlistId, page = 1, pageSize = 50) {
  const { proc } = await requireRunningPlugin(pluginId, 'music-source');
  const res = await proc.invoke(
    'source.getPlaylistTracks',
    { playlistId, page, pageSize },
    { timeoutMs: 9000 }
  );
  return {
    playlist: res.playlist,
    tracks: {
      ...res.tracks,
      items: (res.tracks?.items || []).map((t) => toDreamisleSong(pluginId, t)).filter(Boolean),
    },
  };
}

export async function pluginAuthGetAccount(pluginId) {
  const { proc } = await requireRunningPlugin(pluginId, 'auth');
  return proc.invoke('auth.getAccount', {}, { timeoutMs: 8000 });
}

export async function pluginAuthLogout(pluginId) {
  const { proc } = await requireRunningPlugin(pluginId, 'auth');
  return proc.invoke('auth.logout', {}, { timeoutMs: 8000 });
}

export async function pluginAuthQrStart(pluginId) {
  const { proc } = await requireRunningPlugin(pluginId, 'auth');
  return proc.invoke('auth.qrStart', {}, { timeoutMs: 10000 });
}

export async function pluginAuthQrPoll(pluginId, key) {
  const { proc } = await requireRunningPlugin(pluginId, 'auth');
  return proc.invoke('auth.qrPoll', { key }, { timeoutMs: 8000 });
}

export async function pluginAuthFormSubmit(pluginId, values) {
  const { proc } = await requireRunningPlugin(pluginId, 'auth');
  return proc.invoke('auth.formSubmit', { values }, { timeoutMs: 10000 });
}

// ── 播放生命周期钩子派发（非阻塞、单插件 3s 超时、静默容错） ──

function dispatchLifecycle(method, payload) {
  for (const [pluginId, proc] of pluginProcesses) {
    const entry = installedPlugins.get(pluginId);
    if (!entry || entry.invalid || proc.status !== 'running') continue;
    if (!entry.manifest.capabilities.includes('lifecycle')) continue;
    proc.invoke(method, payload, { timeoutMs: 3000 }).catch(() => {});
  }
}

export function emitLifecycleTrackChange(track) {
  dispatchLifecycle('lifecycle.onTrackChange', { track: track || null });
}

export function emitLifecyclePlaybackState(statePayload) {
  dispatchLifecycle('lifecycle.onPlaybackState', statePayload);
}

export function emitLifecycleTrackComplete(payload) {
  dispatchLifecycle('lifecycle.onTrackComplete', payload);
}

export async function disposePlugins() {
  disposing = true;
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  const ids = new Set([
    ...pluginProcesses.keys(),
    ...startingWorkers.keys(),
    ...restartingWorkers.keys(),
    ...pluginLifecycleOps.keys(),
  ]);
  const stops = [];
  for (const pluginId of ids) {
    stops.push(stopPluginWorker(pluginId));
  }
  await Promise.allSettled(stops);
  streamCache.clear();
  trackSnapshots.clear();
}
