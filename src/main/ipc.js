import { app, ipcMain, dialog, nativeTheme } from 'electron';
import fs from 'fs/promises';
import {
  store,
  getMusicFolders,
  getLanguage,
  getLyricsStyle,
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
  clampPercent,
  DEFAULT_LYRICS_STYLE,
} from './store.js';
import {
  parseAudioFile,
  scanAllFolders,
  collectDiskPaths,
  readCover,
  readLyrics,
  diffPlaylistPaths,
  applySyncToPlaylist,
  hasLegacyMetadata,
} from './music-library.js';
import { toggleMiniMode, minimizeWindow, maximizeWindow, closeWindow } from './window.js';
import { rebuildTrayMenu } from './tray.js';
import {
  setLyricsContent,
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
import { refreshPlaylistsMetadata } from './playlists.js';

// 手动导入时递增，使进行中的自动同步结果作废
let syncGeneration = 0;

// 统计中清理已不在音乐库中的歌曲记录
function pruneStatsForLibrary(validPaths) {
  const raw = store.get('stats');
  if (!raw || !raw.plays) return;
  store.set('stats', pruneStats(raw, new Set(validPaths)));
}

// 注册全部渲染进程 ↔ 主进程 IPC 通道；频道名与 preload API 一一对应
export function registerIpcHandlers() {
  ipcMain.handle('folders:add', async () => {
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

  ipcMain.handle('folders:remove', async (event, folderPath) => {
    syncGeneration++;
    const next = getMusicFolders().filter((p) => p !== folderPath);
    store.set('musicFolders', next);
    const playlist = next.length > 0 ? await scanAllFolders(next) : [];
    store.set('cachedPlaylist', playlist);
    pruneStatsForLibrary(playlist.map((s) => s.path));
    return { playlist };
  });

  ipcMain.handle('app:loadSavedMusic', async () => {
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
  });

  ipcMain.handle('app:syncFolder', async () => {
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

  ipcMain.handle('app:getCover', async (event, filePath) => {
    return readCover(filePath);
  });

  ipcMain.handle('app:savePlaybackState', async (event, state) => {
    store.set('playbackState', state);
    return true;
  });

  ipcMain.handle('app:loadPlaybackState', async () => {
    return store.get('playbackState') || null;
  });

  // 播放队列快照：渲染进程整体推送当前队列，主进程只做校验与落盘
  ipcMain.handle('queue:get', () => getPlayQueue());
  ipcMain.on('queue:set', (event, queue) => {
    setPlayQueue(queue);
  });

  ipcMain.handle('app:getLyrics', async (event, audioPath) => {
    return readLyrics(audioPath);
  });

  ipcMain.handle('settings:get', async () => {
    const folders = await Promise.all(
      getMusicFolders().map(async (p) => {
        let available = false;
        try {
          await fs.access(p);
          available = true;
        } catch (e) {}
        return { path: p, available };
      })
    );
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
  });

  ipcMain.handle('settings:setTaskbarLyricsStyle', (event, style) => {
    const next = setTaskbarLyricsStyle(style);
    updateTaskbarLyricsStyle();
    return next;
  });

  ipcMain.handle('settings:setDesktopLyricsClickThrough', (event, enabled) => {
    const next = setDesktopLyricsClickThrough(!!enabled);
    setLyricsClickThrough(next);
    return next;
  });

  // 桌面歌词单/双行（双行 = 当前行 + 下一行）
  ipcMain.handle('settings:setDesktopLyricsLines', (event, lines) => {
    const next = setDesktopLyricsLines(lines === 2 ? 2 : 1);
    setLyricsLines(next);
    return next;
  });

  // 桌面歌词是运行态，不落盘：设置页开关直接开/关当前悬浮窗
  ipcMain.handle('settings:setDesktopLyricsEnabled', (event, enabled) => {
    if (!!enabled !== isLyricsWindowVisible()) toggleDesktopLyrics();
    return isLyricsWindowVisible();
  });

  // 任务栏歌词是持久化偏好；启动失败不改写偏好，界面通过 running 区分
  ipcMain.handle('settings:setTaskbarLyricsEnabled', (event, enabled) => {
    if (process.platform !== 'win32') return { enabled: false, running: false };
    setTaskbarLyricsEnabled(!!enabled);
    rebuildTrayMenu();
    return {
      enabled: getTaskbarLyricsSetting(),
      running: isTaskbarLyricsRunning(),
    };
  });

  // macOS 菜单栏歌词：设置页开关与托盘/快捷键共用同一份偏好
  ipcMain.handle('settings:setMenubarLyricsEnabled', (event, enabled) => {
    if (process.platform !== 'darwin') return false;
    const next = setMenubarLyricsEnabled(!!enabled);
    rebuildTrayMenu();
    return next;
  });

  ipcMain.handle('settings:setEqualizer', (event, eq) => setEqualizer(eq));

  // 主题模式同时下发给 Chromium：themeSource 一变，渲染进程里的
  // prefers-color-scheme 就跟着变，light-dark() 与噪点透明度的媒体查询才会对。
  ipcMain.handle('settings:setThemeMode', (event, mode) => {
    const next = setThemeMode(mode);
    nativeTheme.themeSource = next;
    return next;
  });

  // 性能模式：主窗口由渲染进程自己切 body 类；桌面歌词是独立渲染进程，
  // 这里主动重发一次样式，让它同步关掉胶囊的毛玻璃。
  ipcMain.handle('settings:setPerformanceMode', (event, enabled) => {
    const next = setPerformanceMode(enabled);
    refreshLyricsStyle();
    return next;
  });

  ipcMain.handle('settings:setLanguage', (event, lang) => {
    if (lang !== 'zh-CN' && lang !== 'en') return false;
    applyLanguage(lang);
    rebuildTrayMenu();
    setLyricsLang(lang);
    refreshTaskbarLyricsConfig();
    return true;
  });

  ipcMain.handle('settings:setLyricsTranslation', (event, visible) => {
    setLyricsTranslation(visible);
    updateTaskbarLyricsTranslation(!!visible);
    return true;
  });

  ipcMain.handle('settings:setLyricsStyle', (event, style) => {
    const next = {
      bgOpacity: clampPercent(style && style.bgOpacity, DEFAULT_LYRICS_STYLE.bgOpacity),
      textOpacity: clampPercent(style && style.textOpacity, DEFAULT_LYRICS_STYLE.textOpacity),
      textColor:
        typeof (style && style.textColor) === 'string'
          ? style.textColor
          : DEFAULT_LYRICS_STYLE.textColor,
      fontFamily:
        typeof (style && style.fontFamily) === 'string'
          ? style.fontFamily.trim()
          : DEFAULT_LYRICS_STYLE.fontFamily,
    };
    store.set('settings.lyricsStyle', next);
    setLyricsStyle(next);
    return next;
  });

  ipcMain.handle('app:updateDesktopLyrics', (event, payload) => {
    const text = typeof payload === 'string' ? payload : payload?.text || '';
    const secondText = typeof payload === 'string' ? '' : payload?.secondText || '';
    setLyricsContent(text, secondText);
    // 菜单栏歌词复用桌面歌词的当前行文本，两者永远保持一致
    updateMenubarLyricsText(text);
    return true;
  });

  // 任务栏歌词：主窗口渲染进程只推数据，主进程原样转发给任务栏窗。
  // 用 send/on 而不是 invoke：timeupdate 4Hz 的频率不值得为每次推送建 Promise。
  ipcMain.on('app:setTaskbarLyricsDocument', (event, doc) => {
    updateTaskbarLyricsDocument(doc);
    // 同一份文档也用于菜单栏的“无歌词时显示歌名/歌手”兜底
    updateMenubarLyricsDocument(doc);
  });

  ipcMain.on('app:updateTaskbarLyricsPlayback', (event, playback) => {
    updateTaskbarLyricsPlayback(playback);
  });

  // 处理小窗模式切换
  ipcMain.handle('app:toggleMiniMode', () => {
    return toggleMiniMode();
  });

  // 窗口控制 IPC
  ipcMain.handle('window:minimize', () => {
    minimizeWindow();
  });
  ipcMain.handle('window:maximize', () => {
    maximizeWindow();
  });
  ipcMain.handle('window:close', () => {
    closeWindow();
  });

  // 获取应用版本号
  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('stats:get', () => {
    const stats = store.get('stats');
    return stats && stats.plays ? stats : emptyStats();
  });

  ipcMain.handle('stats:recordPlay', (event, path, kind) => {
    if (typeof path !== 'string' || (kind !== 'full' && kind !== 'loop')) return null;
    const raw = store.get('stats');
    const next = recordPlay(raw && raw.plays ? raw : emptyStats(), path, kind, Date.now());
    store.set('stats', next);
    return next.plays[path];
  });
}
