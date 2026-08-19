import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, session } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseFile } from 'music-metadata';
import fs from 'fs/promises';
import Store from 'electron-store';
import { diffPlaylistPaths, applySyncToPlaylist } from './sync-playlist.js';
import { initLyricsModule, registerLyricsHotkey, disposeLyrics, setLyricsText, setLyricsStyle, setLyricsLang } from './lyrics-window.js';
import { t, setLang as i18nSetLang } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new Store();

// 手动导入时递增，使进行中的自动同步结果作废
let syncGeneration = 0;

let mainWindow = null;
let tray = null;

// 语言状态：默认跟随系统，用户可在设置中切换
let currentLanguage = null;

const DEFAULT_LYRICS_STYLE = { bgOpacity: 45, textOpacity: 100, textColor: '#ffffff', fontFamily: '' };

app.isQuitting = false;

// 状态追踪
let isMiniMode = false;
let normalBounds = null;
let wasMaximized = false;

// 开启显卡栅格化和零拷贝以提升渲染性能
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

function getMusicFolders() {
  return store.get('musicFolders') || [];
}

function getLanguage() {
  if (!currentLanguage) {
    const stored = store.get('settings.language');
    currentLanguage = stored || (app.getLocale().startsWith('zh') ? 'zh-CN' : 'en');
    i18nSetLang(currentLanguage);
  }
  return currentLanguage;
}

function getLyricsStyle() {
  return { ...DEFAULT_LYRICS_STYLE, ...(store.get('settings.lyricsStyle') || {}) };
}

// 设置页"自定义字体"下拉需要读取系统字体列表（Local Font Access API）；
// 只放行 local-fonts 权限，其余权限维持 Electron 默认拒绝
function setupPermissions() {
  const isLocalFonts = (permission) => permission === 'local-fonts';
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => isLocalFonts(permission));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(isLocalFonts(permission)));
}

function clampPercent(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// 旧版单文件夹配置迁移为文件夹列表
function migrateLegacyMusicFolder() {
  const legacy = store.get('musicFolder');
  if (legacy && !store.has('musicFolders')) {
    store.set('musicFolders', [legacy]);
    store.delete('musicFolder');
  }
}

function createWindow() {
  Menu.setApplicationMenu(null)

  // 窗口重置时清空状态
  isMiniMode = false;
  normalBounds = null;
  wasMaximized = false;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hidden', // 隐藏默认系统标题栏
    backgroundColor: '#000000',
    icon: path.join(__dirname, 'assets/app_icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  createTray();

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
    return true;
  });

  mainWindow.on('show', () => { mainWindow.webContents.send('window-visibility-changed', true); });
  mainWindow.on('hide', () => { mainWindow.webContents.send('window-visibility-changed', false); });
}

function buildTrayMenuTemplate() {
  return [
    { label: t('tray.playPause'), click: () => { if (mainWindow) mainWindow.webContents.send('tray-play-pause'); } },
    { label: t('tray.next'), click: () => { if (mainWindow) mainWindow.webContents.send('tray-next'); } },
    { label: t('tray.prev'), click: () => { if (mainWindow) mainWindow.webContents.send('tray-prev'); } },
    { type: 'separator' },
    { label: t('tray.showWindow'), click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => { app.isQuitting = true; app.quit(); } }
  ];
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
  tray.setToolTip(t('tray.tooltip'));
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets/app_icon.ico');
  const trayIcon = nativeImage.createFromPath(iconPath);

  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate(buildTrayMenuTemplate());

  tray.setToolTip(t('tray.tooltip'));
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    }
  });
}

app.whenReady().then(() => {
  migrateLegacyMusicFolder();
  getLanguage(); // 初始化语言（createTray 依赖 t()）
  setupPermissions();
  createWindow();
  initLyricsModule(store);
  setLyricsStyle(getLyricsStyle()); // 同步已存歌词样式
  setLyricsLang(getLanguage()); // 同步已存语言
  registerLyricsHotkey();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') { } });
app.on('activate', () => { if (mainWindow === null) createWindow(); else mainWindow.show(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  disposeLyrics();
});

async function scanDirectory(dirPath) {
  let results = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(await scanDirectory(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.mp3', '.flac', '.wav', '.ogg', '.m4a'].includes(ext)) results.push(fullPath);
      }
    }
  } catch (err) { console.error('Scan Error:', err); }
  return results;
}

async function parseAudioFile(filePath) {
  try {
    const metadata = await parseFile(filePath, { skipCovers: true, skipPostHeaders: true });
    return {
      path: filePath,
      url: pathToFileURL(filePath).href,
      title: metadata.common.title || path.basename(filePath),
      artist: metadata.common.artist || 'Unknown',
    };
  } catch (e) {
    return {
      path: filePath, url: pathToFileURL(filePath).href, title: path.basename(filePath), artist: 'Unknown',
    };
  }
}

// 合并扫描多个文件夹：跨文件夹按路径去重，逐个解析元数据
async function scanAllFolders(folderPaths) {
  const seen = new Set();
  const playlist = [];
  for (const folderPath of folderPaths) {
    const files = await scanDirectory(folderPath); // 文件夹不存在时返回 []
    for (const filePath of files) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      playlist.push(await parseAudioFile(filePath));
    }
  }
  return playlist;
}

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
  return { playlist };
});

