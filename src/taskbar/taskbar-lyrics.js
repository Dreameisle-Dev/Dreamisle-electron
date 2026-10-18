import { BrowserWindow, dialog, ipcMain, nativeImage, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMainWindow } from '../main/window.js';
import { readCover } from '../main/music-library.js';
import {
  getLanguage,
  getLyricsStyle,
  getLyricsTranslation,
  getTaskbarLyricsSetting,
  setTaskbarLyricsSetting,
} from '../main/store.js';
import { t } from '../shared/i18n.js';
import {
  assertTopChild,
  embedWindow,
  findTaskbar,
  findTrayNotify,
  getNativeHwnd,
  getTaskbarMetrics,
  getTaskbarWindowsFingerprint,
  getWindowRect,
  isFullscreenForeground,
  isWindow,
  readSystemUsesLightTheme,
  readTaskbarAlignment,
  setWindowBounds,
} from './taskbar-win32.js';
import {
  clampWindowWidth,
  DOCK_MARGIN_CSS,
  isBottomTaskbar,
  selectGap,
  shouldCoalesceProbe,
  shouldShow,
  sideFor,
} from './taskbar-gap.js';
import { probeTaskbar } from './gap-probe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WIDTH_CHANNEL = 'taskbar:width';
const READY_CHANNEL = 'taskbar:ready';
// UIA 失败时的兜底位置：贴着托盘通知区左侧留 12 CSS px
const FALLBACK_MARGIN_CSS = 12;
// 渲染进程崩溃/嵌入失败后的重建延迟（brief：render-process-gone 后 1s）
const RECREATE_DELAY_MS = 1000;
// 任务栏巡检：每 2s 看 z-order/任务栏存活/指纹/主题/对齐，每 1s 看一次前台全屏，
// 每 60s 无条件补测一次空档
const POLL_INTERVAL_MS = 2000;
const FULLSCREEN_INTERVAL_MS = 1000;
const PROBE_HEARTBEAT_MS = 60000;
const PROBE_DEBOUNCE_MS = 500;
const MIN_PROBE_INTERVAL_MS = 5000;

// 窗口与嵌入状态。hwnd/trayHwnd 是 BigInt（koffi 返回的原生句柄）
let win = null;
let hwnd = null;
let trayHwnd = null;
let enabled = false;
let visible = false;
let fullscreen = false;
let lastDoc = null;
let lastPlayback = null;
let lastConfig = null;
// 任务栏左侧封面：按 songPath 去重读取，异步结果用 token 防串台
let lastCover = null;
let coverSongPath = null;
let coverToken = 0;
// 没有歌曲时隐藏歌词条（Task 4 的占位状态下它始终可见）
let hasSong = false;
let widthCss = 300;
// 当前空档：{ side, gap: { left, right }, dpi, height }；left/right 为 CSS px，
// height 为任务栏客户区物理高度
let currentGap = null;
// UIA 探测失败时保留的任务栏 metrics，用于托盘通知区左侧的固定兜底；成功探测后清空
let fallbackMetrics = null;
// 最近一次 SetWindowPos 的物理 bounds：避免宽度回报/resize 反馈循环
let lastBounds = null;
// 任务栏明暗：UIA 探测值优先，缺失时现场读注册表
let lightTaskbar = null;

// 巡检与探测调度状态
let pollTimer = null;
let fullscreenTimer = null;
let heartbeatTimer = null;
let probeDebounceTimer = null;
let probeInFlight = null;
// 当前探测对应的窗口键（`${hwnd}:${trayHwnd}`）；窗口重建后旧探测不能被新请求合并
let probeInFlightKey = null;
// 同一窗口的探测进行中又有请求：结束后补跑一次，避免丢掉指纹变化
let probeRerunRequested = false;
let lastProbeAt = 0;
let lastFingerprint = null;
let lastLightTheme = null;
let lastAlignment = null;

let recreateTimer = null;
let ipcBound = false;

function isWindowAlive(window) {
  return window !== null && !window.isDestroyed() && !window.webContents.isDestroyed();
}

// 可见性判定的 windowAlive：Electron 窗口和它嵌进任务栏的原生子窗口都得还在
function stripWindowAlive() {
  return isWindowAlive(win) && hwnd !== null && isWindow(hwnd);
}

