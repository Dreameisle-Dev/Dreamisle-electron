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

  mainWindow.on('show', () => {
    mainWindow.webContents.send('window-visibility-changed', true);
  });

  mainWindow.on('hide', () => {
    mainWindow.webContents.send('window-visibility-changed', false);
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets/app_icon.ico');
  const trayIcon = nativeImage.createFromPath(iconPath);

  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '播放/暂停',
      click: () => {
        if (mainWindow) mainWindow.webContents.send('tray-play-pause');
      }
    },
    {
      label: '下一首',
      click: () => {
        if (mainWindow) mainWindow.webContents.send('tray-next');
      }
    },
    {
      label: '上一首',
      click: () => {
        if (mainWindow) mainWindow.webContents.send('tray-prev');
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
  if (process.platform !== 'darwin') {
    // 保持运行
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
      // 在扫描列表时我们不读取歌词，因为太慢了，歌词在播放时单独读取
      const metadata = await parseFile(filePath, { skipCovers: false, skipPostHeaders: true });
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

// IPC: 读取歌词 (支持外部 .lrc 和 内嵌歌词)
ipcMain.handle('app:getLyrics', async (event, audioPath) => {
  console.log(`[Main] 正在获取歌词: ${audioPath}`);

  // 尝试读取外部 .lrc 文件
  try {
    const lrcPath = audioPath.substring(0, audioPath.lastIndexOf('.')) + '.lrc';
    await fs.access(lrcPath);
    const lrcContent = await fs.readFile(lrcPath, 'utf-8');
    console.log('[Main] 找到外部 .lrc 文件');
    return lrcContent;
  } catch (e) {
    // 外部文件不存在，忽略错误，继续尝试内嵌
  }

  // 尝试读取内嵌歌词 (ID3, Vorbis Comments 等)
  try {
    // 重新解析文件，这次不跳过 header，专门读取 lyrics
    const metadata = await parseFile(audioPath);

    // music-metadata 通常把歌词放在 common.lyrics (数组)
    if (metadata.common && metadata.common.lyrics && metadata.common.lyrics.length > 0) {
      console.log('[Main] 找到内嵌歌词');
      return metadata.common.lyrics[0];
    }
  } catch (err) {
    console.error('[Main] 解析内嵌歌词失败:', err);
  }

  console.log('[Main] 未找到任何歌词');
  return null;
});