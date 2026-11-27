import { app, dialog, nativeTheme } from 'electron';
import fs from 'fs/promises';
import {
  store,
  getMusicFolders,
  getLanguage,
  getLyricsStyle,
  setLyricsStyleSetting,
  getLyricsTranslation,
  setLyricsTranslation,
  getDesktopLyricsClickThrough,
  setDesktopLyricsClickThrough,
  getDesktopLyricsLines,
  setDesktopLyricsLines,
  getThemeMode,
  setThemeMode,
  getPerformanceMode,
  setPerformanceMode,
  getEqualizer,
  setEqualizer,
  getTaskbarLyricsStyle,
  setTaskbarLyricsStyle,
  getTaskbarLyricsSetting,
  getMenubarLyricsSetting,
  getPlayQueue,
  setPlayQueue,
  applyLanguage,
} from './store.js';
import {
  handleMainIpc,
  onMainIpc,
  isAllowedAudioPathSync,
  isAllowedSongIdSync,
} from './security.js';
import { pushLocaleToPlugins } from './plugins/plugin-manager.js';
import {
  parseAudioFile,
  scanAllFolders,
  collectDiskPaths,
  readCover,
  readCoverThumbnail,
  readLyrics,
  diffPlaylistPaths,
  applySyncToPlaylist,
  hasLegacyMetadata,
} from './music-library.js';
import { toggleMiniMode, minimizeWindow, maximizeWindow, closeWindow } from './window.js';
import { rebuildTrayMenu } from './tray.js';
import {
  setLyricsContent,
  setDesktopLyricsPlayback,
  setLyricsStyle,
  setLyricsLang,
  setLyricsClickThrough,
  setLyricsLines,
  refreshLyricsStyle,
  isLyricsWindowVisible,
  toggleDesktopLyrics,
} from '../lyrics/lyrics-window.js';
import {
  updateTaskbarLyricsDocument,
  updateTaskbarLyricsPlayback,
  updateTaskbarLyricsStyle,
  updateTaskbarLyricsTranslation,
  refreshTaskbarLyricsConfig,
  isTaskbarLyricsRunning,
  setTaskbarLyricsEnabled,
} from '../taskbar/taskbar-lyrics.js';
import {
  updateMenubarLyricsText,
  updateMenubarLyricsDocument,
  setMenubarLyricsEnabled,
} from '../menubar/menubar-lyrics.js';
import { emptyStats, recordPlay, pruneStats } from '../shared/stats.js';
import { loadPlaylists, refreshPlaylistsMetadata } from './playlists.js';

// 手动导入时递增，使进行中的自动同步结果作废
let syncGeneration = 0;

// 启动预热句柄：在渲染进程解析 HTML/CSS/ESM 期间异步预读上次曲目的封面与歌词，
// 让 app:bootstrap 可以直接带回结果；若冷缓存耗时较长则不阻塞首屏，后续常规 IPC 无缝复用在途任务。
let startupPrefetch = null;

export function startStartupPrefetch() {
  const playbackState = store.get('playbackState');
  const songPath = playbackState?.currentSongPath;
  const folders = getMusicFolders();
  if (typeof songPath !== 'string' || !songPath || folders.length === 0) return;
  if (!isAllowedAudioPathSync(songPath, folders)) return;

  const coverPromise = readCover(songPath, folders).catch(() => null);
  const lyricsPromise = readLyrics(songPath, folders).catch(() => null);
  startupPrefetch = { songPath, coverPromise, lyricsPromise };
}

function raceWithinMs(promise, ms) {
  const sentinel = Symbol('timeout');
  return Promise.race([
    promise.then((value) => ({ done: true, value })),
    new Promise((resolve) => setTimeout(() => resolve({ done: false, value: sentinel }), ms)),
  ]);
}

async function buildSettingsSnapshot({ checkFolders = true } = {}) {
  const rawFolders = getMusicFolders();
  const folders = checkFolders
    ? await Promise.all(
        rawFolders.map(async (p) => {
          let available = false;
          try {
            await fs.access(p);
            available = true;
          } catch (e) {}
          return { path: p, available };
        })
      )
    : rawFolders.map((p) => ({ path: p, available: true }));

  return {
    language: getLanguage(),
    lyricsStyle: getLyricsStyle(),
    lyricsTranslation: getLyricsTranslation(),
    desktopLyricsClickThrough: getDesktopLyricsClickThrough(),
    desktopLyricsLines: getDesktopLyricsLines(),
    desktopLyricsVisible: isLyricsWindowVisible(),
    taskbarLyricsEnabled: getTaskbarLyricsSetting(),
    taskbarLyricsRunning: isTaskbarLyricsRunning(),
    menubarLyricsEnabled: getMenubarLyricsSetting(),
    themeMode: getThemeMode(),
    performanceMode: getPerformanceMode(),
    equalizer: getEqualizer(),
    taskbarLyricsStyle: getTaskbarLyricsStyle(),
    musicFolders: folders,
  };
}

