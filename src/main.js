import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseFile } from 'music-metadata';
import fs from 'fs/promises';
import Store from 'electron-store';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new Store();

let mainWindow = null;
let tray = null;

app.isQuitting = false;

function createWindow() {
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
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

async function scanAndParse(folderPath) {
  const audioFiles = await scanDirectory(folderPath);
  const playlist = [];

  for (const filePath of audioFiles) {
    try {
      const metadata = await parseFile(filePath, { skipCovers: true, skipPostHeaders: true });
      playlist.push({
        path: filePath,
        url: pathToFileURL(filePath).href,
        title: metadata.common.title || path.basename(filePath),
        artist: metadata.common.artist || 'Unknown',
      });
    } catch (e) {
      playlist.push({
        path: filePath, url: pathToFileURL(filePath).href, title: path.basename(filePath), artist: 'Unknown',
      });
    }
  }
  return playlist;
}

ipcMain.handle('dialog:openFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (canceled) return [];
  const folderPath = filePaths[0];
  store.set('musicFolder', folderPath);
  return await scanAndParse(folderPath);
});

ipcMain.handle('app:loadSavedMusic', async () => {
  const savedPath = store.get('musicFolder');
  if (!savedPath) return [];
  try {
    await fs.access(savedPath);
    return await scanAndParse(savedPath);
  } catch (e) { return []; }
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
