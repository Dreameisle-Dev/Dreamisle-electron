// 通用任务栏布局数学由独立开源子模块 `packages/electron-taskbar-widget` 提供；
// 本文件保留歌词专用的行定位与展示状态计算（供 taskbar-renderer.js 使用）。
export {
  MIN_TEXT_CSS,
  WINDOW_PADDING_CSS,
  MIN_WINDOW_CSS,
  DOCK_MARGIN_CSS,
  MIN_GAP_CSS,
  FIXED_STRIP_CSS,
  sideFor,
  shouldShow,
  shouldCoalesceProbe,
  computeLegacyTaskbarLayout,
  computeLegacyVerticalTaskbarLayout,
  selectGap,
  clampWindowWidth,
} from '../../packages/electron-taskbar-widget/src/layout.js';

/**
 * 返回最后一条时间戳 <= timeMs 的歌词行下标；尚未到达第一行或空数组返回 -1。
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
 * 根据当前歌词文档与播放进度计算任务栏歌词条要渲染的内容快照。
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
      words: null,
    };
  }

  const title = doc.title || '';
  const artist = doc.artist || '';
  if (!playback || playback.songPath !== doc.songPath || doc.isStatic || !doc.lines?.length) {
    return {
      mode: 'title',
      title,
      artist,
      lineIndex: -1,
      text: '',
      translation: '',
      nextText: '',
      words: null,
    };
  }

  const lineIndex = findLineIndex(doc.lines, playback.currentTimeMs);
  if (lineIndex < 0) {
    return {
      mode: 'title',
      title,
      artist,
      lineIndex: -1,
      text: '',
      translation: '',
      nextText: '',
      words: null,
    };
  }

  const line = doc.lines[lineIndex];
  const next = doc.lines[lineIndex + 1];
  const text = line.text || line.translation || '';
  const translation = line.text ? line.translation || '' : '';
  // 第二行优先显示译文；没有译文时显示下一句
  const nextText = next ? next.text || next.translation || '' : '';
  const words = line.text && Array.isArray(line.words) && line.words.length > 0 ? line.words : null;
  return { mode: 'lyric', title, artist, lineIndex, text, translation, nextText, words };
}
