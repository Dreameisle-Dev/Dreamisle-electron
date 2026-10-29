// Windows 10 任务栏歌词布局。
//
// Win10 的经典任务栏里，应用按钮所在的 MSTaskSwWClass 会横跨整个 ReBarWindow32；
// 按钮右侧的“空档”仍然被这个任务列表窗口盖着，所以不能像 Win11 那样直接把歌词条
// 放在 UIA 找到的空隙上——它会被任务列表盖住。这里采用参考项目的做法：先压缩任务
// 列表，从右端腾出一块真正的空位，再把歌词条放到托盘左侧。
//
// 只在 Win10 分支使用；Win11 仍走原来的 UIA 空档探测。
// 歌词窗本身在 Win10 上按 SPlayer 的 Electron 方案以 WS_POPUP 挂到
// Shell_TrayWnd，所以这里返回的 bounds 是相对 Taskbar 客户区（不是 ReBar）。
import {
  findTaskbarContainer,
  findTaskList,
  findTrayNotify,
  getTaskbarMetrics,
  getWindowRect,
  isLegacyBuild,
  isWindow,
  moveWindow,
} from './taskbar-win32.js';
import {
  clampWindowWidth,
  computeLegacyTaskbarLayout,
  computeLegacyVerticalTaskbarLayout,
  DOCK_MARGIN_CSS,
  FIXED_STRIP_CSS,
} from './taskbar-gap.js';
import { logTaskbar } from './taskbar-log.js';

let cachedLegacy = null;
let usable = true;
let state = freshState();
let lastLogKey = '';

function freshState() {
  return {
    trayHwnd: null,
    rebarHwnd: null,
    taskListHwnd: null,
    // 压缩前的任务列表几何（相对 ReBar 客户区）及当时的 ReBar 尺寸，
    // 用于关闭功能/分辨率变化时恢复。
    baseline: null,
    squeezed: false,
    lastRebarWidth: 0,
    lastRebarHeight: 0,
    lastTaskListRect: null,
    // 'stable' 预留固定宽度，避免图标随每句歌词左右跳；
    // 任务栏太挤放不下时退到 'content'，只按当前内容宽度压缩。
    reserveMode: 'stable',
  };
}

function sameRect(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function logOnce(message, details) {
  const key = `${message}:${stableKey(details)}`;
  if (key === lastLogKey) return;
  lastLogKey = key;
  logTaskbar(message, details);
}

function stableKey(value) {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item
    );
  } catch {
    return String(value);
  }
}

export function isLegacyWindows() {
  if (cachedLegacy === null) cachedLegacy = isLegacyBuild();
  return cachedLegacy;
}

export function legacyLayoutUsable() {
  return usable;
}

/**
 * 尝试为当前内容宽度腾出 Win10 任务栏右侧空间，并返回歌词条的物理 bounds
 * （相对 Shell_TrayWnd 客户区）。
 *
 * reason:
 * - unsupported：找不到 ReBarWindow32 / MSTaskSwWClass 或拿不到 metrics，调用方应回退到 UIA
 * - no-space：任务列表已经压到没有空间，调用方应隐藏歌词条
 * - move-failed：MoveWindow 失败，调用方可以回退到 UIA
 */
