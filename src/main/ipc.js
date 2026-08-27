import { app, ipcMain, dialog } from 'electron';
import fs from 'fs/promises';
import {
  store,
  getMusicFolders,
  getLanguage,
  getLyricsStyle,
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
import { setLyricsText, setLyricsStyle, setLyricsLang } from '../lyrics/lyrics-window.js';
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
      musicFolders: folders,
    };
  });

  ipcMain.handle('settings:setLanguage', (event, lang) => {
    if (lang !== 'zh-CN' && lang !== 'en') return false;
    applyLanguage(lang);
    rebuildTrayMenu();
    setLyricsLang(lang);
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

  ipcMain.handle('app:updateDesktopLyrics', (event, text) => {
    setLyricsText(typeof text === 'string' ? text : '');
    return true;
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
