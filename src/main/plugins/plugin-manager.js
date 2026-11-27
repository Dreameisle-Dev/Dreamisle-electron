// 插件管理器（主进程单例）：扫描已安装插件、为每个已启用插件维护独立 utilityProcess、
// 统一管理曲目快照、流解析缓存、封面下载、在线歌词及本地无歌词兜底缓存、以及播放生命周期派发。
import { app, net } from 'electron';
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

const installedPlugins = new Map(); // id -> scanned entry
const pluginProcesses = new Map(); // id -> PluginProcess (1 utilityProcess per enabled plugin)
const pluginStorages = new Map(); // id -> storage adapter
const trackSnapshots = new Map(); // dream-track://... -> PluginTrack
const streamCache = new Map(); // `${pluginId}:${trackId}:${quality}` -> { stream, expiresAt }
const coverCacheInflight = new Map();

let initialized = false;
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

function notifyRendererPluginsChanged() {
  const win = getMainWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('plugins:changed', listPluginSummaries());
  }
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

async function startPluginWorker(pluginId) {
  const entry = installedPlugins.get(pluginId);
  if (!entry || entry.invalid || !entry.manifest) {
    throw new PluginError('INVALID_CONFIG', `Plugin "${pluginId}" is invalid or not installed`);
  }

  let proc = pluginProcesses.get(pluginId);
  if (proc && proc.status === 'running') return proc;
  if (proc) {
    await proc.stop().catch(() => {});
  }

  const initialConfig = await resolveFullConfigForWorker(entry.manifest);
  let latestConfig = initialConfig;

  proc = new PluginProcess({
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

  pluginProcesses.set(pluginId, proc);
  await proc.start();
  return proc;
}

async function stopPluginWorker(pluginId) {
  const proc = pluginProcesses.get(pluginId);
  if (!proc) return;
  await proc.stop().catch(() => {});
  pluginProcesses.delete(pluginId);
  // 清理该插件的流缓存
  const prefix = `${pluginId}:`;
  for (const key of streamCache.keys()) {
    if (key.startsWith(prefix)) streamCache.delete(key);
  }
}

export async function initPlugins() {
  if (initialized) return;
  initialized = true;
  await refreshInstalledPlugins({ startEnabled: true });
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

  notifyRendererPluginsChanged();
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
  setPluginEnabledId(pluginId, enabled);
  if (enabled) {
    await startPluginWorker(pluginId);
  } else {
    await stopPluginWorker(pluginId);
  }
  notifyRendererPluginsChanged();
  return listPluginSummaries();
}

export async function restartPlugin(pluginId) {
  const entry = installedPlugins.get(pluginId);
  if (!entry || entry.invalid) throw new Error(`插件不可用：${pluginId}`);
  await stopPluginWorker(pluginId);
  setPluginEnabledId(pluginId, true);
  await startPluginWorker(pluginId);
  notifyRendererPluginsChanged();
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
  notifyRendererPluginsChanged();
  return { installed: installed.manifest, plugins: listPluginSummaries() };
}

export async function installPluginZip(zipPath) {
  const installed = await installPluginFromZip(zipPath);
  await stopPluginWorker(installed.id);
  await refreshInstalledPlugins({ startEnabled: false });
  setPluginEnabledId(installed.id, true);
  await startPluginWorker(installed.id).catch(() => {});
  notifyRendererPluginsChanged();
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
  let proc = pluginProcesses.get(pluginId);
  if (!proc || proc.status !== 'running') {
    proc = await startPluginWorker(pluginId);
  }
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
        coverSource = await proc.invoke('source.getCover', { track }, { timeoutMs: 6000 });
      } catch {}
      if (!coverSource && track.artworkUrl) {
        coverSource = { url: track.artworkUrl };
      }
      if (!coverSource?.url) return null;

      assertUrlAllowed(coverSource.url, entry.manifest.permissions);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), COVER_DOWNLOAD_TIMEOUT_MS);
      try {
        const res = await net.fetch(coverSource.url, {
          headers: coverSource.headers,
          signal: ac.signal,
        });
        if (!res.ok) return null;
        if (res.url && res.url !== coverSource.url) {
          assertUrlAllowed(res.url, entry.manifest.permissions);
        }
        const ab = await res.arrayBuffer();
        if (!ab.byteLength || ab.byteLength > MAX_COVER_DOWNLOAD_BYTES) return null;
        return {
          buffer: Buffer.from(ab),
          format: res.headers.get('content-type') || 'image/jpeg',
        };
      } finally {
        clearTimeout(timer);
      }
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
      const entry = installedPlugins.get(pluginId);
      if (!entry || entry.invalid || !getPluginEnabledIds().includes(pluginId)) return null;
      assertUrlAllowed(artworkUrl, entry.manifest.permissions);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), COVER_DOWNLOAD_TIMEOUT_MS);
      try {
        const res = await net.fetch(artworkUrl, { signal: ac.signal });
        if (!res.ok) return null;
        if (res.url && res.url !== artworkUrl) {
          assertUrlAllowed(res.url, entry.manifest.permissions);
        }
        const ab = await res.arrayBuffer();
        if (!ab.byteLength || ab.byteLength > MAX_COVER_DOWNLOAD_BYTES) return null;
        return {
          buffer: Buffer.from(ab),
          format: res.headers.get('content-type') || 'image/jpeg',
        };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    } finally {
      coverCacheInflight.delete(inflightKey);
    }
  })();

  coverCacheInflight.set(inflightKey, job);
  return job;
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
  const stops = [];
  for (const pluginId of [...pluginProcesses.keys()]) {
    stops.push(stopPluginWorker(pluginId));
  }
  await Promise.allSettled(stops);
  streamCache.clear();
  trackSnapshots.clear();
}
