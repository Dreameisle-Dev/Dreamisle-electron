import { setLang, applyLang } from '../shared/i18n.js';
import { normalizeLyricsStyle } from '../shared/lyrics-style.js';
import { renderWordSpans, updateWordSpansProgress } from '../shared/lyric-word-dom.js';

const capsule = document.getElementById('capsule');
const capsuleText = document.getElementById('capsuleText');
const capsuleSecond = document.getElementById('capsuleSecond');

let currentText = '';
let secondText = '';
let currentWords = null;
let currentWordSpans = [];
let lineSongPath = null;
let lastWordRenderKey = '';
let lines = 1; // 1 = 单行，2 = 双行
let performanceMode = false;
let rafId = 0;

let clock = {
  baseTimeMs: 0,
  basePerf: performance.now(),
  playing: false,
  rate: 1,
  songPath: null,
};

function currentTimeMs() {
  if (!clock.playing) return clock.baseTimeMs;
  return clock.baseTimeMs + (performance.now() - clock.basePerf) * clock.rate;
}

function clockMatchesLine() {
  return !lineSongPath || !clock.songPath || clock.songPath === lineSongPath;
}

function syncWords() {
  if (!currentWords || currentWordSpans.length === 0 || !clockMatchesLine()) return;
  updateWordSpansProgress(currentWordSpans, currentWords, currentTimeMs(), {
    smooth: !performanceMode,
  });
}

function stopLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function startLoop() {
  if (rafId || !currentWords || currentWordSpans.length === 0) return;
  if (!clock.playing || !clockMatchesLine()) return;

  const tick = () => {
    rafId = 0;
    if (!clock.playing || !currentWords || currentWordSpans.length === 0 || !clockMatchesLine()) {
      return;
    }
    syncWords();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function render() {
  const hasText = currentText && currentText.trim() !== '';
  const hasWords = hasText && Array.isArray(currentWords) && currentWords.length > 0;
  const wordsKey = hasWords
    ? `${lineSongPath || ''}\u0000${currentText}\u0000${currentWords[0].time}:${currentWords.length}`
    : hasText
      ? `plain\u0000${currentText}`
      : '';

  if (!hasText) {
    stopLoop();
    currentWordSpans = [];
    lastWordRenderKey = '';
    capsuleText.textContent = '';
  } else if (hasWords) {
    if (lastWordRenderKey !== wordsKey) {
      lastWordRenderKey = wordsKey;
      currentWordSpans = renderWordSpans(capsuleText, currentWords, currentText);
    }
    syncWords();
    if (clock.playing && clockMatchesLine()) startLoop();
    else stopLoop();
  } else {
    stopLoop();
    currentWordSpans = [];
    if (lastWordRenderKey !== wordsKey) {
      lastWordRenderKey = wordsKey;
      capsuleText.textContent = currentText;
    }
  }

  capsule.classList.toggle('placeholder', !hasText);

  const showSecond = hasText && lines === 2 && secondText && secondText.trim() !== '';
  capsuleSecond.textContent = showSecond ? secondText : '';
  capsuleSecond.hidden = !showSecond;

  if (!hasText) applyLang(); // 重新套用"暂无歌词"占位文案
}

// 用 textContent 渲染，防止 LRC 文本注入 HTML；payload = { text, secondText, words, songPath }
window.lyricsApi.onText((payload) => {
  if (typeof payload === 'string') {
    currentText = payload;
    secondText = '';
    currentWords = null;
    lineSongPath = null;
  } else {
    currentText = payload?.text || '';
    secondText = payload?.secondText || '';
    currentWords = Array.isArray(payload?.words) && payload.words.length > 0 ? payload.words : null;
    lineSongPath = typeof payload?.songPath === 'string' ? payload.songPath : null;
  }
  render();
});

window.lyricsApi.onPlayback((playback) => {
  if (!playback || typeof playback !== 'object') {
    clock = {
      baseTimeMs: 0,
      basePerf: performance.now(),
      playing: false,
      rate: 1,
      songPath: null,
    };
    stopLoop();
    return;
  }

  const rate = Number(playback.rate);
  clock = {
    baseTimeMs: Number(playback.currentTimeMs) || 0,
    basePerf: performance.now(),
    playing: !!playback.playing,
    rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
    songPath: typeof playback.songPath === 'string' ? playback.songPath : null,
  };

  syncWords();
  if (clock.playing && currentWords && currentWordSpans.length > 0 && clockMatchesLine()) {
    startLoop();
  } else {
    stopLoop();
  }
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
  performanceMode = raw.performance === true;
  document.body.classList.toggle('performance-mode', performanceMode);
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
