// Pure logic for placing the taskbar lyrics strip.
// No Electron, native, or DOM imports: unit-testable with plain `node --test`.

export const MIN_TEXT_CSS = 160;
export const WINDOW_PADDING_CSS = 12;
export const MIN_WINDOW_CSS = 184;
export const DOCK_MARGIN_CSS = 8;
export const MIN_GAP_CSS = 200;
// 固定的歌词条长度（CSS px）：换歌词只更新 DOM，不再重设窗口尺寸。
export const FIXED_STRIP_CSS = 400;

/**
 * Which half of the taskbar the lyrics strip may occupy.
 * Win11 centered taskbar has free space on the left; left-aligned and Win10
 * taskbars are treated as having free space on the right.
 */
export function sideFor({ osBuild, taskbarAl }) {
  if (osBuild < 22000) return 'right';
  return taskbarAl === 0 ? 'right' : 'left';
}

/**
 * Whether the strip should be visible.
 * A UIA gap or the tray-left fallback both count as a usable placement;
 * hide only when neither exists (or when disabled/fullscreen/no song/dead window).
 */
export function shouldShow({ enabled, hasSong, fullscreen, hasGap, hasFallback, windowAlive }) {
  return Boolean(enabled && hasSong && !fullscreen && (hasGap || hasFallback) && windowAlive);
}

/**
 * A probe may only be coalesced into an in-flight probe for the same window pair.
 * After a recreate the old probe's result is discarded, so new-window requests
 * must start a fresh probe instead of waiting on the stale one.
 */
export function shouldCoalesceProbe(inFlightKey, requestedKey) {
  if (inFlightKey === null || inFlightKey === undefined) return false;
  if (requestedKey === null || requestedKey === undefined) return false;
  return inFlightKey === requestedKey;
}

/**
 * Windows 10 的经典任务列表会把右侧空档整块盖住；必须先把任务列表从右侧压缩，
 * 腾出一块真正的空位，再把歌词条放进去。所有坐标都是物理像素：
 * - rebarClientOrigin / rebarClientSize：ReBarWindow32 客户区原点（屏幕坐标）和尺寸
 * - taskbarClientOrigin：Shell_TrayWnd 客户区原点（屏幕坐标）
 * - taskListRect：MSTaskSwWClass 的屏幕矩形
 * - rightLimitPx：可用的右边界（相对 ReBar 客户区），通常是托盘通知区左边缘
 *
 * 返回的 strip 坐标是相对 Shell_TrayWnd 客户区；taskList 的新 bounds 是相对
 * ReBarWindow32 客户区（MoveWindow 需要父窗口客户区坐标）。任务列表右侧本来
 * 就有足够空位时不压缩，直接返回 strip。
 */
export function computeLegacyTaskbarLayout({
  rebarClientOrigin,
  rebarClientSize,
  taskbarClientOrigin,
  taskListRect,
  stripWidthPx,
  reserveWidthPx = null,
  gapPx = DOCK_MARGIN_CSS,
  marginPx = DOCK_MARGIN_CSS,
  rightLimitPx = null,
}) {
  if (!rebarClientOrigin || !rebarClientSize || !taskbarClientOrigin) return null;

  const rebarWidth = Math.trunc(rebarClientSize.width);
  const rebarHeight = Math.trunc(rebarClientSize.height);
  const width = Math.trunc(stripWidthPx);
  if (rebarWidth <= 0 || rebarHeight <= 0 || width <= 0) return null;

  const right =
    rightLimitPx !== null && Number.isFinite(rightLimitPx)
      ? Math.min(rebarWidth, Math.trunc(rightLimitPx))
      : rebarWidth;
  // 任务列表按“预留宽度”压缩，而不是按当前这一句的宽度。这样歌词句子变长变短时
  // 任务栏图标不会跟着来回跳；短句只是让预留区里多一段空白。
  const reserve =
    reserveWidthPx !== null && Number.isFinite(reserveWidthPx)
      ? Math.max(width, Math.trunc(reserveWidthPx))
      : width;
  const needed = reserve + marginPx + gapPx;
  if (right <= 0 || needed > right || width + marginPx > right) return null;

  const stripLeft = right - marginPx - width;
  let taskList = null;

  if (taskListRect) {
    const taskListWidth = taskListRect.right - taskListRect.left;
    const taskListHeight = taskListRect.bottom - taskListRect.top;
    if (taskListWidth > 0 && taskListHeight > 0) {
      const x = taskListRect.left - rebarClientOrigin.x;
      const y = taskListRect.top - rebarClientOrigin.y;
      const freeRight = right - (x + taskListWidth);
      if (freeRight < needed) {
        const newWidth = taskListWidth + freeRight - needed;
        if (newWidth <= 0) return null;
        taskList = { x, y, width: newWidth, height: taskListHeight };
      }
    }
  }

  return {
    strip: {
      x: rebarClientOrigin.x + stripLeft - taskbarClientOrigin.x,
      y: rebarClientOrigin.y - taskbarClientOrigin.y,
      width,
      height: rebarHeight,
    },
    taskList,
  };
}