function sendToWindow(channel, payload) {
  if (!isWindowAlive(win)) return;
  win.webContents.send(channel, payload);
}

// 配置里只放渲染进程需要的样式信息：字体、翻译开关、任务栏明暗、语言相关文案。
function buildConfig() {
  const style = getLyricsStyle();
  const lang = getLanguage();
  return {
    fontFamily: style.fontFamily || '',
    translationVisible: getLyricsTranslation(),
    lightTaskbar: lightTaskbar ?? readSystemUsesLightTheme() ?? true,
    labels: {
      appName: lang === 'zh-CN' ? '音梦屿' : 'Dreamisle',
    },
  };
}

function sendConfig() {
  lastConfig = buildConfig();
  sendToWindow('taskbar:config', lastConfig);
}

// 主题变化时重发配置；值没变就不打扰渲染进程
function setLightTaskbar(value) {
  const next = value !== false;
  if (lightTaskbar === next) return;
  lightTaskbar = next;
  if (lastConfig) sendConfig();
}

function sameBounds(a, b) {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// 主显示器的物理像素 bounds：全屏判定用物理坐标，与 GetWindowRect 一致。
// 另一个显示器上的全屏窗口覆盖不到这组 bounds，因此不会隐藏主屏歌词条。
// 宽度/高度用 floor：Electron 的 DIP bounds 是整数（本机 2560/1.5=1706.67 → 1707），
// 乘回 scaleFactor 再 round 会得到 2561，比真实屏幕宽 1px，恰好铺满的全屏窗口会被漏判。
function primaryDisplayBounds() {
  const display = screen.getPrimaryDisplay();
  return {
    x: Math.round(display.bounds.x * display.scaleFactor),
    y: Math.round(display.bounds.y * display.scaleFactor),
    width: Math.floor(display.bounds.width * display.scaleFactor),
    height: Math.floor(display.bounds.height * display.scaleFactor),
  };
}

// 每 1s 更新前台全屏状态；状态翻转时才动窗口
function refreshFullscreen() {
  if (!enabled) return;

  let next = false;
  try {
    next = isFullscreenForeground({ trayHwnd, ownHwnd: hwnd, bounds: primaryDisplayBounds() });
  } catch (error) {
    console.warn('[taskbar-lyrics] fullscreen detection failed', error);
  }

  if (next === fullscreen) return;
  fullscreen = next;
  updateVisibility();

  // 退出全屏：补一次探测，过期空档尽快得到修正
  if (!fullscreen && enabled && hasSong) probeAndApply();
}

// 可见性状态机：UIA 空档或托盘左侧兜底都算可用位置，两者都没有才隐藏。
// 纯函数在 taskbar-gap.js 里，单测覆盖各种门控条件。
function computeWantVisible() {
  return shouldShow({
    enabled,
    hasSong,
    fullscreen,
    hasGap: !!currentGap,
    hasFallback: !!fallbackMetrics,
    windowAlive: stripWindowAlive(),
  });
}

// 显示：showInactive → applyPosition → assertTopChild。
// 隐藏只 hide，不销毁窗口；销毁只发生在关闭功能或退出应用时。
function updateVisibility() {
  if (!isWindowAlive(win)) {
    visible = false;
    return;
  }

  if (!computeWantVisible()) {
    if (win.isVisible()) win.hide();
    visible = false;
    return;
  }

  const wasShown = win.isVisible();
  if (!wasShown) win.showInactive();
  visible = true;
  applyPosition(!wasShown);
  assertTopChild(hwnd);
}

// UIA 失败兜底：贴着托盘通知区左侧；找不到通知区就贴着任务栏右端。
// 兜底也绝不能超出任务栏：宽度最多是任务栏宽减去两侧 12 CSS，x 夹在任务栏范围内。
// 兜底位置是可显示位置（design §6/§10）：UIA 失败时仍然显示，而不是藏起来。
function applyFallbackPosition(metrics, force) {
  const dpi = metrics.dpiScale || 1;
  const taskbarWidthCss = metrics.clientWidth / dpi;
  const desiredWidthCss = clampWindowWidth({ contentWidthCss: widthCss, gapWidthCss: 99999 });
  const windowWidthCss = Math.min(desiredWidthCss, taskbarWidthCss - 2 * FALLBACK_MARGIN_CSS);
  if (windowWidthCss <= 0) return false;
  const widthPx = Math.round(windowWidthCss * dpi);
  const notifyRect = getWindowRect(findTrayNotify(trayHwnd));
  const rawX = notifyRect
    ? notifyRect.left - metrics.screenLeft - widthPx - Math.round(FALLBACK_MARGIN_CSS * dpi)
    : metrics.clientWidth - widthPx - Math.round(FALLBACK_MARGIN_CSS * dpi);
  const x = Math.min(Math.max(0, rawX), Math.max(0, metrics.clientWidth - widthPx));
  const next = { x, y: 0, width: widthPx, height: metrics.clientHeight };

  if (!force && sameBounds(lastBounds, next)) return true;
  if (!setWindowBounds(hwnd, next)) return false;
  lastBounds = next;
  return true;
}

// 只计算并设置 bounds；显示/隐藏由 updateVisibility 统一负责。
function applyPosition(force = false) {
  if (!hwnd || !trayHwnd) return false;

  if (!currentGap) {
    if (fallbackMetrics) return applyFallbackPosition(fallbackMetrics, force);
    return false;
  }

  const { side, gap, dpi, height } = currentGap;
  const windowWidthCss = clampWindowWidth({
    contentWidthCss: widthCss,
    gapWidthCss: gap.right - gap.left,
  });
  if (windowWidthCss === 0) return false;

  const xPx = Math.round(
    (gap.left +
      (side === 'left'
        ? DOCK_MARGIN_CSS
        : gap.right - gap.left - DOCK_MARGIN_CSS - windowWidthCss)) *
      dpi
  );
  const next = {
    x: xPx,
    y: 0,
    width: Math.round(windowWidthCss * dpi),
    height,
  };

  if (!force && sameBounds(lastBounds, next)) return true;
  if (!setWindowBounds(hwnd, next)) return false;
  lastBounds = next;
  return true;
}

// 跑一次 UIA 探测并更新 currentGap；probe 为 null 时退回托盘左侧兜底。
// 返回值只表示本次调用是否找到了可用空档（用于调试，不影响调用方）。
async function resolveGap() {
  const expectedHwnd = hwnd;
  const expectedTray = trayHwnd;
  const probe = await probeTaskbar();

  // 探测期间窗口可能被重建/关闭，结果直接丢弃
  if (!enabled || !hwnd || !trayHwnd || hwnd !== expectedHwnd || trayHwnd !== expectedTray) {
    return false;
  }

  const metrics = getTaskbarMetrics(trayHwnd);
  if (!metrics) {
    currentGap = null;
    fallbackMetrics = null;
    updateVisibility();
    return false;
  }

  if (!probe) {
    currentGap = null;
    fallbackMetrics = metrics;
    updateVisibility();
    return false;
  }

  const dpi = metrics.dpiScale || 1;
  const taskbarWidthCss = metrics.clientWidth / dpi;
  const taskbarHeightCss = metrics.clientHeight / dpi;
  const buttonsCss = probe.buttons.map((button) => ({
    x: (button.x - metrics.screenLeft) / dpi,
    w: button.w / dpi,
    h: button.h / dpi,
  }));

  let side = sideFor({ osBuild: probe.osBuild, taskbarAl: probe.taskbarAl });
  const gapInput = {
    taskbarWidth: taskbarWidthCss,
    taskbarHeight: taskbarHeightCss,
    buttons: buttonsCss,
  };
  let gap = selectGap({ ...gapInput, side });
  if (!gap) {
    // 首选半边没有可用空档：显式再试另一边（selectGap 内部也有同样的降级）
    const otherSide = side === 'left' ? 'right' : 'left';
    gap = selectGap({ ...gapInput, side: otherSide });
    if (gap) side = otherSide;
  }

  setLightTaskbar(probe.lightTaskbar ?? readSystemUsesLightTheme() ?? true);

  if (!gap) {
    // 没有可用空档：隐藏而不是压在任务栏图标上；60s 心跳会继续尝试
    currentGap = null;
    fallbackMetrics = null;
    updateVisibility();
    return false;
  }

  fallbackMetrics = null;
  currentGap = { side, gap, dpi, height: metrics.clientHeight };
  updateVisibility();
  return true;
}

// 所有探测都经这里串行化；错误只记录日志，保留上一次可用的空档。
// 探测与窗口键绑定：窗口重建后旧探测可能还在飞，新窗口必须另起一次探测，
// 不能合并进旧 promise（旧结果会被 resolveGap 的 identity guard 丢弃）。
function probeAndApply() {
  if (!enabled || !hwnd || !trayHwnd) return Promise.resolve(false);

  const requestedKey = `${hwnd}:${trayHwnd}`;

  if (probeInFlight) {
    if (shouldCoalesceProbe(probeInFlightKey, requestedKey)) {
      // 同一窗口：合并请求，并在当前探测结束后补跑一次
      probeRerunRequested = true;
      return probeInFlight;
    }
    // 不同窗口：旧探测继续跑但结果会被丢弃，这里为新窗口启动新探测
  }

  probeRerunRequested = false;
  lastProbeAt = Date.now();

  const promise = (async () => {
    try {
      return await resolveGap();
    } catch (error) {
      console.warn('[taskbar-lyrics] taskbar probe failed; keeping the last good gap', error);
      return false;
    } finally {
      // 只有当前探测才能清状态；旧探测结束时不能动新探测
      if (probeInFlight === promise) {
        probeInFlight = null;
        probeInFlightKey = null;
        if (probeRerunRequested) {
          probeRerunRequested = false;
          probeAndApply();
        }
      }
    }
  })();

  probeInFlight = promise;
  probeInFlightKey = requestedKey;
  return promise;
}

// 指纹变化后防抖 500ms，且两次探测间隔不少于 5s
function scheduleProbe() {
  if (!enabled) return;
  clearTimeout(probeDebounceTimer);
  const sinceLastProbe = Date.now() - lastProbeAt;
  const delay = Math.max(PROBE_DEBOUNCE_MS, MIN_PROBE_INTERVAL_MS - sinceLastProbe);
  probeDebounceTimer = setTimeout(() => {
    probeDebounceTimer = null;
    probeAndApply();
  }, delay);
}

function pollTaskbarState() {
  if (!enabled) return;
  try {
    // 可见时每 2s 把歌词条拉回任务栏子窗口的 z-order 顶端
    if (visible && hwnd && isWindow(hwnd)) assertTopChild(hwnd);

    // explorer 重启后旧 Shell_TrayWnd 和它的子窗口都会失效；HWND 可能被复用，
    // 所以任务栏句柄和我们自己的子窗口句柄都要检查。
    if ((trayHwnd && !isWindow(trayHwnd)) || (hwnd && !isWindow(hwnd))) {
      recreateWindow();
      return;
    }

    const fingerprint = getTaskbarWindowsFingerprint();
    if (fingerprint !== null) {
      if (lastFingerprint !== null && fingerprint !== lastFingerprint) scheduleProbe();
      lastFingerprint = fingerprint;
    }

    const light = readSystemUsesLightTheme();
    if (light !== null) {
      if (lastLightTheme !== null && light !== lastLightTheme) setLightTaskbar(light);
      lastLightTheme = light;
    }

    const alignment = readTaskbarAlignment();
    if (alignment !== null) {
      if (lastAlignment !== null && alignment !== lastAlignment) probeAndApply();
      lastAlignment = alignment;
    }
  } catch (error) {
    console.warn('[taskbar-lyrics] failed to poll taskbar state', error);
  }
}

// 分辨率/DPI/主显示器变化后任务栏的物理 metrics 和空档都会过期：
// 清掉 bounds 缓存并立刻重测，而不是等指纹变化或 60s 心跳。
function onDisplayMetrics() {
  lastBounds = null;
  probeAndApply();
}

function startMonitors() {
  stopMonitors();
  // 以当前状态作为基线，之后只对真正的变化做出反应
  lastFingerprint = getTaskbarWindowsFingerprint();
  lastLightTheme = readSystemUsesLightTheme();
  lastAlignment = readTaskbarAlignment();

  pollTimer = setInterval(pollTaskbarState, POLL_INTERVAL_MS);
  fullscreenTimer = setInterval(refreshFullscreen, FULLSCREEN_INTERVAL_MS);
  heartbeatTimer = setInterval(() => {
    // 全屏/无歌时暂停 60s 探测；因为「没有可用空档」而隐藏时继续探测，
    // 这样之后出现的空档能把歌词条带回来。
    if (enabled && hasSong && !fullscreen) probeAndApply();
  }, PROBE_HEARTBEAT_MS);

  // 主显示器切换会改变 Shell_TrayWnd 所在的屏幕，worker area 变化同理
  screen.on('display-metrics-changed', onDisplayMetrics);
  screen.on('display-added', onDisplayMetrics);
  screen.on('display-removed', onDisplayMetrics);
}

function stopMonitors() {
  clearInterval(pollTimer);
  pollTimer = null;
  clearInterval(fullscreenTimer);
  fullscreenTimer = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clearTimeout(probeDebounceTimer);
  probeDebounceTimer = null;
  fullscreen = false;
  screen.removeListener('display-metrics-changed', onDisplayMetrics);
  screen.removeListener('display-added', onDisplayMetrics);
  screen.removeListener('display-removed', onDisplayMetrics);
}

function scheduleRecreate() {
  if (!enabled) return;
  clearTimeout(recreateTimer);
  recreateTimer = setTimeout(() => {
    recreateTimer = null;
    if (enabled) recreateWindow();
  }, RECREATE_DELAY_MS);
}

function destroyWindow() {
  // 先把引用清空，closed 处理器看到 win !== next 就不会再触发重建
  const current = win;
  win = null;
  hwnd = null;
  trayHwnd = null;
  visible = false;
  currentGap = null;
  fallbackMetrics = null;
  lastBounds = null;
  // 窗口没了，旧窗口的补跑请求也作废（旧 promise 的 finally 有 identity guard）
  probeRerunRequested = false;
  if (current && !current.isDestroyed()) current.destroy();
}

// 销毁旧窗口、清空引用、重新创建并嵌入；新窗口加载完成后会重发配置/文档/播放状态。
function recreateWindow() {
  if (!enabled) return;
  clearTimeout(recreateTimer);
  recreateTimer = null;
  try {
    destroyWindow();
    createWindow({ pending: false, notifyUser: false });
  } catch (error) {
    // 重建失败不能让主进程崩溃；保留状态，1s 后再试
    console.warn('[taskbar-lyrics] failed to recreate the taskbar window', error);
    destroyWindow();
    scheduleRecreate();
  }
}

// 首次启用时嵌入失败 = 启用失败：本次运行停用、按用户触发与否决定是否弹窗；
// 重建路径则保留 1s 重试（explorer 重启期间任务栏可能短暂不存在）。
function handleEmbedFailure(context, message) {
  if (context.pending) {
    failEnablement(new Error(message), context.notifyUser);
    return;
  }
  console.warn(`[taskbar-lyrics] ${message}; retrying`);
  scheduleRecreate();
}

// 本次运行的启用失败清理。绝不改写持久化设置。
function failEnablement(error, notifyUser) {
  console.warn('[taskbar-lyrics] failed to enable taskbar lyrics', error);
  enabled = false;
  stopMonitors();
  clearTimeout(recreateTimer);
  recreateTimer = null;
  destroyWindow();
  if (notifyUser) showEnableFailureDialog();
}

function createWindow(context = {}) {
  if (isWindowAlive(win)) return;

  // pending 表示这是用户/启动恢复的首次启用，尚未成功嵌入；
  // 此时任何嵌入失败都按启用失败处理。成功嵌入后转为普通重建语义。
  const windowContext = {
    pending: context.pending === true,
    notifyUser: context.notifyUser === true,
  };

  clearTimeout(recreateTimer);
  recreateTimer = null;

  const next = new BrowserWindow({
    width: 600,
    height: 48,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/taskbar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win = next;
  hwnd = null;
  trayHwnd = null;
  visible = false;
  // 新窗口的默认 bounds 与旧窗口无关，旧的缓存必须作废
  currentGap = null;
  fallbackMetrics = null;
  lastBounds = null;

  next.loadFile(path.join(__dirname, 'taskbar-lyrics.html'));

  next.webContents.on('did-finish-load', () => {
    if (win !== next || next.isDestroyed()) return;

    const nextHwnd = getNativeHwnd(next);
    const nextTrayHwnd = findTaskbar();
    if (!nextHwnd || !nextTrayHwnd) {
      handleEmbedFailure(windowContext, 'taskbar window not found');
      return;
    }
    if (!embedWindow(nextHwnd, nextTrayHwnd)) {
      handleEmbedFailure(windowContext, 'failed to embed the strip into Shell_TrayWnd');
      return;
    }

    // 嵌入成功：此后的 closed/render-process-gone 走重建而不是启用失败
    windowContext.pending = false;
    hwnd = nextHwnd;
    trayHwnd = nextTrayHwnd;

    sendConfig();
    if (lastDoc) sendToWindow('taskbar:document', lastDoc);
    if (lastPlayback) sendToWindow('taskbar:playback', lastPlayback);
    sendToWindow('taskbar:cover', lastCover);

    // 有歌曲且已有可用空档时先按快照显示，探测结果回来后再修正
    updateVisibility();
    probeAndApply();
  });

  next.on('closed', () => {
    if (win !== next) return;
    win = null;
    hwnd = null;
    trayHwnd = null;
    visible = false;
    currentGap = null;
    fallbackMetrics = null;
    lastBounds = null;
    if (!enabled) return;
    if (windowContext.pending) {
      failEnablement(new Error('taskbar window closed before embedding'), windowContext.notifyUser);
    } else {
      recreateWindow();
    }
  });

  next.webContents.on('render-process-gone', () => {
    if (win !== next) return;
    if (windowContext.pending) {
      failEnablement(
        new Error('renderer exited before the strip was embedded'),
        windowContext.notifyUser
      );
      return;
    }
    // 崩溃的窗口先销毁，1s 后重建
    destroyWindow();
    scheduleRecreate();
  });
}

function notifyMainRenderer(next) {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('taskbar-lyrics:changed', next);
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
    // 主进程不等待用户点「关闭」；对话框失败也只记日志
    pending.catch((error) => {
      console.warn('[taskbar-lyrics] failed to show the warning dialog', error);
    });
  } catch (error) {
    console.warn('[taskbar-lyrics] failed to show the warning dialog', error);
  }
}

// 启动运行时功能。抛出的/捕获的失败都不会改写持久化设置。
// notifyUser 只在用户主动打开开关时为 true（启动恢复失败不弹窗打扰）。
function enableRuntime({ notifyUser }) {
  try {
    const tray = findTaskbar();
    if (!tray) {
      throw new Error(
        'Shell_TrayWnd not found; native helpers are unavailable or the taskbar is missing'
      );
    }
    const metrics = getTaskbarMetrics(tray);
    if (!metrics) {
      // getTaskbarMetrics 对竖排任务栏返回 null（宽度不大于高度视为不支持）
      throw new Error(
        'taskbar metrics unavailable; the taskbar is not horizontal or native helpers failed'
      );
    }
    // 顶部任务栏同样不支持：只接受贴着主显示器底边的横排任务栏
    if (!isBottomTaskbar(metrics.windowRect, primaryDisplayBounds())) {
      throw new Error(
        'taskbar is not docked at the bottom of the primary display; top/side taskbars are unsupported'
      );
    }

    enabled = true;
    bindIpcOnce();
    startMonitors();
    // 首次启用：嵌入是异步完成的，did-finish-load 里的失败会走 failEnablement
    createWindow({ pending: true, notifyUser });
    return true;
  } catch (error) {
    failEnablement(error, notifyUser);
    return false;
  }
}

function disableRuntime() {
  enabled = false;
  stopMonitors();
  clearTimeout(recreateTimer);
  recreateTimer = null;
  destroyWindow();
}

function bindIpcOnce() {
  if (ipcBound) return;
  ipcBound = true;

  ipcMain.on(WIDTH_CHANNEL, (event, px) => {
    if (!isWindowAlive(win) || event.sender !== win.webContents) return;
    const width = Number(px);
    if (!Number.isFinite(width) || width <= 0) return;
    widthCss = Math.max(1, Math.round(width));
    updateVisibility();
  });

  ipcMain.on(READY_CHANNEL, (event) => {
    if (!isWindowAlive(win) || event.sender !== win.webContents) return;
    sendConfig();
    if (lastDoc) sendToWindow('taskbar:document', lastDoc);
    if (lastPlayback) sendToWindow('taskbar:playback', lastPlayback);
    sendToWindow('taskbar:cover', lastCover);
    updateVisibility();
    probeAndApply();
  });
}

export function initTaskbarLyrics() {
  try {
    bindIpcOnce();
    if (!getTaskbarLyricsSetting()) return;
    // 启动恢复：失败只记日志，保持持久化设置不变，也不弹窗
    enableRuntime({ notifyUser: false });
  } catch (error) {
    console.warn('[taskbar-lyrics] failed to initialize taskbar lyrics', error);
    enabled = false;
    stopMonitors();
    destroyWindow();
  }
}

// 开关/托盘展示的是持久化偏好：本次运行启动失败不改写用户的选择。
export function isTaskbarLyricsEnabled() {
  return getTaskbarLyricsSetting();
}

export function setTaskbarLyricsEnabled(value) {
  const next = !!value;
  // 先记录用户意图；失败时绝不把它改回去
  setTaskbarLyricsSetting(next);

  try {
    if (next) {
      if (!(enabled && isWindowAlive(win))) enableRuntime({ notifyUser: true });
    } else {
      disableRuntime();
    }
  } catch (error) {
    // enableRuntime 自己会兜底；这里再挡一层，保证异常不会冒泡到 IPC/tray
    console.warn('[taskbar-lyrics] failed to apply the taskbar lyrics setting', error);
    enabled = false;
    stopMonitors();
    destroyWindow();
    if (next) showEnableFailureDialog();
  }

  notifyMainRenderer(getTaskbarLyricsSetting());
  return getTaskbarLyricsSetting();
}

// 读取并缩放封面。72px 高足够 36 CSS px 的条在 200% DPI 下清晰；
// 用 data URL 传给渲染进程，避免 blob/临时文件的生命周期问题。
async function loadCover(songPath, token) {
  try {
    const cover = await readCover(songPath);
    if (token !== coverToken) return;
    if (!cover?.buffer) {
      lastCover = null;
      sendToWindow('taskbar:cover', null);
      return;
    }
    const image = nativeImage.createFromBuffer(Buffer.from(cover.buffer));
    if (image.isEmpty()) {
      lastCover = null;
      sendToWindow('taskbar:cover', null);
      return;
    }
    lastCover = image.resize({ height: 72, quality: 'good' }).toDataURL();
    sendToWindow('taskbar:cover', lastCover);
  } catch (error) {
    if (token !== coverToken) return;
    console.warn('[taskbar-lyrics] failed to read the cover', error);
    lastCover = null;
    sendToWindow('taskbar:cover', null);
  }
}

export function updateTaskbarLyricsDocument(doc) {
  lastDoc = doc || null;
  const hadSong = hasSong;
  hasSong = !!lastDoc?.songPath;

  // 切歌才重新读封面；歌词文档在占位/完整之间更新时 songPath 不变，不重复读
  const songPath = lastDoc?.songPath || null;
  if (songPath !== coverSongPath) {
    coverSongPath = songPath;
    coverToken++;
    if (songPath) {
      loadCover(songPath, coverToken);
    } else {
      lastCover = null;
      sendToWindow('taskbar:cover', null);
    }
  }

  if (lastDoc) sendToWindow('taskbar:document', lastDoc);
  // 文档可能在窗口创建前到达：有 songPath 且有空档就显示，空文档（空库复位）就隐藏
  updateVisibility();
  // 从无歌（隐藏）转为有歌：补一次探测，避免沿用陈旧的空档
  if (!hadSong && hasSong && enabled) probeAndApply();
}

export function updateTaskbarLyricsPlayback(state) {
  lastPlayback = state || null;
  if (lastPlayback) sendToWindow('taskbar:playback', lastPlayback);
}

export function updateTaskbarLyricsStyle(style) {
  const fontFamily =
    typeof (style && style.fontFamily) === 'string'
      ? style.fontFamily
      : getLyricsStyle().fontFamily;
  lastConfig = { ...buildConfig(), fontFamily };
  sendToWindow('taskbar:config', lastConfig);
}

export function updateTaskbarLyricsTranslation(visibleValue) {
  lastConfig = { ...buildConfig(), translationVisible: !!visibleValue };
  sendToWindow('taskbar:config', lastConfig);
}

export function refreshTaskbarLyricsConfig() {
  sendConfig();
  return lastConfig;
}

export function disposeTaskbarLyrics() {
  enabled = false;
  stopMonitors();
  clearTimeout(recreateTimer);
  recreateTimer = null;
  destroyWindow();
}
