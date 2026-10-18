// Pure logic for placing the taskbar lyrics strip.
// No Electron, native, or DOM imports: unit-testable with plain `node --test`.

export const MIN_TEXT_CSS = 160;
export const WINDOW_PADDING_CSS = 12;
export const MIN_WINDOW_CSS = 184;
export const DOCK_MARGIN_CSS = 8;
export const MIN_GAP_CSS = 200;

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

const TASKBAR_EDGE_TOLERANCE_PX = 2;

/**
 * Only a horizontal taskbar docked at the bottom edge of the display is supported.
 * A bottom taskbar spans the display width and its bottom edge is at or below the
 * display's bottom edge: an auto-hidden taskbar is slid off-screen by Explorer, so
 * its bottom can extend past the display bottom by roughly the taskbar height.
 * Top taskbars fail the bottom-edge test, side taskbars fail the full-width test.
 */
export function isBottomTaskbar(rect, bounds) {
  if (!rect || !bounds) return false;
  const near = (a, b) => Math.abs(a - b) <= TASKBAR_EDGE_TOLERANCE_PX;
  const spansWidth = near(rect.left, bounds.x) && near(rect.right, bounds.x + bounds.width);
  // 单边比较：自动隐藏时任务栏会被滑到屏幕下方，底边远超屏幕底边
  const atBottom = rect.bottom >= bounds.y + bounds.height - TASKBAR_EDGE_TOLERANCE_PX;
  return spansWidth && atBottom;
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