export function applyLegacyLayout({ trayHwnd, widthCss }) {
  if (!usable || !trayHwnd) return { ok: false, reason: 'unsupported' };
  if (!(Number(widthCss) > 0)) return { ok: false, reason: 'waiting' };

  const tray = trayHwnd;
  const rebarHwnd = findTaskbarContainer(tray);
  if (!rebarHwnd) {
    usable = false;
    logOnce('Win10 layout unsupported: ReBarWindow32 not found', {
      trayHwnd: String(tray),
    });
    return { ok: false, reason: 'unsupported' };
  }

  const taskListHwnd = findTaskList(rebarHwnd);
  if (!taskListHwnd) {
    usable = false;
    logOnce('Win10 layout unsupported: task list not found', {
      rebarHwnd: String(rebarHwnd),
    });
    return { ok: false, reason: 'unsupported' };
  }

  // 任务栏重建（explorer 重启）后旧句柄失效：先尽量恢复旧任务列表，
  // 再丢弃旧状态，避免把旧基线套到新任务列表上。
  if (
    (state.rebarHwnd && state.rebarHwnd !== rebarHwnd) ||
    (state.taskListHwnd && state.taskListHwnd !== taskListHwnd) ||
    (state.trayHwnd && state.trayHwnd !== tray)
  ) {
    resetLegacyLayout();
  }
  state.trayHwnd = tray;
  state.rebarHwnd = rebarHwnd;
  state.taskListHwnd = taskListHwnd;

  let rebarMetrics = getTaskbarMetrics(rebarHwnd);
  if (!rebarMetrics) {
    logOnce('Win10 layout unavailable: rebar metrics missing', {
      rebarHwnd: String(rebarHwnd),
    });
    return { ok: false, reason: 'unsupported' };
  }

  // 分辨率/DPI 改变后，旧的任务列表宽度不再是原来的基准。先按比例恢复，
  // 再按新尺寸重新压缩，避免每次变化都累积多压一截。
  if (state.squeezed && state.baseline && rebarMetrics.clientHeight !== state.lastRebarHeight) {
    // 只有高度（DPI/小任务栏）变化才需要恢复基线再重压；宽度变化直接按
    // 当前任务列表重新布局，避免任务列表瞬间展开盖住歌词条。
    restoreLegacyTaskList();
    rebarMetrics = getTaskbarMetrics(rebarHwnd);
    if (!rebarMetrics) return { ok: false, reason: 'unsupported' };
    state.reserveMode = 'stable';
  }

  const taskbarMetrics = getTaskbarMetrics(tray);
  if (!taskbarMetrics) {
    logOnce('Win10 layout unavailable: taskbar metrics missing', {
      trayHwnd: String(tray),
    });
    return { ok: false, reason: 'unsupported' };
  }

  const taskListRect = getWindowRect(taskListHwnd);
  if (!taskListRect) {
    logOnce('Win10 layout unavailable: task list rect missing', {
      taskListHwnd: String(taskListHwnd),
    });
    return { ok: false, reason: 'unsupported' };
  }

  // Explorer 重排任务栏时，ReBar 的 client rect/origin 会瞬时读成不一致的值
  // （实测 clientWidth 从 1492 跳到 ~2800），按它算出的 strip 会被摆到屏幕外。
  // 先确认 ReBar 完整落在任务栏客户区内；不满足就保留上一次布局，下一轮再试。
  const rebarOffsetX = rebarMetrics.screenLeft - taskbarMetrics.screenLeft;
  const rebarOffsetY = rebarMetrics.screenTop - taskbarMetrics.screenTop;
  if (
    rebarOffsetX < 0 ||
    rebarOffsetY < 0 ||
    rebarOffsetX + rebarMetrics.clientWidth > taskbarMetrics.clientWidth ||
    rebarOffsetY + rebarMetrics.clientHeight > taskbarMetrics.clientHeight
  ) {
    logOnce('Win10 layout: inconsistent ReBar metrics; keeping the last position', {
      rebar: {
        screenLeft: rebarMetrics.screenLeft,
        screenTop: rebarMetrics.screenTop,
        clientWidth: rebarMetrics.clientWidth,
        clientHeight: rebarMetrics.clientHeight,
      },
      taskbar: {
        screenLeft: taskbarMetrics.screenLeft,
        screenTop: taskbarMetrics.screenTop,
        clientWidth: taskbarMetrics.clientWidth,
        clientHeight: taskbarMetrics.clientHeight,
      },
      taskListRect,
      rebarHwnd: String(rebarHwnd),
    });
    return { ok: false, reason: 'retry' };
  }

  const dpi = rebarMetrics.dpiScale > 0 ? rebarMetrics.dpiScale : 1;
  const vertical =
    taskbarMetrics.vertical === true || rebarMetrics.clientHeight > rebarMetrics.clientWidth;

  // 托盘通知区是任务列表的硬边界：横排取托盘左缘，竖排取托盘上缘。
  const trayRect = getWindowRect(findTrayNotify(tray));
  const rightLimitPx =
    trayRect && trayRect.left > rebarMetrics.screenLeft
      ? trayRect.left - rebarMetrics.screenLeft
      : null;
  const bottomLimitPx =
    trayRect && trayRect.top > rebarMetrics.screenTop
      ? trayRect.top - rebarMetrics.screenTop
      : null;
  const usableLongAxisPx = vertical
    ? bottomLimitPx !== null
      ? Math.min(rebarMetrics.clientHeight, bottomLimitPx)
      : rebarMetrics.clientHeight
    : rightLimitPx !== null
      ? Math.min(rebarMetrics.clientWidth, rightLimitPx)
      : rebarMetrics.clientWidth;
  const usableLongAxisCss = usableLongAxisPx / dpi;

  // 竖排时 widthCss 是歌词条沿 y 轴的内容长度，横排时是 x 轴宽度。
  const stripLengthCss = clampWindowWidth({
    contentWidthCss: widthCss,
    gapWidthCss: usableLongAxisCss,
  });
  if (stripLengthCss === 0) {
    logOnce('Win10 layout: content does not fit the taskbar', {
      widthCss,
      usableLongAxisCss,
      vertical,
    });
    return { ok: false, reason: 'no-space' };
  }
  const stripLengthPx = Math.max(1, Math.round(stripLengthCss * dpi));

  const maxReserveCss = Math.max(0, usableLongAxisCss - 2 * DOCK_MARGIN_CSS);
  const stableReserveCss = Math.min(
    Math.max(stripLengthCss, FIXED_STRIP_CSS),
    Math.max(stripLengthCss, maxReserveCss)
  );
  const stableReservePx = Math.max(stripLengthPx, Math.round(stableReserveCss * dpi));

  const baseLayoutInput = {
    rebarClientOrigin: {
      x: rebarMetrics.screenLeft,
      y: rebarMetrics.screenTop,
    },
    rebarClientSize: {
      width: rebarMetrics.clientWidth,
      height: rebarMetrics.clientHeight,
    },
    taskbarClientOrigin: {
      x: taskbarMetrics.screenLeft,
      y: taskbarMetrics.screenTop,
    },
    taskListRect,
  };
  // 歌词窗长度直接用任务列表预留长度：换一句歌词只改窗口里的文字，
  // 不再按每句宽度 setContentSize/SetWindowPos（VM 的 layered 窗口会闪）。
  const makeLayout = (reservePx) =>
    vertical
      ? computeLegacyVerticalTaskbarLayout({
          ...baseLayoutInput,
          stripLengthPx: reservePx,
          reserveLengthPx: reservePx,
          bottomLimitPx,
        })
      : computeLegacyTaskbarLayout({
          ...baseLayoutInput,
          stripWidthPx: reservePx,
          reserveWidthPx: reservePx,
          rightLimitPx,
        });

  let reservePx = stableReservePx;
  let layout = null;
  if (state.reserveMode === 'stable') {
    layout = makeLayout(reservePx);
    if (!layout) {
      // 任务栏太挤，固定 400px 预留放不下；退回只按当前歌词长度压缩。
      state.reserveMode = 'content';
      logTaskbar('Win10 layout: stable reserve does not fit; using content length', {
        stripLengthPx,
        stableReservePx,
        vertical,
        rebarWidth: rebarMetrics.clientWidth,
        rebarHeight: rebarMetrics.clientHeight,
        taskListRect,
        rightLimitPx,
        bottomLimitPx,
      });
    }
  }
  if (!layout) {
    reservePx = stripLengthPx;
    layout = makeLayout(reservePx);
  }

  if (!layout) {
    logOnce('Win10 layout: not enough room for the strip', {
      stripLengthPx,
      vertical,
      rebarWidth: rebarMetrics.clientWidth,
      rebarHeight: rebarMetrics.clientHeight,
      taskListRect,
      rightLimitPx,
      bottomLimitPx,
    });
    return { ok: false, reason: 'no-space' };
  }

  // 最后一道保险：布局结果必须完全落在任务栏/ReBar 客户区内。任何瞬态坏
  // metrics 都不能把歌词条或任务列表移出去；保持上一次正确位置等下一轮。
  const stripOutsideTaskbar =
    layout.strip.x < 0 ||
    layout.strip.y < 0 ||
    layout.strip.x + layout.strip.width > taskbarMetrics.clientWidth ||
    layout.strip.y + layout.strip.height > taskbarMetrics.clientHeight;
  const taskListOutsideRebar =
    !!layout.taskList &&
    (layout.taskList.x < 0 ||
      layout.taskList.y < 0 ||
      layout.taskList.x + layout.taskList.width > rebarMetrics.clientWidth ||
      layout.taskList.y + layout.taskList.height > rebarMetrics.clientHeight);
  if (stripOutsideTaskbar || taskListOutsideRebar) {
    logOnce('Win10 layout: computed bounds fall outside the taskbar; keeping the last position', {
      bounds: layout.strip,
      taskList: layout.taskList,
      taskbar: {
        clientWidth: taskbarMetrics.clientWidth,
        clientHeight: taskbarMetrics.clientHeight,
      },
      rebar: {
        clientWidth: rebarMetrics.clientWidth,
        clientHeight: rebarMetrics.clientHeight,
      },
    });
    return { ok: false, reason: 'retry' };
  }

  let taskListMoved = false;
  if (layout.taskList) {
    if (!state.baseline) {
      state.baseline = {
        x: taskListRect.left - rebarMetrics.screenLeft,
        y: taskListRect.top - rebarMetrics.screenTop,
        width: taskListRect.right - taskListRect.left,
        height: taskListRect.bottom - taskListRect.top,
        rebarWidth: rebarMetrics.clientWidth,
        rebarHeight: rebarMetrics.clientHeight,
      };
    }
    if (!sameRect(state.lastTaskListRect, layout.taskList)) {
      if (!moveWindow(taskListHwnd, layout.taskList)) {
        logOnce('Win10 layout: failed to resize the task list', {
          taskListHwnd: String(taskListHwnd),
          target: layout.taskList,
        });
        return { ok: false, reason: 'move-failed' };
      }
      state.lastTaskListRect = layout.taskList;
      taskListMoved = true;
      logTaskbar('Win10 layout: task list squeezed for the lyric strip', {
        taskListHwnd: String(taskListHwnd),
        oldWidth: state.baseline.width,
        oldHeight: state.baseline.height,
        newWidth: layout.taskList.width,
        newHeight: layout.taskList.height,
        stripLengthPx,
        reservePx,
        vertical,
        bounds: layout.strip,
        rebar: {
          screenLeft: rebarMetrics.screenLeft,
          screenTop: rebarMetrics.screenTop,
          clientWidth: rebarMetrics.clientWidth,
          clientHeight: rebarMetrics.clientHeight,
        },
        taskbar: {
          screenLeft: taskbarMetrics.screenLeft,
          screenTop: taskbarMetrics.screenTop,
          clientWidth: taskbarMetrics.clientWidth,
          clientHeight: taskbarMetrics.clientHeight,
        },
      });
    }
    state.squeezed = true;
  }

  state.lastRebarWidth = rebarMetrics.clientWidth;
  state.lastRebarHeight = rebarMetrics.clientHeight;
  lastLogKey = '';

  return {
    ok: true,
    bounds: layout.strip,
    stripLengthPx: reservePx,
    contentLengthPx: stripLengthPx,
    vertical,
    // 任务列表被重新压缩会触发任务栏重绘；调用方需要在这之后把 popup 再提一次。
    taskListMoved,
  };
}

