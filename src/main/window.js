import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;

// 窗口状态追踪
let isMiniMode = false;
let normalBounds = null;
let wasMaximized = false;

export function getMainWindow() {
  return mainWindow;
}

export function createWindow() {
  Menu.setApplicationMenu(null);

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
    icon: path.join(__dirname, '../assets/app_icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

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

// 小窗模式切换：置顶 + 固定尺寸 + 通知前端
export function toggleMiniMode() {
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
}

export function minimizeWindow() {
  if (mainWindow) mainWindow.minimize();
}

export function maximizeWindow() {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
}

export function closeWindow() {
  if (mainWindow) mainWindow.close();
}
