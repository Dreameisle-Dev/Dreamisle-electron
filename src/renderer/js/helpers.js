import { state } from './state.js';
import { syncToastEl } from './dom.js';

export function formatTime(s) {
  const m = Math.floor(s / 60),
    sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 混排比对器：优先 A-Z 排序英文，然后按拼音排序中文，其余字符排在尾部
export function compareMixed(aStr, bStr) {
  const cleanA = (aStr || '').trim();
  const cleanB = (bStr || '').trim();

  if (!cleanA && !cleanB) return 0;
  if (!cleanA) return 1;
  if (!cleanB) return -1;

  const charA = cleanA[0];
  const charB = cleanB[0];

  const isLatin = (ch) => /^[a-zA-Z]/.test(ch);
  const isChinese = (ch) => /^[\u4e00-\u9fa5]/.test(ch);

  // 分类评级：1-英文 2-中文 3-数字或其它符号
  const typeA = isLatin(charA) ? 1 : isChinese(charA) ? 2 : 3;
  const typeB = isLatin(charB) ? 1 : isChinese(charB) ? 2 : 3;

  if (typeA !== typeB) {
    return typeA - typeB;
  }

  if (typeA === 1) {
    // 英文按标准 A-Z 忽略大小写及数字排序
    return cleanA.localeCompare(cleanB, 'en', { sensitivity: 'base', numeric: true });
  } else if (typeA === 2) {
    // 中文按本地化拼音排序
    return cleanA.localeCompare(cleanB, 'zh-CN', { numeric: true });
  } else {
    // 其它边缘符号或数字
    return cleanA.localeCompare(cleanB, undefined, { numeric: true });
  }
}

export function showSyncToast(text) {
  if (!syncToastEl) return;
  syncToastEl.innerText = text;
  syncToastEl.classList.add('visible');
  clearTimeout(state.syncToastTimer);
  state.syncToastTimer = setTimeout(() => syncToastEl.classList.remove('visible'), 3000);
}
