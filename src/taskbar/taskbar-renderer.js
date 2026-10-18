// 任务栏歌词条渲染器。
// 主进程只转发文档/播放状态；这里用本地时钟推算当前时间，rAF 里跨行边界，
// 不必依赖主窗口 timeupdate 的频率。只有显示内容真正变化时才改 DOM。
import { resolveDisplay } from './taskbar-gap.js';

const strip = document.getElementById('strip');
const coverEl = document.getElementById('cover');
const lineEl = document.getElementById('line');
const translationEl = document.getElementById('translation');

const COVER_GAP_PX = 10;
const COVER_FALLBACK_PX = 36;

let config = null;
let doc = null;
let playback = null;
let coverVisible = false;
// 本地时钟基准：最近一拍播放状态的毫秒数与到达时的 performance.now()
let clock = { baseTimeMs: 0, basePerf: performance.now(), playing: false, rate: 1 };
// 上一次写进 DOM 的显示内容；rAF 每帧都会算，但只有变化时才动 DOM
let lastRenderKey = '';
let reportedWidth = -1;

// 用一拍播放状态重置本地时钟。切歌时即使 songPath 与文档不一致也照常记录：
// resolveDisplay 会拒绝拿它定位旧文档的歌词行。
function applyPlayback(next) {
  playback = next || null;
  if (!playback) {
    clock = { baseTimeMs: 0, basePerf: performance.now(), playing: false, rate: 1 };
    return;
  }

  const rate = Number(playback.rate);
  clock = {
    baseTimeMs: Number(playback.currentTimeMs) || 0,
    basePerf: performance.now(),
    playing: !!playback.playing,
    rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
  };
}

function currentTimeMs() {
  if (!clock.playing) return clock.baseTimeMs;
  return clock.baseTimeMs + (performance.now() - clock.basePerf) * clock.rate;
}

function resolveNow() {
  return resolveDisplay({
    doc,
    playback: playback ? { ...playback, currentTimeMs: currentTimeMs() } : null,
  });
}

// 行切换：类里用 transition:none 立即落到起始态，移除类后按基础规则 180ms 淡入。
// 连续换行时重新添加类会立刻重置，不会叠加多个过渡。
function replayLineTransition() {
  lineEl.classList.add('line-change');
  void lineEl.offsetWidth; // 提交起始状态
  lineEl.classList.remove('line-change');
}

function updateDisplay(display) {
  const key = [
    display.mode,
    display.title,
    display.artist,
    display.text,
    display.translation,
    display.nextText,
  ].join('\u0000');
  if (key === lastRenderKey) return;
  lastRenderKey = key;

  const titleMode = display.mode === 'title';
  const hidden = display.mode === 'hidden';

  // 兜底文案（config.labels.appName）只在没有文档时使用
  const primary = hidden ? config?.labels?.appName || '' : titleMode ? display.title : display.text;
  // 参考项目的双行：优先当前句译文；没有译文时显示下一句。
  // 标题模式下第二行固定是歌手。翻译开关只影响“当前句译文”，不影响下一句。
  let secondary = '';
  if (!hidden) {
    if (titleMode) secondary = display.artist;
    else if (display.translation && (!config || config.translationVisible !== false)) {
      secondary = display.translation;
    } else {
      secondary = display.nextText || '';
    }
  }
  const showSecondary = !!secondary;

  if (lineEl.textContent !== primary) {
    lineEl.textContent = primary;
    replayLineTransition();
  }

  translationEl.textContent = showSecondary ? secondary : '';
  translationEl.hidden = !showSecondary;

  applyMarquee();
  reportWidth();
}

// ── 宽度上报 ──
// 主进程根据内容宽度收放窗口；测量的是封面 + 文本本身，窗口内边距由主进程统一加。
function coverZoneWidth() {
  if (!coverVisible) return 0;
  const width = coverEl.getBoundingClientRect().width || COVER_FALLBACK_PX;
  return width + COVER_GAP_PX;
}

