// Dreamisle 任务栏歌词业务层：基于独立开源宿主 `packages/electron-taskbar-widget`，
// 负责歌词文档、播放进度、封面读取、样式设置同步、IPC 与失败提示。
import { dialog, ipcMain, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMainWindow } from '../main/window.js';
import { readCover } from '../main/music-library.js';
import { hardenWebContents } from '../main/security.js';
import {
  getLanguage,
  getLyricsTranslation,
  getMusicFolders,
  getTaskbarLyricsSetting,
  getTaskbarLyricsStyle,
  setTaskbarLyricsSetting,
} from '../main/store.js';
import { t } from '../shared/i18n.js';
import {
  createTaskbarWidget,
  FIXED_STRIP_CSS,
} from '../../packages/electron-taskbar-widget/src/index.js';
import { logTaskbar } from './taskbar-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WIDTH_CHANNEL = 'taskbar:width';
const READY_CHANNEL = 'taskbar:ready';

let lastDoc = null;
let lastPlayback = null;
let lastConfig = null;
// 任务栏左侧封面：按 songPath 去重读取，异步结果用 token 防串台
let lastCover = null;
let coverSongPath = null;
let coverToken = 0;
let ipcBound = false;

const widget = createTaskbarWidget({
  htmlPath: path.join(__dirname, 'taskbar-lyrics.html'),
  preload: path.join(__dirname, '../preload/taskbar-preload.js'),
  fixedLengthCss: FIXED_STRIP_CSS,
  initialWidthCss: 300,
  initialHasContent: false,
  getOwnerWindow: getMainWindow,
  hardenWindow: hardenWebContents,
  logger: logTaskbar,
  onEmbedded: () => {
    pushAllStateToWindow();
  },
  onStateChange: () => {
    if (lastConfig) sendConfig();
  },
  onEnableFailed: (error, { notifyUser }) => {
    console.warn('[taskbar-lyrics] failed to enable taskbar lyrics', error);
    clearCachedCover();
    if (notifyUser) showEnableFailureDialog();
  },
});

function buildConfig() {
  const style = getTaskbarLyricsStyle();
  const lang = getLanguage();
  const hostState = widget.getState();
  return {
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    textColor: style.textColor,
    translationVisible: getLyricsTranslation(),
    verticalTaskbar: hostState.vertical,
    fixedLength: true,
    fixedAlign: hostState.align,
    lightTaskbar: hostState.lightTaskbar,
    labels: {
      appName: lang === 'zh-CN' ? '音梦屿' : 'Dreamisle',
    },
  };
}

function sendConfig() {
  lastConfig = buildConfig();
  widget.send('taskbar:config', lastConfig);
}

function pushAllStateToWindow() {
  sendConfig();
  if (lastDoc) widget.send('taskbar:document', lastDoc);
  if (lastPlayback) widget.send('taskbar:playback', lastPlayback);
  widget.send('taskbar:cover', lastCover);
}

function showEnableFailureDialog() {
  const options = {
    type: 'warning',
    title: t('taskbarLyrics.failedTitle'),
    message: t('taskbarLyrics.failedTitle'),
    detail: t('taskbarLyrics.failedDetail'),
    buttons: [t('common.close')],
    noLink: true,
  };

  try {
    const mainWindow = getMainWindow();
    const pending =
      mainWindow && !mainWindow.isDestroyed()
        ? dialog.showMessageBox(mainWindow, options)
        : dialog.showMessageBox(options);
    pending.catch((error) => {
      console.warn('[taskbar-lyrics] failed to show the warning dialog', error);
    });
  } catch (error) {
    console.warn('[taskbar-lyrics] failed to show the warning dialog', error);
  }
}

function clearCachedCover() {
  coverToken++;
  coverSongPath = null;
  lastCover = null;
}

function buildDocSongMeta(doc) {
  if (!doc?.title) return null;
  return {
    title: doc.title,
    artist: doc.artist || '',
    album: doc.album || null,
    duration: Number.isFinite(doc.duration) ? doc.duration : null,
  };
}

// 仅在任务栏歌词启用时按 songPath 去重读取封面，停用期间不做无谓解码与缓存滞留
function ensureCoverLoaded() {
  const songPath = lastDoc?.songPath || null;
  if (!widget.isEnabled()) {
    if (coverSongPath !== null || lastCover !== null) clearCachedCover();
    return;
  }
  if (songPath === coverSongPath) return;
  coverSongPath = songPath;
  coverToken++;
  if (songPath) {
    loadCover(songPath, buildDocSongMeta(lastDoc), coverToken);
  } else {
    lastCover = null;
    widget.send('taskbar:cover', null);
  }
}

