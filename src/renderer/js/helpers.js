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

// 淡出结束后清空文本，避免旧提示长期滞留在 DOM 里。用 transitionend 而不是加定时器：
// 清早了会把淡出中的胶囊清成空壳。过渡被禁用时这里不触发也没关系，
// visibility:hidden 已经保证它不可见、不可聚焦、不在无障碍树里。
syncToastEl?.addEventListener('transitionend', (e) => {
  if (e.propertyName === 'opacity' && !syncToastEl.classList.contains('visible')) {
    syncToastEl.innerText = '';
  }
});

export function showToast(text) {
  if (!syncToastEl) return;
  syncToastEl.innerText = text;
  syncToastEl.classList.add('visible');
  clearTimeout(state.syncToastTimer);
  state.syncToastTimer = setTimeout(() => syncToastEl.classList.remove('visible'), 3000);
}

export function showSyncToast(text) {
  showToast(text);
}
