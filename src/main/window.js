import { app, BrowserWindow, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 760;
const WINDOW_BOUNDS_KEY = 'mainWindowBounds';
const BOUNDS_SAVE_DELAY_MS = 500;

let mainWindow = null;

// 窗口状态追踪
let isMiniMode = false;
let normalBounds = null;
let wasMaximized = false;
let boundsSaveTimer = null;

export function getMainWindow() {
  return mainWindow;
}

// 保存的窗口位置可能来自已拔掉的显示器或已改变的分辨率。
// 只要左上角还能落在某个显示器工作区内（允许一点负偏移，便于把窗口拖回来），就恢复。
function resolveSavedBounds(saved) {
  if (
    !saved ||
    typeof saved !== 'object' ||
    !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(saved[key])) ||
    saved.width <= 0 ||
    saved.height <= 0
  ) {
    return null;
  }

  const display = screen.getAllDisplays().find(({ workArea }) => {
    return (
      saved.x >= workArea.x - 80 &&
      saved.x < workArea.x + workArea.width - 80 &&
      saved.y >= workArea.y - 10 &&
      saved.y < workArea.y + workArea.height - 40
    );
  });
  if (!display) return null;

  // 窗口比当前显示器还大时收窄，并把窗口整体夹回工作区，
  // 避免恢复出一个上下/左右都够不着的窗口。
  const { workArea } = display;
  const width = Math.min(Math.max(1, Math.round(saved.width)), workArea.width);
  const height = Math.min(Math.max(1, Math.round(saved.height)), workArea.height);
  return {
    x: Math.min(Math.max(Math.round(saved.x), workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(Math.round(saved.y), workArea.y), workArea.y + workArea.height - height),
    width,
    height,
    maximized: saved.maximized === true,
  };
}

function persistBounds(bounds, maximized) {
  try {
    store.set(WINDOW_BOUNDS_KEY, {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      maximized: !!maximized,
    });
  } catch (error) {
    // 配置不可写时不能挡住关窗/退出
    console.warn('[Dreamisle] failed to save the window bounds', error);
  }
}

// 小窗模式的尺寸不是用户对主窗口的期望，不能覆盖普通模式的记忆。
function saveBoundsNow() {
  if (!mainWindow || mainWindow.isDestroyed() || isMiniMode) return;
  persistBounds(mainWindow.getNormalBounds(), mainWindow.isMaximized());
}

function scheduleBoundsSave() {
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    saveBoundsNow();
  }, BOUNDS_SAVE_DELAY_MS);
}

// 退出前把防抖中的最后一次改动落盘
export function flushWindowBounds() {
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = null;
  saveBoundsNow();
}

export function createWindow() {
  // 窗口重置时清空状态
  isMiniMode = false;
  normalBounds = null;
  wasMaximized = false;

  const savedBounds = resolveSavedBounds(store.get(WINDOW_BOUNDS_KEY));
  // 默认窗口比旧版更高；小屏（如 768p）按工作区高度收敛，避免超出屏幕
  const { workArea } = screen.getPrimaryDisplay();
  const defaultHeight = Math.min(DEFAULT_HEIGHT, Math.max(700, workArea.height - 40));

  mainWindow = new BrowserWindow({
    width: savedBounds ? savedBounds.width : DEFAULT_WIDTH,
    height: savedBounds ? savedBounds.height : defaultHeight,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hidden', // 隐藏默认系统标题栏；macOS 上保留红黄绿按钮
    backgroundColor: '#000000',
    icon: path.join(
      __dirname,
      process.platform === 'win32' ? '../assets/app_icon.ico' : '../assets/icon_256x256.png'
    ),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  if (savedBounds?.maximized) mainWindow.maximize();

  // 拖动/缩放时防抖落盘；最大化状态单独记录，恢复时先还原普通尺寸再最大化
  mainWindow.on('resize', scheduleBoundsSave);
  mainWindow.on('move', scheduleBoundsSave);
  mainWindow.on('maximize', scheduleBoundsSave);
  mainWindow.on('unmaximize', scheduleBoundsSave);

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      // 关窗只是隐藏到托盘，这里先把最后一次尺寸/位置落盘
      flushWindowBounds();
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
    normalBounds = mainWindow.getNormalBounds();
    // 小窗模式不写入 bounds 记忆；进入前先把普通模式的尺寸/位置落盘。
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = null;
    persistBounds(normalBounds, wasMaximized);

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
    // 刚调用 maximize/setBounds 时部分平台的状态还没同步，按进入小窗前
    // 记下的普通尺寸直接落盘，避免把 maximized 记错。
    if (normalBounds) persistBounds(normalBounds, wasMaximized);
    else saveBoundsNow();

    // 通知前端返回普通模式
    mainWindow.webContents.send('window-mode-changed', 'normal');
  }

  // macOS 小窗没有自绘标题栏，隐藏红黄绿按钮，避免压在封面上；退出小窗再显示。
  if (process.platform === 'darwin' && mainWindow.setWindowButtonVisibility) {
    mainWindow.setWindowButtonVisibility(!isMiniMode);
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
