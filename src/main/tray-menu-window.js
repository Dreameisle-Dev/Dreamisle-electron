// Windows 自定义托盘右键浮层菜单控制器：
// 替代 Electron/Win32 默认的旧式白底右键菜单，提供与 Dreamisle 同源的浅/深主题圆角卡片、
// 顶部迷你「正在播放」封面与切歌控制、以及桌面歌词 / 任务栏歌词实时开关。
// 仅在首次右键时懒创建无边框透明窗口，零冷启动开销。
import { app, BrowserWindow, ipcMain, nativeTheme, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../shared/i18n.js';
import { hardenWebContents } from './security.js';
import { getMainWindow } from './window.js';
import { getLanguage, getMusicFolders, getThemeMode } from './store.js';
import { readCoverThumbnail } from './music-library.js';
import { isLyricsWindowVisible, toggleDesktopLyrics } from '../lyrics/lyrics-window.js';
import { isTaskbarLyricsEnabled, setTaskbarLyricsEnabled } from '../taskbar/taskbar-lyrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAY_MENU_HTML_PATH = path.join(__dirname, '../tray/tray-menu.html');
const TRAY_MENU_PRELOAD_PATH = path.join(__dirname, '../preload/tray-menu-preload.js');

const SHADOW_PAD = 12;
const EDGE_GAP = 8;
const DEFAULT_CARD_WIDTH = 248;
const DEFAULT_CARD_HEIGHT = 276;
const BLUR_TOGGLE_DEBOUNCE_MS = 180;

let menuWindow = null;
let windowLoaded = false;
let ipcBound = false;
let themeListenerBound = false;
let showSeq = 0;
let pendingShow = null; // { seq, anchorBounds, anchorCursor }
let lastHiddenAt = 0;
let coverResolveToken = 0;

// 主进程侧轻量播放快照（直接复用现有歌词/封面同步链路，零额外轮询）
const trackState = {
  songPath: null,
  title: '',
  artist: '',
  album: null,
  duration: null,
  coverUrl: null,
  playing: false,
};

function isTrayMenuAlive() {
  return Boolean(menuWindow && !menuWindow.isDestroyed());
}

function isTrayMenuVisible() {
  return Boolean(isTrayMenuAlive() && menuWindow.isVisible());
}

function isTrayMenuSender(event) {
  return Boolean(isTrayMenuAlive() && event && event.sender === menuWindow.webContents);
}

function buildStatePayload(seq = showSeq) {
  const mainWin = getMainWindow();
  const mainWindowVisible = Boolean(
    mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && !mainWin.isMinimized()
  );

  return {
    showSeq: seq,
    themeMode: getThemeMode(),
    lang: getLanguage(),
    labels: {
      playPause: t('tray.playPause'),
      play: t('tray.play'),
      pause: t('tray.pause'),
      prev: t('tray.prev'),
      next: t('tray.next'),
      desktopLyrics: t('tray.desktopLyrics'),
      taskbarLyrics: t('tray.taskbarLyrics'),
      showWindow: t('tray.showWindow'),
      hideWindow: t('tray.hideWindow'),
      quit: t('tray.quit'),
      quitApp: t('tray.quitApp'),
      idleTitle: t('tray.idleTitle'),
      idleSub: t('tray.idleSub'),
    },
    track: {
      hasTrack: Boolean(trackState.songPath && trackState.title),
      title: trackState.title,
      artist: trackState.artist,
      coverUrl: trackState.coverUrl,
      playing: trackState.playing,
    },
    desktopLyricsEnabled: isLyricsWindowVisible(),
    taskbarLyricsEnabled: isTaskbarLyricsEnabled(),
    mainWindowVisible,
  };
}

function sendState(seq = showSeq) {
  if (!isTrayMenuAlive() || !windowLoaded) return;
  try {
    menuWindow.webContents.send('tray-menu:state', buildStatePayload(seq));
  } catch {}
}

function computeMenuBounds(cardWidth, cardHeight, anchorBounds, anchorCursor) {
  const cardW = Math.max(200, Math.min(340, Math.round(cardWidth) || DEFAULT_CARD_WIDTH));
  const cardH = Math.max(150, Math.min(520, Math.round(cardHeight) || DEFAULT_CARD_HEIGHT));
  const winW = cardW + SHADOW_PAD * 2;
  const winH = cardH + SHADOW_PAD * 2;

  const cursor = anchorCursor || screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const wa = display.workArea;
  const db = display.bounds;

  // Win11 折叠托盘溢出处 anchorBounds 可能为 0 或偏移较远，此时退回精确光标坐标
  const useTrayRect =
    anchorBounds &&
    anchorBounds.width > 0 &&
    anchorBounds.height > 0 &&
    Math.abs(cursor.x - (anchorBounds.x + anchorBounds.width / 2)) < 90 &&
    Math.abs(cursor.y - (anchorBounds.y + anchorBounds.height / 2)) < 90;

  const ax = useTrayRect ? anchorBounds.x + anchorBounds.width / 2 : cursor.x;
  const ayTop = useTrayRect ? anchorBounds.y : cursor.y;
  const ayBottom = useTrayRect ? anchorBounds.y + anchorBounds.height : cursor.y;

  const minCardX = wa.x + EDGE_GAP;
  const maxCardX = Math.max(minCardX, wa.x + wa.width - cardW - EDGE_GAP);
  const cardX = Math.min(maxCardX, Math.max(minCardX, Math.round(ax - cardW / 2)));

  const minCardY = wa.y + EDGE_GAP;
  const maxCardY = Math.max(minCardY, wa.y + wa.height - cardH - EDGE_GAP);
  const openAbove = cursor.y >= db.y + db.height / 2;
  const rawCardY = openAbove
    ? Math.min(ayTop - cardH - 6, maxCardY)
    : Math.max(ayBottom + 6, minCardY);
  const cardY = Math.min(maxCardY, Math.max(minCardY, Math.round(rawCardY)));

  return {
    x: cardX - SHADOW_PAD,
    y: cardY - SHADOW_PAD,
    width: winW,
    height: winH,
  };
}

function handleAction(action) {
  const mainWin = getMainWindow();
  const mainAlive = Boolean(mainWin && !mainWin.isDestroyed());

  switch (action) {
    case 'play-pause':
      if (mainAlive) mainWin.webContents.send('tray-play-pause');
      if (trackState.songPath) {
        trackState.playing = !trackState.playing;
        sendState(showSeq);
      }
      break;

    case 'prev':
      if (mainAlive) mainWin.webContents.send('tray-prev');
      break;

    case 'next':
      if (mainAlive) mainWin.webContents.send('tray-next');
      break;

    case 'toggle-desktop-lyrics':
      toggleDesktopLyrics();
      sendState(showSeq);
      break;

    case 'toggle-taskbar-lyrics':
      setTaskbarLyricsEnabled(!isTaskbarLyricsEnabled());
      sendState(showSeq);
      break;

    case 'toggle-window':
      hideWindowsTrayMenu();
      if (mainAlive) {
        if (mainWin.isVisible() && !mainWin.isMinimized()) {
          mainWin.hide();
        } else {
          if (mainWin.isMinimized()) mainWin.restore();
          mainWin.show();
          mainWin.focus();
        }
      }
      break;

    case 'quit':
      hideWindowsTrayMenu();
      app.isQuitting = true;
      app.quit();
      break;

    default:
      break;
  }
}

function bindIpcOnce() {
  if (ipcBound) return;
  ipcBound = true;

  ipcMain.on('tray-menu:ready', (event, metrics) => {
    if (!isTrayMenuSender(event)) return;
    if (!pendingShow || metrics?.showSeq !== pendingShow.seq) return;
    const req = pendingShow;
    pendingShow = null;

    const bounds = computeMenuBounds(
      metrics?.width,
      metrics?.height,
      req.anchorBounds,
      req.anchorCursor
    );
    menuWindow.setBounds(bounds, false);
    menuWindow.setAlwaysOnTop(true, 'pop-up-menu');
    menuWindow.show();
    menuWindow.focus();
    try {
      menuWindow.webContents.send('tray-menu:shown', req.seq);
    } catch {}
  });

  ipcMain.on('tray-menu:action', (event, action) => {
    if (!isTrayMenuSender(event)) return;
    if (typeof action === 'string') handleAction(action);
  });

  ipcMain.on('tray-menu:close', (event) => {
    if (!isTrayMenuSender(event)) return;
    hideWindowsTrayMenu();
  });
}

function bindThemeListenerOnce() {
  if (themeListenerBound) return;
  themeListenerBound = true;
  nativeTheme.on('updated', () => {
    if (isTrayMenuVisible()) sendState(showSeq);
  });
}

function ensureCoverForCurrentTrack() {
  const songPath = trackState.songPath;
  if (!songPath || trackState.coverUrl) return;
  const token = ++coverResolveToken;
  const songMeta = trackState.title
    ? {
        title: trackState.title,
        artist: trackState.artist || '',
        album: trackState.album || null,
        duration: trackState.duration,
      }
    : null;

  readCoverThumbnail(songPath, getMusicFolders(), 96, songMeta)
    .then((url) => {
      if (token !== coverResolveToken || trackState.songPath !== songPath) return;
      if (typeof url === 'string' && url.length > 0) {
        trackState.coverUrl = url;
        if (isTrayMenuVisible()) sendState(showSeq);
      }
    })
    .catch(() => {});
}

function ensureMenuWindow() {
  if (isTrayMenuAlive()) return menuWindow;
  bindIpcOnce();
  bindThemeListenerOnce();

  windowLoaded = false;
  menuWindow = new BrowserWindow({
    width: DEFAULT_CARD_WIDTH + SHADOW_PAD * 2,
    height: DEFAULT_CARD_HEIGHT + SHADOW_PAD * 2,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      preload: TRAY_MENU_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hardenWebContents(menuWindow.webContents, TRAY_MENU_HTML_PATH);
  menuWindow.setAlwaysOnTop(true, 'pop-up-menu');

  menuWindow.on('blur', () => {
    hideWindowsTrayMenu();
  });

  menuWindow.on('closed', () => {
    menuWindow = null;
    windowLoaded = false;
    pendingShow = null;
  });

  menuWindow.webContents.once('did-finish-load', () => {
    windowLoaded = true;
    if (pendingShow && isTrayMenuAlive()) {
      sendState(pendingShow.seq);
    }
  });

  menuWindow.loadFile(TRAY_MENU_HTML_PATH);
  return menuWindow;
}

export function hideWindowsTrayMenu() {
  pendingShow = null;
  if (!isTrayMenuAlive()) return;
  if (menuWindow.isVisible()) {
    lastHiddenAt = Date.now();
    menuWindow.hide();
  }
}

export function toggleWindowsTrayMenu(anchorBounds = null) {
  if (process.platform !== 'win32' || app.isQuitting) return;

  if (isTrayMenuVisible()) {
    hideWindowsTrayMenu();
    return;
  }
  // 右键托盘图标时 Windows 会先触发 blur 隐藏窗口再派发 right-click；短时间内忽略重开以实现平滑收起
  if (Date.now() - lastHiddenAt < BLUR_TOGGLE_DEBOUNCE_MS) return;

  const anchorCursor = screen.getCursorScreenPoint();
  const seq = ++showSeq;
  pendingShow = { seq, anchorBounds, anchorCursor };

  ensureMenuWindow();
  ensureCoverForCurrentTrack();
  if (windowLoaded) {
    sendState(seq);
  }
}

export function refreshWindowsTrayMenu() {
  if (isTrayMenuVisible()) {
    sendState(showSeq);
  }
}

export function updateTrayTrackDocument(doc) {
  if (!doc || typeof doc !== 'object') {
    trackState.songPath = null;
    trackState.title = '';
    trackState.artist = '';
    trackState.album = null;
    trackState.duration = null;
    trackState.coverUrl = null;
    if (isTrayMenuVisible()) sendState(showSeq);
    return;
  }
  const nextPath = typeof doc.songPath === 'string' ? doc.songPath : null;
  if (nextPath !== trackState.songPath) {
    trackState.coverUrl = null;
    coverResolveToken++;
  }
  trackState.songPath = nextPath;
  trackState.title = typeof doc.title === 'string' ? doc.title : '';
  trackState.artist = typeof doc.artist === 'string' ? doc.artist : '';
  trackState.album = typeof doc.album === 'string' ? doc.album : null;
  trackState.duration = Number.isFinite(doc.duration) ? doc.duration : null;

  if (isTrayMenuVisible()) {
    ensureCoverForCurrentTrack();
    sendState(showSeq);
  }
}

export function updateTrayPlayback(playback) {
  if (!playback || typeof playback !== 'object') return;
  const nextPlaying = Boolean(playback.playing);
  if (nextPlaying === trackState.playing) return;
  trackState.playing = nextPlaying;
  if (isTrayMenuVisible()) sendState(showSeq);
}

export function updateTrayTrackCover(songPath, coverUrl) {
  if (!songPath || typeof coverUrl !== 'string' || !coverUrl) return;
  if (trackState.songPath && trackState.songPath !== songPath) return;
  if (!trackState.songPath) trackState.songPath = songPath;
  if (trackState.coverUrl === coverUrl) return;
  trackState.coverUrl = coverUrl;
  if (isTrayMenuVisible()) sendState(showSeq);
}

export function getTrayMenuWindowForTest() {
  return isTrayMenuAlive() ? menuWindow : null;
}

export function disposeWindowsTrayMenu() {
  pendingShow = null;
  coverResolveToken++;
  if (isTrayMenuAlive()) {
    menuWindow.destroy();
    menuWindow = null;
  }
  windowLoaded = false;
}