async function loadSavedMusicList() {
  // 优先从本地 Store 获取已缓存的列表;旧版缓存(缺音质规格字段)需重扫迁移一次
  const cached = store.get('cachedPlaylist');
  if (cached && cached.length > 0 && !hasLegacyMetadata(cached)) {
    refreshPlaylistsMetadata(); // 歌单快照可能仍是旧数据(曲库已迁移),启动时尝试回填
    return cached;
  }

  const folders = getMusicFolders();
  if (folders.length === 0) return cached || [];
  try {
    const playlist = await scanAllFolders(folders);
    store.set('cachedPlaylist', playlist);
    refreshPlaylistsMetadata(); // 曲库迁移后同步回填歌单快照
    return playlist;
  } catch (e) {
    return cached || [];
  }
}

// 统计中清理已不在音乐库中的歌曲记录
function pruneStatsForLibrary(validPaths) {
  const raw = store.get('stats');
  if (!raw || !raw.plays) return;
  store.set('stats', pruneStats(raw, new Set(validPaths)));
}

function normalizePlaybackState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const currentIndex =
    Number.isInteger(raw.currentIndex) && raw.currentIndex >= -1 ? raw.currentIndex : -1;
  const currentSongPath =
    typeof raw.currentSongPath === 'string' &&
    isAllowedSongIdSync(raw.currentSongPath, getMusicFolders())
      ? raw.currentSongPath
      : null;
  const currentTime =
    typeof raw.currentTime === 'number' && Number.isFinite(raw.currentTime) && raw.currentTime >= 0
      ? raw.currentTime
      : 0;
  const volume =
    typeof raw.volume === 'number' && Number.isFinite(raw.volume)
      ? Math.min(1, Math.max(0, raw.volume))
      : 1;
  const playMode = raw.playMode === 1 || raw.playMode === 2 ? raw.playMode : 0;
  return {
    currentIndex,
    currentSongPath,
    currentTime,
    volume,
    playMode,
    isPlaying: raw.isPlaying === true,
  };
}