/**
 * Windows 10 竖排任务栏（左/右）：在任务列表底部腾出空间，歌词条占满
 * 任务栏宽度、贴在任务列表和托盘之间。坐标全部为物理像素。
 * - bottomLimitPx：托盘通知区上边缘相对 ReBar 客户区（没有就用 ReBar 高度）
 *
 * 返回的 strip 坐标相对 Shell_TrayWnd 客户区；taskList 新 bounds 相对
 * ReBarWindow32 客户区。任务列表下方本来就有足够空间时不压缩。
 */
export function computeLegacyVerticalTaskbarLayout({
  rebarClientOrigin,
  rebarClientSize,
  taskbarClientOrigin,
  taskListRect,
  stripLengthPx,
  reserveLengthPx = null,
  gapPx = DOCK_MARGIN_CSS,
  marginPx = DOCK_MARGIN_CSS,
  bottomLimitPx = null,
}) {
  if (!rebarClientOrigin || !rebarClientSize || !taskbarClientOrigin) return null;

  const rebarWidth = Math.trunc(rebarClientSize.width);
  const rebarHeight = Math.trunc(rebarClientSize.height);
  const length = Math.trunc(stripLengthPx);
  if (rebarWidth <= 0 || rebarHeight <= 0 || length <= 0) return null;

  const bottom =
    bottomLimitPx !== null && Number.isFinite(bottomLimitPx)
      ? Math.min(rebarHeight, Math.trunc(bottomLimitPx))
      : rebarHeight;
  if (bottom <= 0) return null;

  const reserve =
    reserveLengthPx !== null && Number.isFinite(reserveLengthPx)
      ? Math.max(length, Math.trunc(reserveLengthPx))
      : length;
  const needed = reserve + marginPx + gapPx;
  if (needed > bottom || length + marginPx > bottom) return null;

  const stripTop = bottom - marginPx - length;
  let taskList = null;

  if (taskListRect) {
    const taskListWidth = taskListRect.right - taskListRect.left;
    const taskListHeight = taskListRect.bottom - taskListRect.top;
    if (taskListWidth > 0 && taskListHeight > 0) {
      const x = taskListRect.left - rebarClientOrigin.x;
      const y = taskListRect.top - rebarClientOrigin.y;
      const freeBottom = bottom - (y + taskListHeight);
      if (freeBottom < needed) {
        const newHeight = taskListHeight + freeBottom - needed;
        if (newHeight <= 0) return null;
        taskList = { x, y, width: taskListWidth, height: newHeight };
      }
    }
  }

  return {
    strip: {
      x: rebarClientOrigin.x - taskbarClientOrigin.x,
      y: rebarClientOrigin.y + stripTop - taskbarClientOrigin.y,
      width: rebarWidth,
      height: length,
    },
    taskList,
  };
}

