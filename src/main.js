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

  // 创建系统托盘
  createTray();

  // 监听窗口关闭事件，隐藏而不是关闭
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
    return true;
  });

  // 监听窗口显示事件
  mainWindow.on('show', () => {
    // 通知渲染进程窗口已显示
    mainWindow.webContents.send('window-visibility-changed', true);
  });

  // 监听窗口隐藏事件
  mainWindow.on('hide', () => {
    // 通知渲染进程窗口已隐藏
    mainWindow.webContents.send('window-visibility-changed', false);
  });
}

function createTray() {
  // 创建托盘图标
  const iconPath = path.join(__dirname, 'assets/app_icon.ico');
  const trayIcon = nativeImage.createFromPath(iconPath);

  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));

  // 托盘菜单
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '播放/暂停',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('tray-play-pause');
        }
      }
    },
    {
      label: '下一首',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('tray-next');
        }
      }
    },
    {
      label: '上一首',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('tray-prev');
        }
      }
    },
    { type: 'separator' },
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Dreamisle 音乐播放器');
  tray.setContextMenu(contextMenu);

  // 双击托盘图标显示窗口
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // 在macOS上，当所有窗口都关闭时，应用通常保持活动状态
  if (process.platform !== 'darwin') {
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

// 递归扫描文件夹
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
        if (['.mp3', '.flac', '.wav', '.ogg', '.m4a'].includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  } catch (err) {
    console.error('Scan Error:', err);
  }
  return results;
}

// 扫描并解析元数据
async function scanAndParse(folderPath) {
  const audioFiles = await scanDirectory(folderPath);
  const playlist = [];

  for (const filePath of audioFiles) {
    try {
      const metadata = await parseFile(filePath);
      let cover = null;
      
      if (metadata.common.picture && metadata.common.picture.length > 0) {
        const pic = metadata.common.picture[0];
        const base64String = Buffer.from(pic.data).toString('base64');
        cover = `data:${pic.format};base64,${base64String}`;
      }

      playlist.push({
        path: filePath,
        url: pathToFileURL(filePath).href,
        title: metadata.common.title || path.basename(filePath),
        artist: metadata.common.artist || 'Unknown',
        cover: cover
      });
    } catch (e) {
      playlist.push({
        path: filePath,
        url: pathToFileURL(filePath).href,
        title: path.basename(filePath),
        artist: 'Unknown',
        cover: null
      });
    }
  }
  return playlist;
}

// IPC: 手动导入并保存路径
ipcMain.handle('dialog:openFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });

  if (canceled) return [];
  
  const folderPath = filePaths[0];
  store.set('musicFolder', folderPath);

  return await scanAndParse(folderPath);
});

// IPC: 自动加载保存的路径
ipcMain.handle('app:loadSavedMusic', async () => {
  const savedPath = store.get('musicFolder');
  if (!savedPath) return [];

  try {
    await fs.access(savedPath);
    return await scanAndParse(savedPath);
  } catch (e) {
    return [];
  }
});

// IPC: 保存播放状态
ipcMain.handle('app:savePlaybackState', async (event, state) => {
  store.set('playbackState', state);
  return true;
});

// IPC: 加载播放状态
ipcMain.handle('app:loadPlaybackState', async () => {
  return store.get('playbackState') || null;
});