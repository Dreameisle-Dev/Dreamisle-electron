import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseFile } from 'music-metadata';
import fs from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow() {
  Menu.setApplicationMenu(null)

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer/index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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

// IPC处理：导入音乐
ipcMain.handle('dialog:openFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });

  if (canceled) return [];

  const audioFiles = await scanDirectory(filePaths[0]);
  const playlist = [];

  for (const filePath of audioFiles) {
    try {
      const metadata = await parseFile(filePath);
      let cover = null;
      
      // 处理封面 Buffer 转 Base64
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
      // 解析失败只保留基础信息
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
});