function pickWidest(gaps, side, taskbarWidth) {
  const half = taskbarWidth / 2;
  const candidates = gaps.filter((gap) => (side === 'left' ? gap.left < half : gap.right > half));
  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (const gap of candidates.slice(1)) {
    const wider = gap.width > best.width;
    const tie = gap.width === best.width;
    if (wider || (tie && (side === 'left' ? gap.left < best.left : gap.right > best.right))) {
      best = gap;
    }
  }
  return best;
}

/**
 * Find the widest usable free horizontal gap between taskbar buttons.
 * All values are in the same horizontal unit (callers pass CSS px).
 */
export function selectGap({ taskbarWidth, taskbarHeight, buttons, side }) {
  const intervals = [];
  for (const button of buttons ?? []) {
    if (button.w <= 1 || button.h < taskbarHeight * 0.5) continue;
    const left = Math.max(0, button.x);
    const right = Math.min(taskbarWidth, button.x + button.w);
    if (right <= left) continue;
    intervals.push({ left, right });
  }
  intervals.sort((a, b) => a.left - b.left);

  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.left <= last.right + 2) {
      last.right = Math.max(last.right, interval.right);
    } else {
      merged.push({ ...interval });
    }
  }

  const gaps = [];
  let cursor = 0;
  for (const interval of merged) {
    gaps.push({ left: cursor, right: interval.left, width: interval.left - cursor });
    cursor = Math.max(cursor, interval.right);
  }
  gaps.push({ left: cursor, right: taskbarWidth, width: taskbarWidth - cursor });

  const usable = gaps.filter((gap) => gap.width >= MIN_GAP_CSS);
  const chosen =
    pickWidest(usable, side, taskbarWidth) ??
    pickWidest(usable, side === 'left' ? 'right' : 'left', taskbarWidth);

  return chosen ? { left: chosen.left, right: chosen.right } : null;
}

/**
 * Clamp the strip window width to the available gap.
 * Returns 0 when the gap cannot fit a minimum-width window.
 */
export function clampWindowWidth({ contentWidthCss, gapWidthCss }) {
  const maxW = gapWidthCss - 2 * DOCK_MARGIN_CSS;
  if (maxW < MIN_WINDOW_CSS) return 0;
  return Math.min(
    Math.max(Math.ceil(contentWidthCss + 2 * WINDOW_PADDING_CSS), MIN_WINDOW_CSS),
    maxW
  );
}

/**
 * Index of the last lyric line whose time is <= timeMs, or -1 before the
 * first line.
 */
export function findLineIndex(lines, timeMs) {
  if (!lines?.length) return -1;
  if (timeMs < lines[0].time) return -1;

  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lines[mid].time <= timeMs) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Resolve what the strip should render for the current document/playback.
 */
export function resolveDisplay({ doc, playback }) {
  if (!doc || !doc.songPath) {
    return {
      mode: 'hidden',
      title: '',
      artist: '',
      lineIndex: -1,
      text: '',
      translation: '',
      nextText: '',
    };
  }

  const title = doc.title || '';
  const artist = doc.artist || '';
  if (!playback || playback.songPath !== doc.songPath || doc.isStatic || !doc.lines?.length) {
    return { mode: 'title', title, artist, lineIndex: -1, text: '', translation: '', nextText: '' };
  }

  const lineIndex = findLineIndex(doc.lines, playback.currentTimeMs);
  if (lineIndex < 0) {
    return { mode: 'title', title, artist, lineIndex: -1, text: '', translation: '', nextText: '' };
  }

  const line = doc.lines[lineIndex];
  const next = doc.lines[lineIndex + 1];
  const text = line.text || line.translation || '';
  const translation = line.text ? line.translation || '' : '';
  // 参考项目行为：第二行优先译文；没有译文时显示下一句（中文歌常见）
  const nextText = next ? next.text || next.translation || '' : '';
  return { mode: 'lyric', title, artist, lineIndex, text, translation, nextText };
}