function reportWidth() {
  const width = Math.ceil(
    coverZoneWidth() + Math.max(lineEl.scrollWidth, translationEl.scrollWidth)
  );
  if (!Number.isFinite(width) || width <= 0 || width === reportedWidth) return;
  reportedWidth = width;
  window.taskbarApi.reportWidth(width);
}

// ── 长行 marquee ──
// 动态插入 keyframes（CSSOM 不算内联样式，CSP style-src 'self' 下仍可用），
// 让两端各停 0.8s；静态 keyframes 作为 CSSOM 被拒时的降级版本。
let marqueeRuleIndex = null;

function ensureMarqueeKeyframes(durationSec) {
  const sheet = document.styleSheets[0];
  if (!sheet) return;

  const pausePct = Math.min(45, (0.8 / durationSec) * 100);
  if (marqueeRuleIndex !== null) {
    try {
      sheet.deleteRule(marqueeRuleIndex);
    } catch (e) {
      // 样式表被替换或规则已不在，忽略；下一帧会让 marquee 重新评估
    }
    marqueeRuleIndex = null;
  }

  const rule =
    '@keyframes taskbar-marquee {' +
    `0%, ${pausePct.toFixed(3)}% { transform: translateX(0); }` +
    `${(100 - pausePct).toFixed(3)}%, 100% { transform: translateX(var(--marquee-distance, 0px)); }` +
    '}';
  try {
    marqueeRuleIndex = sheet.insertRule(rule, sheet.cssRules.length);
  } catch (e) {
    // CSSOM 不可用时保留 CSS 里的静态 keyframes
  }
}

function applyMarquee() {
  const overflow = lineEl.scrollWidth - (window.innerWidth - 24 - coverZoneWidth());
  if (overflow > 0) {
    const durationSec = Math.max(5, overflow / 45);
    lineEl.classList.add('marquee');
    lineEl.style.setProperty('--marquee-distance', `-${Math.ceil(overflow)}px`);
    lineEl.style.setProperty('--marquee-duration', `${durationSec}s`);
    ensureMarqueeKeyframes(durationSec);
  } else {
    lineEl.classList.remove('marquee');
    lineEl.style.removeProperty('--marquee-distance');
    lineEl.style.removeProperty('--marquee-duration');
  }
}

// ── 主进程下发 ──
function applyConfig(next) {
  config = next || {};

  const light = config.lightTaskbar !== false;
  document.body.classList.toggle('light', light);
  document.body.classList.toggle('dark', !light);

  strip.style.fontFamily = config.fontFamily ? `"${config.fontFamily}"` : '';

  // 翻译开关/字体/兜底文案都可能变化，强制重新渲染一次
  lastRenderKey = '';
  updateDisplay(resolveNow());
  requestAnimationFrame(() => {
    applyMarquee();
    reportWidth();
  });
}

function applyCover(url) {
  coverVisible = typeof url === 'string' && url.length > 0;
  if (coverVisible) {
    coverEl.src = url;
    coverEl.hidden = false;
  } else {
    coverEl.removeAttribute('src');
    coverEl.hidden = true;
  }
  // 封面出现/消失会改变文字可用宽度，强制重算一次
  lastRenderKey = '';
  updateDisplay(resolveNow());
  requestAnimationFrame(() => {
    applyMarquee();
    reportWidth();
  });
}

window.taskbarApi.onConfig(applyConfig);
window.taskbarApi.onDocument((next) => {
  doc = next || null;
});
window.taskbarApi.onPlayback(applyPlayback);
window.taskbarApi.onCover(applyCover);

window.addEventListener('resize', () => {
  applyMarquee();
  reportWidth();
});

if (document.fonts && document.fonts.ready) {
  document.fonts.ready
    .then(() => {
      applyMarquee();
      reportWidth();
    })
    .catch(() => {});
}

// 本地时钟主循环：本地推算时间 → resolveDisplay → 仅在变化时改 DOM
function frame() {
  updateDisplay(resolveNow());
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
window.taskbarApi.ready();
