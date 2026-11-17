import { setLang, applyLang } from '../shared/i18n.js';
import { normalizeLyricsStyle } from '../shared/lyrics-style.js';

const capsule = document.getElementById('capsule');
const capsuleText = document.getElementById('capsuleText');
const capsuleSecond = document.getElementById('capsuleSecond');

let currentText = '';
let secondText = '';
let lines = 1; // 1 = 单行，2 = 双行

function render() {
  const hasText = currentText && currentText.trim() !== '';
  capsuleText.textContent = hasText ? currentText : '';
  capsule.classList.toggle('placeholder', !hasText);

  const showSecond = hasText && lines === 2 && secondText && secondText.trim() !== '';
  capsuleSecond.textContent = showSecond ? secondText : '';
  capsuleSecond.hidden = !showSecond;

  if (!hasText) applyLang(); // 重新套用"暂无歌词"占位文案
}

// 用 textContent 渲染，防止 LRC 文本注入 HTML；payload = { text, secondText }
window.lyricsApi.onText((payload) => {
  if (typeof payload === 'string') {
    currentText = payload;
    secondText = '';
  } else {
    currentText = payload?.text || '';
    secondText = payload?.secondText || '';
  }
  render();
});

// 语言切换：重刷占位文案（仅在占位状态下刷新，避免覆盖正在显示的歌词）
window.lyricsApi.onLang((lang) => {
  setLang(lang);
  if (capsule.classList.contains('placeholder')) applyLang();
});

// 样式设置：先归一化校验再映射到 CSS 变量；lines 控制单/双行
window.lyricsApi.onStyle((style) => {
  const raw = style || {};
  const s = normalizeLyricsStyle(raw);
  lines = raw.lines === 2 ? 2 : 1;
  document.body.classList.toggle('performance-mode', raw.performance === true);
  document.documentElement.style.setProperty('--capsule-bg', `rgba(0, 0, 0, ${s.bgOpacity / 100})`);
  document.documentElement.style.setProperty('--capsule-opacity', String(s.textOpacity / 100));
  document.documentElement.style.setProperty('--capsule-color', s.textColor);
  // 自定义字体：为空时移除变量，回退到 .capsule 的默认字体栈
  if (s.fontFamily) {
    document.documentElement.style.setProperty('--capsule-font-family', `"${s.fontFamily}"`);
  } else {
    document.documentElement.style.removeProperty('--capsule-font-family');
  }
  render();
});