/**
 * 把任务列表恢复到压缩前的宽度（按当前 ReBar 尺寸等比缩放）。
 * 句柄已失效时只清状态，不再动任何窗口。
 */
export function restoreLegacyTaskList() {
  const { taskListHwnd, rebarHwnd, baseline, squeezed } = state;
  if (!squeezed || !baseline) {
    clearReservation();
    return;
  }
  if (!taskListHwnd || !isWindow(taskListHwnd) || !rebarHwnd || !isWindow(rebarHwnd)) {
    clearReservation();
    return;
  }

  const rebarMetrics = getTaskbarMetrics(rebarHwnd);
  if (!rebarMetrics) {
    clearReservation();
    return;
  }

  const scaleX = baseline.rebarWidth > 0 ? rebarMetrics.clientWidth / baseline.rebarWidth : 1;
  const scaleY = baseline.rebarHeight > 0 ? rebarMetrics.clientHeight / baseline.rebarHeight : 1;
  // 显示器变窄时基线可能落到任务栏外；把恢复位置夹回 ReBar 客户区内。
  const x = Math.max(0, Math.min(rebarMetrics.clientWidth - 1, Math.round(baseline.x * scaleX)));
  const y = Math.max(0, Math.min(rebarMetrics.clientHeight - 1, Math.round(baseline.y * scaleY)));
  const width = Math.max(
    1,
    Math.min(rebarMetrics.clientWidth - x, Math.round(baseline.width * scaleX))
  );
  const height = Math.max(
    1,
    Math.min(rebarMetrics.clientHeight - y, Math.round(baseline.height * scaleY))
  );

  if (moveWindow(taskListHwnd, { x, y, width, height })) {
    logTaskbar('Win10 layout: task list restored', {
      taskListHwnd: String(taskListHwnd),
      width,
    });
  }
  clearReservation();
}

function clearReservation() {
  state.squeezed = false;
  state.baseline = null;
  state.lastTaskListRect = null;
}

/**
 * 恢复任务列表并清空所有句柄/基线。explorer 重启后旧句柄已失效，
 * 恢复会安全地变成空操作。
 */
export function resetLegacyLayout() {
  restoreLegacyTaskList();
  state = freshState();
  usable = true;
  lastLogKey = '';
}
