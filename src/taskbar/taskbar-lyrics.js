import { BrowserWindow, dialog, ipcMain, nativeImage, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMainWindow } from '../main/window.js';
import { readCover } from '../main/music-library.js';
import {
  getLanguage,
  getLyricsTranslation,
  getTaskbarLyricsSetting,
  getTaskbarLyricsStyle,
  setTaskbarLyricsSetting,
} from '../main/store.js';
import { t } from '../shared/i18n.js';
import {
  assertTopChild,
  embedWindow,
  findTaskbar,
  findTrayNotify,
  getMonitorRect,
  getNativeHwnd,
  getNativeInitError,
  getOsBuild,
  getTaskbarMetrics,
  getTaskbarWindowsFingerprint,
  getWindowAncestor,
  getWindowMonitor,
  getWindowParent,
  getWindowRect,
  getWindowStyleInfo,
  hideWindow,
  isFullscreenForeground,
  isWindow,
  isWindowVisible,
  listTaskbars,
  readSystemUsesLightTheme,
  readTaskbarAlignment,
  setWindowBounds,
} from './taskbar-win32.js';
import {
  clampWindowWidth,
  DOCK_MARGIN_CSS,
  FIXED_STRIP_CSS,
  selectGap,
  shouldCoalesceProbe,
  shouldShow,
  sideFor,
} from './taskbar-gap.js';
import {
  applyLegacyLayout,
  isLegacyWindows,
  legacyLayoutUsable,
  resetLegacyLayout,
  restoreLegacyTaskList,
} from './taskbar-legacy.js';
import { logTaskbar } from './taskbar-log.js';
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
// 当前歌词条是否竖排（Win10 左/右任务栏）。渲染进程据此切换 writing-mode。
let verticalTaskbar = false;
// 固定长度歌词条的文字对齐：左侧空档 start，右侧/竖排 end。
let fixedAlign = 'end';

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
// 任务栏尺寸（缩放/分辨率）变化后，Chromium 的透明窗口 surface 只缩不涨；
// 等尺寸稳定后重建一次歌词窗，才能拿到与任务栏高度匹配的新 surface。
let metricsRecreateTimer = null;
let lastTaskbarMetrics = null;
// 上一次成功应用的「内容区尺寸 + 父窗口坐标」，用来避免每 2s 重复 setContentSize。
let lastWindowKey = null;
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
  const style = getTaskbarLyricsStyle();
  const lang = getLanguage();
  return {
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    textColor: style.textColor,
    translationVisible: getLyricsTranslation(),
    verticalTaskbar,
    fixedLength: true,
    fixedAlign,
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

// 固定长度歌词条：文字对齐到空档靠外的一侧（左侧空档左对齐，右侧/竖排右对齐）。
function setFixedAlign(next) {
  const value = next === 'start' ? 'start' : 'end';
  if (value === fixedAlign) return;
  fixedAlign = value;
  if (lastConfig) sendConfig();
}

// 按参考项目 EmbeddedTaskbarAnchor.Position 的顺序：
// 1) 框架先设内容区尺寸（WPF window.Width/Height ↔ Electron setContentSize）；
// 2) 读 setContentSize 之后原生窗口的实际尺寸（含 Electron 补的不可见边框）；
// 3) 用 SetWindowPos 以 Shell_TrayWnd 客户区坐标摆回嵌入窗口（Win10 popup / Win11 child）。
// setContentSize 会按 Electron 记录的屏幕坐标把窗口重摆一次，所以第 3 步必须
// 用原生位置纠正；这也是参考项目里“框架尺寸 + 原生位置”的分工。
function applyWindowBounds(base, dpi, force) {
  if (!isWindowAlive(win)) return false;
  const scale = Number.isFinite(dpi) && dpi > 0 ? dpi : 1;
  const contentWidth = Math.max(1, Math.round(base.width / scale));
  const contentHeight = Math.max(1, Math.round(base.height / scale));
  // Win10 现在是不 SetParent 的顶层 overlay：SetWindowPos 用屏幕坐标。
  // legacy/UIA/fallback 传来的 bounds 都是相对任务栏客户区，这里加屏幕原点。
  // Win11 仍是任务栏子窗口，保持父客户区坐标。
  const legacy = isLegacyWindows();
  const taskbarMetrics = legacy && trayHwnd ? getTaskbarMetrics(trayHwnd) : null;
  const x = base.x + (taskbarMetrics ? taskbarMetrics.screenLeft : 0);
  const y = base.y + (taskbarMetrics ? taskbarMetrics.screenTop : 0);
  const key = `${scale}:${x},${y},${contentWidth}x${contentHeight}`;
  if (!force && key === lastWindowKey) return true;

  let nativeRect = null;
  try {
    win.setContentSize(contentWidth, contentHeight);
    nativeRect = getWindowRect(hwnd);
  } catch {
    // setContentSize 失败时退回纯原生尺寸
  }

  const next = {
    x,
    y,
    width: nativeRect ? Math.max(1, nativeRect.right - nativeRect.left) : base.width,
    height: nativeRect ? Math.max(1, nativeRect.bottom - nativeRect.top) : base.height,
  };
  if (!setWindowBounds(hwnd, next)) return false;

  lastBounds = next;
  lastWindowKey = key;
  return true;
}

function metricsKey(metrics) {
  if (!metrics) return null;
  // 只关心会影响内容视口的高度/DPI。任务栏宽度变化（拖动/缩放虚拟机窗口）
  // 只需移动固定长度的歌词窗，重建窗口反而会闪。
  return `${metrics.clientHeight}@${metrics.dpiScale}`;
}

// 延迟 1.2s 再比较一次：缩放切换过程中任务栏会连续变尺寸，等它稳定再重建。
// 如果 1.2s 后仍在变，这次先记下新尺寸，下一轮 poll 会再触发一次。
function scheduleMetricsRecreate() {
  if (!enabled || !trayHwnd || metricsRecreateTimer) return;
  metricsRecreateTimer = setTimeout(() => {
    metricsRecreateTimer = null;
    if (!enabled || !trayHwnd || !isWindow(trayHwnd)) return;

    const next = metricsKey(getTaskbarMetrics(trayHwnd));
    if (!next) return;
    if (!lastTaskbarMetrics) {
      lastTaskbarMetrics = next;
      return;
    }
    if (next === lastTaskbarMetrics) return;

    logTaskbar('taskbar metrics changed; recreating the strip', {
      from: lastTaskbarMetrics,
      to: next,
    });
    lastTaskbarMetrics = next;
    recreateWindow();
  }, 1200);
}

// 主显示器的物理像素 bounds，仅作为拿不到任务栏所属显示器时的兜底。
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

function mainWindowHwnd() {
  const main = getMainWindow();
  if (!main || main.isDestroyed()) return null;
  return getNativeHwnd(main);
}

// 歌词条跟随主窗口所在显示器的任务栏。Win11 副屏任务栏的类名是
// Shell_SecondaryTrayWnd，之前只找 Shell_TrayWnd 会把歌词条钉死在主屏。
function resolveTargetTaskbar() {
  const mainHwnd = mainWindowHwnd();
  if (mainHwnd) {
    const monitor = getWindowMonitor(mainHwnd);
    if (monitor) {
      for (const taskbar of listTaskbars()) {
        if (getWindowMonitor(taskbar) === monitor) return taskbar;
      }
    }
  }
  return findTaskbar();
}

// 全屏判定必须针对歌词条所在的显示器。副屏可能有负坐标/不同 DPI，
// 用主屏 bounds 会漏判或误判。
function targetMonitorBounds() {
  const rect = trayHwnd ? getMonitorRect(trayHwnd) : null;
  if (rect) {
    return {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    };
  }
  return primaryDisplayBounds();
}

// 主窗口换屏或主显示器切换后，任务栏句柄会变。DWM 合成 surface 不能靠
// 直接 re-parent 复活，所以销毁旧歌词窗并在新任务栏上重建。
function targetTaskbarChanged() {
  if (!enabled || !trayHwnd) return false;
  const next = resolveTargetTaskbar();
  if (!next || next === trayHwnd) return false;

  logTaskbar('taskbar target changed; recreating the strip', {
    from: String(trayHwnd),
    to: String(next),
  });
  // 旧显示器上被压缩的 Win10 任务列表先恢复，再到新任务栏上重建。
  resetLegacyLayout();
  trayHwnd = next;
  recreateWindow();
  return true;
}

// 每 1s 更新前台全屏状态；状态翻转时才动窗口
function refreshFullscreen() {
  if (!enabled) return;

  let next = false;
  try {
    next = isFullscreenForeground({ trayHwnd, ownHwnd: hwnd, bounds: targetMonitorBounds() });
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

// Win10：歌词窗是不 SetParent 的顶层 overlay，必须保持在 topmost 层，
// 否则 topmost 的任务栏重绘会把它盖住。只在丢失 topmost 时调用，
// 避免变成每 2s 一次的重复提升。
function ensureLegacyTopmost() {
  if (!isLegacyWindows() || !isWindowAlive(win) || !hwnd) return;
  if (getWindowStyleInfo(hwnd)?.topmost === true) return;
  try {
    win.setAlwaysOnTop(true);
  } catch {
    // 下一轮可见性更新会再试
  }
}

// 显示：定位 → showInactive → 再定位；Win10 再确保 topmost，
// Win11 再用 assertTopChild 保持同级顶端。隐藏只 hide，不销毁窗口；
// 销毁只发生在关闭功能或退出应用时。
function updateVisibility() {
  if (!isWindowAlive(win)) {
    visible = false;
    return;
  }

  const nativeVisible = hwnd ? isWindowVisible(hwnd) : false;

  if (!computeWantVisible()) {
    if (win.isVisible() || nativeVisible) {
      try {
        win.hide();
      } catch {
        // Electron 状态不同步时下面再用原生隐藏兜底
      }
      if (nativeVisible) hideWindow(hwnd);
      logTaskbar('taskbar strip hidden', { hwnd: String(hwnd) });
    }
    visible = false;
    return;
  }

  const wasShown = win.isVisible() || nativeVisible;
  if (!wasShown) {
    // 先摆好位置再显示，避免初始的大窗口在任务栏上闪一下；showInactive
    // 之后 Electron 可能按它记录的 bounds 重新摆一次，所以下面还要再应用一次。
    applyPosition(true);
    // 能提前设 topmost 就先设，避免第一帧出现在任务栏下面。
    if (isLegacyWindows()) ensureLegacyTopmost();
    win.showInactive();
  }
  visible = true;
  applyPosition(!wasShown);
  if (isLegacyWindows()) {
    // Win10 顶层 overlay：任务栏是 topmost，歌词条也必须是 topmost。
    ensureLegacyTopmost();
  } else {
    // Win11 的 WS_CHILD 需要在任务栏重绘后把歌词条提到同级顶端。
    assertTopChild(hwnd);
  }
  if (!wasShown) {
    logTaskbar('taskbar strip shown', {
      hwnd: String(hwnd),
      nativeVisible: hwnd ? isWindowVisible(hwnd) : false,
      rect: getWindowRect(hwnd),
      styles: getWindowStyleInfo(hwnd),
    });
  }
}

// UIA 失败兜底：贴着托盘通知区左侧；找不到通知区就贴着任务栏右端。
// 兜底也绝不能超出任务栏：宽度最多是任务栏宽减去两侧 12 CSS，x 夹在任务栏范围内。
// 兜底位置是可显示位置（design §6/§10）：UIA 失败时仍然显示，而不是藏起来。
function applyFallbackPosition(metrics, force) {
  const dpi = metrics.dpiScale || 1;
  const taskbarWidthCss = metrics.clientWidth / dpi;
  const desiredWidthCss = clampWindowWidth({
    contentWidthCss: Math.max(widthCss, FIXED_STRIP_CSS),
    gapWidthCss: 99999,
  });
  const windowWidthCss = Math.min(desiredWidthCss, taskbarWidthCss - 2 * FALLBACK_MARGIN_CSS);
  if (windowWidthCss <= 0) return false;
  const widthPx = Math.round(windowWidthCss * dpi);
  const notifyRect = getWindowRect(findTrayNotify(trayHwnd));
  const rawX = notifyRect
    ? notifyRect.left - metrics.screenLeft - widthPx - Math.round(FALLBACK_MARGIN_CSS * dpi)
    : metrics.clientWidth - widthPx - Math.round(FALLBACK_MARGIN_CSS * dpi);
  const x = Math.min(Math.max(0, rawX), Math.max(0, metrics.clientWidth - widthPx));
  return applyWindowBounds({ x, y: 0, width: widthPx, height: metrics.clientHeight }, dpi, force);
}

// 只计算并设置 bounds；显示/隐藏由 updateVisibility 统一负责。
function applyPosition(force = false) {
  if (!hwnd || !trayHwnd) return false;

  // Win10 的布局已经算好物理 bounds（任务列表压缩后的右侧空位），
  // 不再套用通用的 gap 公式。
  if (currentGap?.legacy) {
    const dpi = getTaskbarMetrics(trayHwnd)?.dpiScale || 1;
    return applyWindowBounds(currentGap.bounds, dpi, force);
  }

  if (!currentGap) {
    if (fallbackMetrics) return applyFallbackPosition(fallbackMetrics, force);
    return false;
  }

  const { side, gap, dpi, height } = currentGap;
  // 固定长度：内容短时窗口也保持 400 CSS，换 lyrics 行不再重设窗口。
  const windowWidthCss = clampWindowWidth({
    contentWidthCss: Math.max(widthCss, FIXED_STRIP_CSS),
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
  return applyWindowBounds(
    {
      x: xPx,
      y: 0,
      width: Math.round(windowWidthCss * dpi),
      height,
    },
    dpi,
    force
  );
}

// Win10：压缩任务列表腾出右侧空间。返回 null 表示这条路径不可用、应回退到 UIA；
// 返回 true/false 表示已经处理完（显示/隐藏）。
function applyLegacyGap() {
  if (!enabled || !hwnd || !trayHwnd) return null;

  if (!hasSong) {
    restoreLegacyTaskList();
    currentGap = null;
    fallbackMetrics = null;
    updateVisibility();
    return false;
  }

  const result = applyLegacyLayout({ trayHwnd, widthCss });
  if (result.ok) {
    setFixedAlign('end');
    if (result.vertical !== verticalTaskbar) {
      verticalTaskbar = result.vertical;
      sendConfig();
    }
    currentGap = { side: 'right', legacy: true, bounds: result.bounds };
    fallbackMetrics = null;
    setLightTaskbar(readSystemUsesLightTheme() ?? true);
    updateVisibility();
    return true;
  }

  if (result.reason === 'retry') {
    // 任务栏正在重排，ReBar/任务列表的瞬态 metrics 不可信：保留上一次的
    // currentGap 和窗口位置，不 MoveWindow 也不隐藏；下一轮 2s 探测重试。
    return true;
  }

  if (result.reason === 'no-space' || result.reason === 'waiting') {
    currentGap = null;
    fallbackMetrics = null;
    updateVisibility();
    return false;
  }

  // unsupported / move-failed：回退到 UIA。先恢复任务列表，避免残留压缩。
  restoreLegacyTaskList();
  return null;
}

// 跑一次 UIA 探测并更新 currentGap；probe 为 null 时退回托盘左侧兜底。
// 返回值只表示本次调用是否找到了可用空档（用于调试，不影响调用方）。
async function resolveGap() {
  const expectedHwnd = hwnd;
  const expectedTray = trayHwnd;

  if (isLegacyWindows() && legacyLayoutUsable()) {
    const legacy = applyLegacyGap();
    if (legacy !== null) {
      // 同步执行期间窗口通常不会变，但保留和 UIA 分支相同的身份检查。
      if (!enabled || !hwnd || !trayHwnd || hwnd !== expectedHwnd || trayHwnd !== expectedTray) {
        return false;
      }
      return legacy;
    }
  }

  const probe = await probeTaskbar({ taskbarHwnd: trayHwnd });

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

  // Win10 竖排由 legacy 压缩路径处理；如果 legacy 不可用而掉到 UIA，
  // 这里没有竖排 gap 逻辑，宁可隐藏也不要把窗口按横排坐标摆错。
  if (metrics.vertical) {
    currentGap = null;
    fallbackMetrics = null;
    updateVisibility();
    return false;
  }

  // 从竖排任务栏切到横排、但 legacy 不可用而走到 UIA 时，把渲染进程切回横排。
  if (verticalTaskbar) {
    verticalTaskbar = false;
    sendConfig();
  }

  // 零个按钮不能当成“整条任务栏都是空档”——那会把歌词直接压在图标上。
  // 拿不到按钮时退回托盘左侧兜底，至少不会遮住应用按钮。
  if (!probe || probe.buttons.length === 0) {
    setFixedAlign('end');
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

  setFixedAlign(side === 'left' ? 'start' : 'end');
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
    // explorer 重启后旧 Shell_TrayWnd 和它的子窗口都会失效；HWND 可能被复用，
    // 所以任务栏句柄和我们自己的子窗口句柄都要检查。先检查，避免拿失效句柄
    // 去跑 Win10 的任务列表压缩。
    if ((trayHwnd && !isWindow(trayHwnd)) || (hwnd && !isWindow(hwnd))) {
      recreateWindow();
      return;
    }

    // 主窗口被拖到另一块屏（或主显示器切换）后，把歌词条迁到那块屏的任务栏。
    if (targetTaskbarChanged()) return;

    // 缩放/分辨率变化后任务栏尺寸会变；Chromium 的透明 surface 只缩不涨，
    // 等尺寸稳定后重建一次歌词窗。
    const taskbarMetrics = getTaskbarMetrics(trayHwnd);
    if (taskbarMetrics) {
      const key = metricsKey(taskbarMetrics);
      if (!lastTaskbarMetrics) lastTaskbarMetrics = key;
      else if (key !== lastTaskbarMetrics) scheduleMetricsRecreate();
    }

    // Win11 的 WS_CHILD 可见时每 2s 拉回同级顶端。
    // Win10 的 popup 在 applyWindowBounds(raise) 时已经提升，周期提升会闪。
    if (!isLegacyWindows() && visible && hwnd && isWindow(hwnd)) assertTopChild(hwnd);

    // Win10 的任务列表可能在按钮增减后被 Explorer 重新铺满；每 2s 确认一次
    // 压缩状态，必要时重新腾出右侧空间。这条路径全是同步原生调用，开销很小。
    if (isLegacyWindows() && legacyLayoutUsable()) probeAndApply();

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
  lastWindowKey = null;
  // 显示器增删/改缩放后，主窗口可能已经落到另一块屏的任务栏上。
  if (targetTaskbarChanged()) return;
  // 任务栏高度随缩放改变时，延迟重建歌词窗以获得新的合成 surface。
  scheduleMetricsRecreate();
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
  clearTimeout(metricsRecreateTimer);
  metricsRecreateTimer = null;
  lastTaskbarMetrics = null;
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
  lastWindowKey = null;
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
    // explorer 重启后旧任务列表已失效，清掉压缩状态；如果只是渲染进程崩溃、
    // 任务栏还在，则保留已经腾出的空间，避免任务栏图标来回跳。
    if (!trayHwnd || !isWindow(trayHwnd)) resetLegacyLayout();
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
  logTaskbar('failed to enable taskbar lyrics', {
    message: error instanceof Error ? error.message : String(error),
    nativeError: getNativeInitError(),
  });
  enabled = false;
  stopMonitors();
  clearTimeout(recreateTimer);
  recreateTimer = null;
  destroyWindow();
  resetLegacyLayout();
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
  // 旧窗口即将销毁；任何等待中的尺寸重建请求都作废。
  clearTimeout(metricsRecreateTimer);
  metricsRecreateTimer = null;

  // 把窗口建在目标任务栏所在的显示器上，Chromium 才会用那块屏的 DPI；
  // 否则从主屏创建再嵌到副屏，字体/坐标会按错误的缩放比渲染。
  const main = getMainWindow();
  const primaryTaskbar = findTaskbar();
  const targetTaskbar = resolveTargetTaskbar();
  const onPrimaryTaskbar = !targetTaskbar || !primaryTaskbar || targetTaskbar === primaryTaskbar;
  const targetDisplay =
    onPrimaryTaskbar || !main || main.isDestroyed()
      ? screen.getPrimaryDisplay()
      : screen.getDisplayMatching(main.getBounds());

  // 竖排任务栏的歌词窗是“任务栏宽 × 显示器高”的窄条；横排则覆盖整屏宽度。
  const targetMetrics = targetTaskbar ? getTaskbarMetrics(targetTaskbar) : null;
  const verticalTarget = targetMetrics
    ? targetMetrics.vertical === true || targetMetrics.clientHeight > targetMetrics.clientWidth
    : verticalTaskbar;
  verticalTaskbar = verticalTarget;
  const initialWidth =
    verticalTarget && targetMetrics
      ? Math.max(1, Math.round(targetMetrics.clientWidth / (targetMetrics.dpiScale || 1)))
      : Math.max(1, Math.round(targetDisplay.bounds.width));
  const initialHeight = verticalTarget ? Math.max(1, Math.round(targetDisplay.bounds.height)) : 200;

  // Electron 的透明窗口被 SetParent 到任务栏后，Chromium 的合成 surface
  // 只跟着 setBounds 收缩、不跟着扩大。初始尺寸覆盖后续可能的最大尺寸，
  // 后续只会缩小；窗口在首次布局完成前一直 show:false。
  const next = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: initialWidth,
    height: initialHeight,
    frame: false,
    // 无边框窗口的 window bounds 和 WebContentsView 内容区可能不一致；
    // 布局时按参考项目的顺序，用 setContentSize 明确设内容区，再原生定位。
    thickFrame: false,
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
  // 歌词条只负责显示；鼠标穿透后，任务栏空白处/歌词条上的点击都会落到任务栏，
  // setContentSize 补出来的不可见边框也不会挡住任务栏。
  try {
    next.setIgnoreMouseEvents(true);
  } catch {
    // 不支持时忽略，不影响歌词显示
  }
  hwnd = null;
  trayHwnd = null;
  visible = false;
  // 新窗口的默认 bounds 与旧窗口无关，旧的缓存必须作废
  currentGap = null;
  fallbackMetrics = null;
  lastBounds = null;
  lastWindowKey = null;

  next.loadFile(path.join(__dirname, 'taskbar-lyrics.html'));

  next.webContents.on('did-finish-load', () => {
    if (win !== next || next.isDestroyed()) return;

    const nextHwnd = getNativeHwnd(next);
    const nextTrayHwnd = resolveTargetTaskbar();
    if (!nextHwnd || !nextTrayHwnd) {
      handleEmbedFailure(windowContext, 'taskbar window not found');
      return;
    }
    // Win10 沿用 SPlayer 的 Electron 方案：父窗口 Shell_TrayWnd，保持 WS_POPUP；
    // Win11 用 WS_CHILD。两边都以 Shell_TrayWnd 为父窗口，坐标相对它的客户区。
    const nextParentHwnd = nextTrayHwnd;
    if (!embedWindow(nextHwnd, nextParentHwnd)) {
      logTaskbar('embed verification failed', {
        hwnd: String(nextHwnd),
        trayHwnd: String(nextTrayHwnd),
        expectedParent: String(nextParentHwnd),
        parent: String(getWindowParent(nextHwnd)),
        ancestor: String(getWindowAncestor(nextHwnd)),
      });
      handleEmbedFailure(windowContext, 'failed to embed the strip into the taskbar container');
      return;
    }

    // 嵌入成功：此后的 closed/render-process-gone 走重建而不是启用失败
    windowContext.pending = false;
    hwnd = nextHwnd;
    trayHwnd = nextTrayHwnd;
    const nextMetrics = getTaskbarMetrics(nextTrayHwnd);
    verticalTaskbar = nextMetrics
      ? nextMetrics.vertical === true || nextMetrics.clientHeight > nextMetrics.clientWidth
      : verticalTaskbar;
    lastTaskbarMetrics = metricsKey(nextMetrics);
    const windowsParent = getWindowParent(nextHwnd);
    logTaskbar('taskbar strip embedded', {
      hwnd: String(nextHwnd),
      trayHwnd: String(nextTrayHwnd),
      parentHwnd: String(nextParentHwnd),
      windowsParent: windowsParent ? String(windowsParent) : null,
      osBuild: getOsBuild(),
      legacy: isLegacyWindows(),
      metrics: lastTaskbarMetrics,
      styles: getWindowStyleInfo(nextHwnd),
    });

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
    lastWindowKey = null;
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
    const tray = resolveTargetTaskbar();
    if (!tray) {
      throw new Error(
        'Shell_TrayWnd not found; native helpers are unavailable or the taskbar is missing'
      );
    }
    const metrics = getTaskbarMetrics(tray);
    if (!metrics) {
      throw new Error('taskbar metrics unavailable; native helpers failed');
    }

    // Win10 任务栏四边都支持：底部/顶部走横排，左侧/右侧走竖排。
    // Win11 原生不支持侧边任务栏，竖排只在 Win10 分支开放。
    const vertical = metrics.vertical === true || metrics.clientHeight > metrics.clientWidth;
    if (vertical && !isLegacyWindows()) {
      throw new Error('vertical taskbars are only supported on Windows 10');
    }
    verticalTaskbar = vertical;

    // 顶部/底部横排任务栏都支持：坐标全部相对 Shell_TrayWnd 客户区，
    // 不再依赖“贴着主显示器底边”这个假设。
    logTaskbar('enabling taskbar lyrics', {
      osBuild: getOsBuild(),
      legacy: isLegacyWindows(),
      vertical,
      trayHwnd: String(tray),
      clientWidth: metrics.clientWidth,
      clientHeight: metrics.clientHeight,
      dpiScale: metrics.dpiScale,
      monitorRect: getMonitorRect(tray),
      nativeError: getNativeInitError(),
    });

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
  // 关闭功能时把 Win10 任务列表恢复到压缩前的宽度。
  resetLegacyLayout();
  logTaskbar('taskbar lyrics disabled');
}

function bindIpcOnce() {
  if (ipcBound) return;
  ipcBound = true;

  ipcMain.on(WIDTH_CHANNEL, (event, px) => {
    if (!isWindowAlive(win) || event.sender !== win.webContents) return;
    const width = Number(px);
    if (!Number.isFinite(width) || width <= 0) return;
    widthCss = Math.max(1, Math.round(width));
    // Win10 需要按新宽度重新压缩任务列表；Win11 只改窗口宽度即可。
    if (isLegacyWindows() && legacyLayoutUsable()) probeAndApply();
    else updateVisibility();
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
    resetLegacyLayout();
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
    resetLegacyLayout();
    if (next) showEnableFailureDialog();
  }

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
  // 有歌/无歌切换都要重新布局：无歌时 Win10 需要把任务列表恢复原宽度，
  // 有歌时也需要补一次探测，避免沿用陈旧空档。
  if (hadSong !== hasSong && enabled) probeAndApply();
}

export function updateTaskbarLyricsPlayback(state) {
  lastPlayback = state || null;
  if (lastPlayback) sendToWindow('taskbar:playback', lastPlayback);
}

export function updateTaskbarLyricsStyle() {
  // store 已由 IPC 更新；buildConfig 重新读字体/粗细/颜色并下发
  sendConfig();
  return lastConfig;
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
  resetLegacyLayout();
}