ipcMain.handle('app:loadSavedMusic', async () => {
  // 优先从本地 Store 获取已缓存的列表
  const cached = store.get('cachedPlaylist');
  if (cached && cached.length > 0) {
    return cached;
  }

  const folders = getMusicFolders();
  if (folders.length === 0) return [];
  try {
    const playlist = await scanAllFolders(folders);
    store.set('cachedPlaylist', playlist);
    return playlist;
  } catch (e) { return []; }
});

ipcMain.handle('app:syncFolder', async () => {
  const gen = syncGeneration;
  const folders = getMusicFolders();
  if (folders.length === 0) return null;

  const diskPaths = [];
  for (const folderPath of folders) {
    try { await fs.access(folderPath); } catch (e) { continue; } // 已删除的文件夹跳过
    diskPaths.push(...(await scanDirectory(folderPath)));
  }
  const uniquePaths = [...new Set(diskPaths)];

  const cached = store.get('cachedPlaylist') || [];
  const { added, removed } = diffPlaylistPaths(cached.map((s) => s.path), uniquePaths);
  if (added.length === 0 && removed.length === 0) return { added: 0, removed: 0, playlist: cached };
  if (gen !== syncGeneration) return null; // 扫描期间用户修改了文件夹列表

  const newEntries = [];
  for (const p of added) newEntries.push(await parseAudioFile(p));
  if (gen !== syncGeneration) return null;

  const playlist = applySyncToPlaylist(cached, newEntries, removed);
  store.set('cachedPlaylist', playlist);
  return { added: added.length, removed: removed.length, playlist };
});

ipcMain.handle('app:getCover', async (event, filePath) => {
  try {
    const metadata = await parseFile(filePath, { skipCovers: false, skipPostHeaders: true });
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0];
      return { buffer: pic.data, format: pic.format };
    }
  } catch (e) { }
  return null;
});

ipcMain.handle('app:savePlaybackState', async (event, state) => {
  store.set('playbackState', state);
  return true;
});

ipcMain.handle('app:loadPlaybackState', async () => {
  return store.get('playbackState') || null;
});

ipcMain.handle('app:getLyrics', async (event, audioPath) => {
  try {
    const lrcPath = audioPath.substring(0, audioPath.lastIndexOf('.')) + '.lrc';
    await fs.access(lrcPath);
    return await fs.readFile(lrcPath, 'utf-8');
  } catch (e) { }

  try {
    const metadata = await parseFile(audioPath);
    if (metadata.common && metadata.common.lyrics && metadata.common.lyrics.length > 0) {
      return metadata.common.lyrics[0];
    }
  } catch (err) { }
  return null;
});

ipcMain.handle('settings:get', async () => {
  const folders = await Promise.all(getMusicFolders().map(async (p) => {
    let available = false;
    try { await fs.access(p); available = true; } catch (e) { }
    return { path: p, available };
  }));
  return {
    language: getLanguage(),
    lyricsStyle: getLyricsStyle(),
    musicFolders: folders,
  };
});

ipcMain.handle('settings:setLanguage', (event, lang) => {
  if (lang !== 'zh-CN' && lang !== 'en') return false;
  currentLanguage = lang;
  i18nSetLang(lang);
  store.set('settings.language', lang);
  rebuildTrayMenu();
  setLyricsLang(lang);
  return true;
});

ipcMain.handle('settings:setLyricsStyle', (event, style) => {
  const next = {
    bgOpacity: clampPercent(style && style.bgOpacity, DEFAULT_LYRICS_STYLE.bgOpacity),
    textOpacity: clampPercent(style && style.textOpacity, DEFAULT_LYRICS_STYLE.textOpacity),
    textColor: typeof (style && style.textColor) === 'string' ? style.textColor : DEFAULT_LYRICS_STYLE.textColor,
    fontFamily: typeof (style && style.fontFamily) === 'string' ? style.fontFamily.trim() : DEFAULT_LYRICS_STYLE.fontFamily,
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
  if (!mainWindow) return false;
  isMiniMode = !isMiniMode;

  if (isMiniMode) {
    // 记录原本的窗口状态
    wasMaximized = mainWindow.isMaximized();
    if (wasMaximized) {
      mainWindow.unmaximize();
    }
    normalBounds = mainWindow.getBounds();

    // 先清除原有尺寸限制
    mainWindow.setMinimumSize(100, 100);
    mainWindow.setMaximumSize(9999, 9999);

    // 启用置顶、缩放锁定和尺寸修改
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setSize(300, 340);
    mainWindow.setResizable(false);

    // 通知前端进入小窗模式
    mainWindow.webContents.send('window-mode-changed', 'mini');
  } else {
    // 退出小窗置顶
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setResizable(true);

    // 重新设回原有的普通模式尺寸限制
    mainWindow.setMinimumSize(800, 600);
    mainWindow.setMaximumSize(9999, 9999);

    // 还原普通模式大小及位置
    if (wasMaximized) {
      mainWindow.maximize();
    } else if (normalBounds) {
      mainWindow.setBounds(normalBounds);
    } else {
      mainWindow.setSize(1200, 700);
    }

    // 通知前端返回普通模式
    mainWindow.webContents.send('window-mode-changed', 'normal');
  }
  return isMiniMode;
});

// 窗口控制 IPC
ipcMain.handle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.handle('window:maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});
ipcMain.handle('window:close', () => {
  if (mainWindow) mainWindow.close();
});

// 获取应用版本号
ipcMain.handle('app:getVersion', () => app.getVersion());
