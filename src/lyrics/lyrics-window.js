import { BrowserWindow, globalShortcut, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { store } from '../main/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WINDOW_WIDTH = 760;
const WINDOW_HEIGHT = 72;
const BOTTOM_MARGIN = 80; // 默认位置距任务栏上方的间距

let lyricsWindow = null;
let lastText = '';
let saveBoundsTimer = null;

export function isLyricsWindowVisible() {
  return lyricsWindow !== null && !lyricsWindow.isDestroyed();
}

export function setLyricsText(text) {
  lastText = text;
  if (isLyricsWindowVisible()) {
    lyricsWindow.webContents.send('lyrics:text', text);
  }
}

let lastStyle = { bgOpacity: 45, textOpacity: 100, textColor: '#ffffff', fontFamily: '' };
let lastLang = 'zh-CN';

export function setLyricsStyle(style) {
  lastStyle = { ...lastStyle, ...(style || {}) };
  if (isLyricsWindowVisible()) {
    lyricsWindow.webContents.send('lyrics:style', lastStyle);
  }
}

export function setLyricsLang(lang) {
  if (lang !== 'zh-CN' && lang !== 'en') return;
  lastLang = lang;
  if (isLyricsWindowVisible()) {
    lyricsWindow.webContents.send('lyrics:lang', lang);
  }
}

// 默认位置：主显示器工作区底部居中，任务栏上方 80px
function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - WINDOW_HEIGHT - BOTTOM_MARGIN),
  };
}

// 读取持久化位置；若不在任何显示器工作区内（显示器拔除等）则返回 null 走默认位置
function savedBounds() {
  const saved = store.get('desktopLyricsBounds');
  if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return null;

  const visible = screen.getAllDisplays().some((d) => {
    const { workArea } = d;
    return (
      saved.x >= workArea.x - 200 &&
      saved.x <= workArea.x + workArea.width - 100 &&
      saved.y >= workArea.y - 200 &&
      saved.y <= workArea.y + workArea.height - 50
    );
  });
  return visible ? saved : null;
}

function scheduleBoundsSave() {
  if (!isLyricsWindowVisible()) return;
  const [x, y] = lyricsWindow.getPosition();
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    store.set('desktopLyricsBounds', { x, y });
  }, 500); // 拖动期间防抖写入
}

function createLyricsWindow() {
  const bounds = savedBounds() || defaultBounds();

  lyricsWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true, // 原生拖动需要可聚焦；点击抢焦点由下方 blur 回退处理
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/lyrics-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  lyricsWindow.setAlwaysOnTop(true, 'screen-saver');

  // 记录最近一次窗口移动时间：原生拖动进行中不交还焦点，避免打断拖动
  let lastMoveAt = 0;

  // 点击悬浮窗会短暂激活窗口：延迟交还焦点；若拖动已开始则跳过本次交还
  lyricsWindow.on('focus', () => {
    setTimeout(() => {
      if (isLyricsWindowVisible() && Date.now() - lastMoveAt > 150) {
        lyricsWindow.blur();
      }
    }, 120);
  });

  lyricsWindow.loadFile(path.join(__dirname, 'lyrics-window.html'));

  lyricsWindow.webContents.on('did-finish-load', () => {
    lyricsWindow.webContents.send('lyrics:lang', lastLang);
    lyricsWindow.webContents.send('lyrics:style', lastStyle);
    lyricsWindow.webContents.send('lyrics:text', lastText);
    lyricsWindow.showInactive(); // 显示但不获取焦点
  });

  lyricsWindow.on('move', () => {
    lastMoveAt = Date.now();
    scheduleBoundsSave();
  });
  lyricsWindow.on('closed', () => {
    clearTimeout(saveBoundsTimer);
    lyricsWindow = null;
  });
}

function destroyLyricsWindow() {
  if (!isLyricsWindowVisible()) return;
  const [x, y] = lyricsWindow.getPosition();
  store.set('desktopLyricsBounds', { x, y });
  clearTimeout(saveBoundsTimer);
  lyricsWindow.destroy();
  lyricsWindow = null;
}

export function toggleDesktopLyrics() {
  if (isLyricsWindowVisible()) {
    destroyLyricsWindow();
    return false;
  }
  createLyricsWindow();
  return true;
}

export function registerLyricsHotkey() {
  const ok = globalShortcut.register('Control+Alt+L', toggleDesktopLyrics);
  if (!ok) console.warn('[Dreamisle] 全局快捷键 Control+Alt+L 注册失败，桌面歌词功能不可用');
}

export function disposeLyrics() {
  clearTimeout(saveBoundsTimer);
  destroyLyricsWindow();
  globalShortcut.unregister('Control+Alt+L');
}