// 复用主封面磁盘/内存缓存：优先直接下发稳定 dream-thumb:// URL；
// 仅在缩略图目录不可写退回原始 buffer 时再用 data URL 兜底。
async function loadCover(songPath, songMeta, token) {
  try {
    const cover = await readCover(songPath, getMusicFolders(), songMeta);
    if (token !== coverToken || !widget.isEnabled()) return;
    if (typeof cover === 'string' && cover.length > 0) {
      lastCover = cover;
      widget.send('taskbar:cover', lastCover);
      return;
    }
    if (!cover?.buffer) {
      lastCover = null;
      widget.send('taskbar:cover', null);
      return;
    }
    const rawBuf = Buffer.isBuffer(cover.buffer) ? cover.buffer : Buffer.from(cover.buffer);
    const image = nativeImage.createFromBuffer(rawBuf);
    if (!image.isEmpty()) {
      lastCover = image.resize({ height: 72, quality: 'good' }).toDataURL();
      widget.send('taskbar:cover', lastCover);
      return;
    }
    const mime =
      typeof cover.format === 'string' && cover.format.startsWith('image/')
        ? cover.format
        : 'image/jpeg';
    lastCover = `data:${mime};base64,${rawBuf.toString('base64')}`;
    widget.send('taskbar:cover', lastCover);
  } catch (error) {
    if (token !== coverToken || !widget.isEnabled()) return;
    console.warn('[taskbar-lyrics] failed to read the cover', error);
    lastCover = null;
    widget.send('taskbar:cover', null);
  }
}

// 主窗口异步匹配到在线封面（例如插件刚启动或刚为本地无封面歌曲拉到封面）时，同步刷新任务栏封面
export function syncTaskbarLyricsCover(songPath, coverUrl) {
  if (!widget.isEnabled()) return;
  if (!songPath || typeof coverUrl !== 'string' || !coverUrl) return;
  if (lastDoc?.songPath !== songPath) return;
  if (lastCover === coverUrl) return;
  coverSongPath = songPath;
  coverToken++;
  lastCover = coverUrl;
  widget.send('taskbar:cover', lastCover);
}

function isWidgetSender(event) {
  const win = widget.getWindow();
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
}

function bindIpcOnce() {
  if (ipcBound) return;
  ipcBound = true;

  ipcMain.on(WIDTH_CHANNEL, (event, px) => {
    if (!isWidgetSender(event)) return;
    widget.setContentWidth(px);
  });

  ipcMain.on(READY_CHANNEL, (event) => {
    if (!isWidgetSender(event)) return;
    pushAllStateToWindow();
    widget.refresh();
  });
}

function enableRuntime({ notifyUser }) {
  bindIpcOnce();
  const ok = widget.enable({ notifyUser });
  if (ok) ensureCoverLoaded();
  return ok;
}

function disableRuntime() {
  clearCachedCover();
  widget.disable();
}

export function bindTaskbarLyricsIpc() {
  bindIpcOnce();
}

export function initTaskbarLyrics() {
  try {
    bindIpcOnce();
    if (process.platform !== 'win32') return;
    if (!getTaskbarLyricsSetting()) return;
    if (widget.isRunning()) return;
    // 启动恢复：失败只记日志，保持持久化设置不变，也不弹窗
    enableRuntime({ notifyUser: false });
  } catch (error) {
    console.warn('[taskbar-lyrics] failed to initialize taskbar lyrics', error);
    clearCachedCover();
    widget.dispose();
  }
}

// 开关/托盘展示的是持久化偏好：本次运行启动失败不改写用户的选择。
export function isTaskbarLyricsEnabled() {
  return process.platform === 'win32' && getTaskbarLyricsSetting();
}

// 设置页区分「用户想开」和「本次运行实际在跑」
export function isTaskbarLyricsRunning() {
  return widget.isRunning();
}

export function setTaskbarLyricsEnabled(value) {
  if (process.platform !== 'win32') return false;
  const next = !!value;
  setTaskbarLyricsSetting(next);

  try {
    if (next) {
      if (!widget.isRunning()) enableRuntime({ notifyUser: true });
    } else {
      disableRuntime();
    }
  } catch (error) {
    console.warn('[taskbar-lyrics] failed to apply the taskbar lyrics setting', error);
    clearCachedCover();
    widget.dispose();
    if (next) showEnableFailureDialog();
  }

  return getTaskbarLyricsSetting();
}

export function updateTaskbarLyricsDocument(doc) {
  lastDoc = doc || null;
  ensureCoverLoaded();
  if (lastDoc) widget.send('taskbar:document', lastDoc);
  widget.setHasContent(!!lastDoc?.songPath);
}

export function updateTaskbarLyricsPlayback(state) {
  lastPlayback = state || null;
  if (lastPlayback) widget.send('taskbar:playback', lastPlayback);
}

export function updateTaskbarLyricsStyle() {
  sendConfig();
  return lastConfig;
}

export function updateTaskbarLyricsTranslation(visibleValue) {
  lastConfig = { ...buildConfig(), translationVisible: !!visibleValue };
  widget.send('taskbar:config', lastConfig);
}

export function refreshTaskbarLyricsConfig() {
  sendConfig();
  return lastConfig;
}

export function disposeTaskbarLyrics() {
  clearCachedCover();
  widget.dispose();
}