// 注册全部渲染进程 ↔ 主进程 IPC 通道；频道名与 preload API 一一对应
export function registerIpcHandlers() {
  handleMainIpc('folders:add', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (canceled) return { playlist: store.get('cachedPlaylist') || [], duplicate: false };

    const folderPath = filePaths[0];
    const folders = getMusicFolders();
    if (folders.includes(folderPath)) {
      return { playlist: store.get('cachedPlaylist') || [], duplicate: true };
    }

    syncGeneration++; // 作废进行中的自动同步
    const next = [...folders, folderPath];
    store.set('musicFolders', next);
    const playlist = await scanAllFolders(next);
    store.set('cachedPlaylist', playlist);
    return { playlist, duplicate: false };
  });

  handleMainIpc('folders:remove', async (event, folderPath) => {
    if (typeof folderPath !== 'string') return { playlist: store.get('cachedPlaylist') || [] };
    syncGeneration++;
    const next = getMusicFolders().filter((p) => p !== folderPath);
    store.set('musicFolders', next);
    const playlist = next.length > 0 ? await scanAllFolders(next) : [];
    store.set('cachedPlaylist', playlist);
    pruneStatsForLibrary(playlist.map((s) => s.path));
    return { playlist };
  });

  // 启动一次性聚合拉取：把原先渲染进程 5 轮串行 IPC（settings/music/playlists/queue/playbackState）
  // 合并成单次往返，并跳过非首屏所需的文件夹 fs.access 探测；同时顺带返回已预热好的封面与歌词。
  handleMainIpc('app:bootstrap', async () => {
    const [settings, savedSongs] = await Promise.all([
      buildSettingsSnapshot({ checkFolders: false }),
      loadSavedMusicList(),
    ]);
    const playlists = loadPlaylists();
    const playQueue = getPlayQueue();
    const playbackState = store.get('playbackState') || null;

    let initialCover = null;
    let initialLyrics = null;
    const prefetch = startupPrefetch;
    if (prefetch && playbackState?.currentSongPath === prefetch.songPath) {
      const [coverRes, lyricsRes] = await Promise.all([
        raceWithinMs(prefetch.coverPromise, 20),
        raceWithinMs(prefetch.lyricsPromise, 20),
      ]);
      if (coverRes.done) initialCover = { songPath: prefetch.songPath, value: coverRes.value };
      if (lyricsRes.done) {
        initialLyrics = { songPath: prefetch.songPath, value: lyricsRes.value };
        // 歌词已直接随 bootstrap 下发，释放启动预热引用
        startupPrefetch = null;
      }
    } else {
      startupPrefetch = null;
    }

    return {
      settings,
      savedSongs,
      playlists,
      playQueue,
      playbackState,
      initialCover,
      initialLyrics,
    };
  });

  handleMainIpc('app:loadSavedMusic', async () => {
    return loadSavedMusicList();
  });

  handleMainIpc('app:syncFolder', async () => {
    const gen = syncGeneration;
    const folders = getMusicFolders();
    if (folders.length === 0) return null;

    const diskPaths = await collectDiskPaths(folders);
    const uniquePaths = [...new Set(diskPaths)];

    const cached = store.get('cachedPlaylist') || [];
    const { added, removed } = diffPlaylistPaths(
      cached.map((s) => s.path),
      uniquePaths
    );
    if (added.length === 0 && removed.length === 0)
      return { added: 0, removed: 0, playlist: cached };
    if (gen !== syncGeneration) return null; // 扫描期间用户修改了文件夹列表

    const newEntries = [];
    for (const p of added) newEntries.push(await parseAudioFile(p));
    if (gen !== syncGeneration) return null;

    const playlist = applySyncToPlaylist(cached, newEntries, removed);
    store.set('cachedPlaylist', playlist);
    if (removed.length > 0) pruneStatsForLibrary(playlist.map((s) => s.path));
    return { added: added.length, removed: removed.length, playlist };
  });

  handleMainIpc('app:getCover', async (event, filePath, songMeta) => {
    return readCover(filePath, getMusicFolders(), songMeta);
  });

  handleMainIpc('app:getCoverThumb', async (event, filePath, maxSize, songMeta) => {
    return readCoverThumbnail(filePath, getMusicFolders(), maxSize, songMeta);
  });

  handleMainIpc('app:savePlaybackState', async (event, state) => {
    const normalized = normalizePlaybackState(state);
    if (!normalized) return false;
    store.set('playbackState', normalized);
    return true;
  });

  handleMainIpc('app:loadPlaybackState', async () => {
    return store.get('playbackState') || null;
  });

  // 播放队列快照：渲染进程整体推送当前队列，主进程只做校验与落盘
  handleMainIpc('queue:get', () => getPlayQueue());
  onMainIpc('queue:set', (event, queue) => {
    setPlayQueue(queue);
  });

  handleMainIpc('app:getLyrics', async (event, audioPath, songMeta = null) => {
    if (startupPrefetch && startupPrefetch.songPath === audioPath) {
      const pending = startupPrefetch.lyricsPromise;
      startupPrefetch = null;
      return pending;
    }
    let meta = songMeta;
    if (!meta && typeof audioPath === 'string') {
      const cached = store.get('cachedPlaylist');
      if (Array.isArray(cached)) {
        meta = cached.find((s) => s && s.path === audioPath) || null;
      }
    }
    return readLyrics(audioPath, getMusicFolders(), meta);
  });

  handleMainIpc('settings:get', async () => {
    return buildSettingsSnapshot({ checkFolders: true });
  });

  handleMainIpc('settings:setTaskbarLyricsStyle', (event, style) => {
    const next = setTaskbarLyricsStyle(style);
    updateTaskbarLyricsStyle();
    return next;
  });

  handleMainIpc('settings:setDesktopLyricsClickThrough', (event, enabled) => {
    const next = setDesktopLyricsClickThrough(!!enabled);
    setLyricsClickThrough(next);
    return next;
  });

  // 桌面歌词单/双行（双行 = 当前行 + 下一行）
  handleMainIpc('settings:setDesktopLyricsLines', (event, lines) => {
    const next = setDesktopLyricsLines(lines === 2 ? 2 : 1);
    setLyricsLines(next);
    return next;
  });

  // 桌面歌词是运行态，不落盘：设置页开关直接开/关当前悬浮窗
  handleMainIpc('settings:setDesktopLyricsEnabled', (event, enabled) => {
    if (!!enabled !== isLyricsWindowVisible()) toggleDesktopLyrics();
    return isLyricsWindowVisible();
  });

  // 任务栏歌词是持久化偏好；启动失败不改写偏好，界面通过 running 区分
  handleMainIpc('settings:setTaskbarLyricsEnabled', (event, enabled) => {
    if (process.platform !== 'win32') return { enabled: false, running: false };
    setTaskbarLyricsEnabled(!!enabled);
    rebuildTrayMenu();
    return {
      enabled: getTaskbarLyricsSetting(),
      running: isTaskbarLyricsRunning(),
    };
  });

  // macOS 菜单栏歌词：设置页开关与托盘/快捷键共用同一份偏好
  handleMainIpc('settings:setMenubarLyricsEnabled', (event, enabled) => {
    if (process.platform !== 'darwin') return false;
    const next = setMenubarLyricsEnabled(!!enabled);
    rebuildTrayMenu();
    return next;
  });

  handleMainIpc('settings:setEqualizer', (event, eq) => setEqualizer(eq));

  // 主题模式同时下发给 Chromium：themeSource 一变，渲染进程里的
  // prefers-color-scheme 就跟着变，light-dark() 与噪点透明度的媒体查询才会对。
  handleMainIpc('settings:setThemeMode', (event, mode) => {
    const next = setThemeMode(mode);
    nativeTheme.themeSource = next;
    return next;
  });

  // 性能模式：主窗口由渲染进程自己切 body 类；桌面歌词是独立渲染进程，
  // 这里主动重发一次样式，让它同步关掉胶囊的毛玻璃。
  handleMainIpc('settings:setPerformanceMode', (event, enabled) => {
    const next = setPerformanceMode(enabled);
    refreshLyricsStyle();
    return next;
  });

  handleMainIpc('settings:setLanguage', (event, lang) => {
    if (lang !== 'zh-CN' && lang !== 'en') return false;
    applyLanguage(lang);
    rebuildTrayMenu();
    setLyricsLang(lang);
    refreshTaskbarLyricsConfig();
    pushLocaleToPlugins(lang);
    return true;
  });

  handleMainIpc('settings:setLyricsTranslation', (event, visible) => {
    setLyricsTranslation(visible);
    updateTaskbarLyricsTranslation(!!visible);
    return true;
  });

  handleMainIpc('settings:setLyricsStyle', (event, style) => {
    const next = setLyricsStyleSetting(style);
    setLyricsStyle(next);
    return next;
  });

  handleMainIpc('app:updateDesktopLyrics', (event, payload) => {
    const text = typeof payload === 'string' ? payload : payload?.text || '';
    const secondText = typeof payload === 'string' ? '' : payload?.secondText || '';
    const words = typeof payload === 'string' ? null : payload?.words || null;
    const songPath = typeof payload === 'string' ? null : payload?.songPath || null;
    setLyricsContent(text, secondText, words, songPath);
    // 菜单栏歌词复用桌面歌词的当前行文本，两者永远保持一致
    updateMenubarLyricsText(text);
    return true;
  });

  // 任务栏歌词：主窗口渲染进程只推数据，主进程原样转发给任务栏窗。
  // 用 send/on 而不是 invoke：timeupdate 4Hz 的频率不值得为每次推送建 Promise。
  onMainIpc('app:setTaskbarLyricsDocument', (event, doc) => {
    updateTaskbarLyricsDocument(doc);
    // 同一份文档也用于菜单栏的“无歌词时显示歌名/歌手”兜底
    updateMenubarLyricsDocument(doc);
  });

  onMainIpc('app:updateTaskbarLyricsPlayback', (event, playback) => {
    updateTaskbarLyricsPlayback(playback);
    setDesktopLyricsPlayback(playback);
  });

  // 处理小窗模式切换
  handleMainIpc('app:toggleMiniMode', () => {
    return toggleMiniMode();
  });

  // 窗口控制 IPC
  handleMainIpc('window:minimize', () => {
    minimizeWindow();
  });
  handleMainIpc('window:maximize', () => {
    maximizeWindow();
  });
  handleMainIpc('window:close', () => {
    closeWindow();
  });

  // 获取应用版本号
  handleMainIpc('app:getVersion', () => app.getVersion());

  handleMainIpc('stats:get', () => {
    const stats = store.get('stats');
    return stats && stats.plays ? stats : emptyStats();
  });

  handleMainIpc('stats:recordPlay', (event, songPath, kind) => {
    if (
      typeof songPath !== 'string' ||
      (kind !== 'full' && kind !== 'loop') ||
      !isAllowedSongIdSync(songPath, getMusicFolders())
    ) {
      return null;
    }
    const raw = store.get('stats');
    const next = recordPlay(raw && raw.plays ? raw : emptyStats(), songPath, kind, Date.now());
    store.set('stats', next);
    return Object.hasOwn(next.plays, songPath) ? next.plays[songPath] : null;
  });
}
