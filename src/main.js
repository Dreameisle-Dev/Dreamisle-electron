import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseFile } from 'music-metadata';
import fs from 'fs/promises';
import Store from 'electron-store';
import { diffPlaylistPaths, applySyncToPlaylist } from './sync-playlist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new Store();

// 手动导入时递增，使进行中的自动同步结果作废
let syncGeneration = 0;

let mainWindow = null;
let tray = null;

app.isQuitting = false;

// 状态追踪
let isMiniMode = false;
let normalBounds = null;
let wasMaximized = false;

// 开启显卡栅格化和零拷贝以提升渲染性能
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

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

function createTray() {
  const iconPath = path.join(__dirname, 'assets/app_icon.ico');
  const trayIcon = nativeImage.createFromPath(iconPath);

  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    { label: '播放/暂停', click: () => { if (mainWindow) mainWindow.webContents.send('tray-play-pause'); } },
    { label: '下一首', click: () => { if (mainWindow) mainWindow.webContents.send('tray-next'); } },
    { label: '上一首', click: () => { if (mainWindow) mainWindow.webContents.send('tray-prev'); } },
    { type: 'separator' },
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('Dreamisle 音乐播放器');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') { } });
app.on('activate', () => { if (mainWindow === null) createWindow(); else mainWindow.show(); });
app.on('before-quit', () => { app.isQuitting = true; });

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

async function scanAndParse(folderPath) {
  const audioFiles = await scanDirectory(folderPath);
  const playlist = [];
  for (const filePath of audioFiles) {
    playlist.push(await parseAudioFile(filePath));
  }
  return playlist;
}

ipcMain.handle('dialog:openFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (canceled) return [];
  const folderPath = filePaths[0];
  syncGeneration++; // 手动导入新文件夹，作废进行中的自动同步
  store.set('musicFolder', folderPath);
  
  // 重新选择目录时扫描并写入缓存，避免重复工作
  const playlist = await scanAndParse(folderPath);
  store.set('cachedPlaylist', playlist);
  return playlist;
});

ipcMain.handle('app:loadSavedMusic', async () => {
  // 优先从本地 Store 获取已缓存的列表
  const cached = store.get('cachedPlaylist');
  if (cached && cached.length > 0) {
    return cached;
  }

  const savedPath = store.get('musicFolder');
  if (!savedPath) return [];
  try {
    await fs.access(savedPath);
    const playlist = await scanAndParse(savedPath);
    store.set('cachedPlaylist', playlist);
    return playlist;
  } catch (e) { return []; }
});

ipcMain.handle('app:syncFolder', async () => {
  const gen = syncGeneration;
  const folderPath = store.get('musicFolder');
  if (!folderPath) return null;
  try { await fs.access(folderPath); } catch (e) { return null; }

  const diskPaths = await scanDirectory(folderPath);
  const cached = store.get('cachedPlaylist') || [];
  const { added, removed } = diffPlaylistPaths(cached.map((s) => s.path), diskPaths);
  if (added.length === 0 && removed.length === 0) return { added: 0, removed: 0, playlist: cached };
  if (gen !== syncGeneration) return null; // 扫描期间用户手动导入了新文件夹

  const newEntries = [];
  for (const p of added) newEntries.push(await parseAudioFile(p));
  if (gen !== syncGeneration) return null; // 解析期间用户手动导入了新文件夹

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
