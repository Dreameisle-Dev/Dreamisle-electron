// 逐字高亮的共享 DOM 渲染与帧更新（供主窗口、桌面歌词、任务栏歌词共用）。
import { computeWordProgress } from './lyric-words.js';

const FEATHER_HALF_PCT = 3;

/**
 * 将字/词片段写入容器（全部使用 textContent，避免 HTML 注入）。
 * @returns {HTMLElement[]} 生成的 .lyric-word 元素列表
 */
export function renderWordSpans(container, words, fallbackText = '') {
  container.textContent = '';
  if (!Array.isArray(words) || words.length === 0) {
    container.textContent = fallbackText;
    return [];
  }

  const doc = container.ownerDocument;
  const frag = doc.createDocumentFragment();
  const spans = [];
  for (const word of words) {
    const span = doc.createElement('span');
    span.className = 'lyric-word todo';
    span.textContent = word.text;
    frag.appendChild(span);
    spans.push(span);
  }
  container.appendChild(frag);
  return spans;
}

/**
 * 按当前播放时间更新每个词的高亮状态（.done / .sweeping / .todo）及扫过渐变断点。
 * @param {HTMLElement[]} spans
 * @param {Array<{time:number, endTime:number}>} words
 * @param {number} timeMs
 * @param {{ smooth?: boolean }} [options]
 */
export function updateWordSpansProgress(spans, words, timeMs, { smooth = true } = {}) {
  if (!Array.isArray(spans) || !Array.isArray(words) || spans.length !== words.length) return;

  for (let i = 0; i < words.length; i++) {
    const el = spans[i];
    const progress = computeWordProgress(words[i], timeMs);

    if (progress <= 0) {
      if (!el.classList.contains('todo')) {
        el.classList.remove('done', 'sweeping');
        el.classList.add('todo');
      }
      continue;
    }

    if (progress >= 1 || !smooth) {
      if (!el.classList.contains('done')) {
        el.classList.remove('todo', 'sweeping');
        el.classList.add('done');
      }
      continue;
    }

    const centerPct = progress * 100;
    const stopA = Math.max(0, centerPct - FEATHER_HALF_PCT).toFixed(2);
    const stopB = Math.min(100, centerPct + FEATHER_HALF_PCT).toFixed(2);
    if (!el.classList.contains('sweeping')) {
      el.classList.remove('todo', 'done');
      el.classList.add('sweeping');
    }
    el.style.setProperty('--wp-a', `${stopA}%`);
    el.style.setProperty('--wp-b', `${stopB}%`);
  }
}
