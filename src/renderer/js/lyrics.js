import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import {
  audio,
  lyricsContainer,
  lyricsScroll,
  miniLyricsBoxEl,
  miniLyricPrevEl,
  miniLyricNowEl,
  miniLyricNextEl,
  miniLyricNext2El,
  btnLyricTranslation,
} from './dom.js';
import { escapeHtml } from './helpers.js';
import { updatePlayButton } from './playback.js';
import universalLyricParser from '../../shared/universal-lyric-parser.js';
import { parseLyricsText, parseSyncLyrics } from '../../shared/lyrics-parse.js';

// 小窗四行：上一句 / 当前句 / 后两句。只显示原文，不含翻译（与桌面歌词一致）。
const MINI_LYRIC_SLOTS = [miniLyricPrevEl, miniLyricNowEl, miniLyricNextEl, miniLyricNext2El];
const MINI_NOW_SLOT = 1; // 当前句固定在第 2 行（用户选的「上 1 下 2」）
const MINI_FADE_MS = 110; // 淡出、淡入各一半，整段约 220ms（只压暗到 0.35，不淡到全透明）

let miniSwapTimer = null;

// 把四行文本、当前句标记、模糊量写进 DOM（不含动画）
function writeMiniLyrics(activeIndex) {
  MINI_LYRIC_SLOTS.forEach((el, i) => {
    if (!el) return;
    const line = activeIndex === null ? null : state.currentLyrics[activeIndex - MINI_NOW_SLOT + i];
    el.innerText = line ? line.text || '' : '';
    el.classList.toggle('now', activeIndex !== null && i === MINI_NOW_SLOT);
    // 渐变：离当前句越远越糊、也越暗（和主界面同一套折算式）。
    // 四行距离只有 0/1/2，所以实际是 0/0.35/0.70 与 1/0.88/0.76
    applyLineDepth(el, activeIndex === null ? 0 : Math.abs(i - MINI_NOW_SLOT));
  });
}

// activeIndex = 当前句下标；传 null 表示清空（切歌 / 无歌词 / 空库）。
// 开头还没唱到第一句时 activeIndex 为 -1，此时后两格会显示即将到来的句子，符合预期。
//
// 换句走「淡出 → 换字 → 淡入」：光标闪一下换掉比硬切柔和得多。
// 代价是新句子要等 MINI_FADE_MS 才最亮 —— 130ms 在歌词尺度上察觉不到。
function setMiniLyrics(activeIndex = null) {
  if (!miniLyricsBoxEl) return;
  clearTimeout(miniSwapTimer);

  if (activeIndex === null) {
    // 清空不走动画：切歌时还要慢慢淡出会显得拖沓
    miniLyricsBoxEl.classList.remove('swapping');
    writeMiniLyrics(null);
    return;
  }

  miniLyricsBoxEl.classList.add('swapping'); // CSS：opacity → 0
  miniSwapTimer = setTimeout(() => {
    writeMiniLyrics(activeIndex);
    miniLyricsBoxEl.classList.remove('swapping');
  }, MINI_FADE_MS);
}

// 清空歌词状态：切换歌曲 / 空库复位时调用
export function resetLyrics() {
  state.currentLyrics = [];
  state.currentLineIndex = -1;
  state.lyricDoms = [];
  state.lastDesktopText = null;
  pushDesktopLyrics('');
  setMiniLyrics();
}

export async function loadAndRenderLyrics(song) {
  resetLyrics();

  if (lyricsScroll) {
    lyricsScroll.innerHTML = `<p class="lyric-line placeholder">${t('lyrics.loading')}</p>`;
    lyricsScroll.scrollTop = 0;
  }

  let lrcData = await window.dreamApi.getLyrics(song.path);

  if (lrcData) {
    if (typeof lrcData === 'object' && lrcData !== null) {
      if (Array.isArray(lrcData.syncText) && lrcData.syncText.length > 0) {
        // 富格式歌词源:统一转 LRC 文本走解析器,使内嵌同步歌词同样支持行内双语拆分
        state.currentLyrics = parseSyncLyrics(lrcData.syncText).lines;
      } else if (typeof lrcData.text === 'string') {
        state.currentLyrics = parseLyricsText(lrcData.text).lines;
      } else if (lrcData.type === 'Buffer') {
        try {
          state.currentLyrics = parseLyricsText(
            new TextDecoder().decode(new Uint8Array(lrcData.data))
          ).lines;
        } catch (e) {}
      }
    } else if (typeof lrcData === 'string') {
      state.currentLyrics = parseLyricsText(lrcData).lines;
    }
  }

  renderLyricsToDom();
}

// ── 渐变：离当前播放行越远，越糊、也越暗 ──
//
// 两个量一起衰减，不能只做模糊：只糊不暗的话，远处的行会「糊在原地」——
// 糊成一片却仍然满亮度，看着像一块污渍，而不是退到背景里。
//
// 步长刻意取小。每行一个固定值，本质是一级一级的阶梯（不是空间上连续的渐变），
// 步长一大（0.6）相邻两行的差别肉眼就能看出来，整块读起来很跳。
//
// 以主界面字号（当前行 36u≈24px、其余 28u≈19px）为准的取值：
//   距离   0     1     2     3     4     ≥5
//   模糊   0    0.35  0.70  1.05  1.40  1.75→1.8
//   亮度  1.00  0.88  0.76  0.64  0.52  0.45
const BLUR_STEP = 0.35;
const BLUR_MAX = 1.8;
const DIM_STEP = 0.12;
const DIM_MIN = 0.45;

// 每行上次写入时用的距离。距离没变就跳过 —— 距离超过封顶之后大多数行都不再变化，
// 不跳过的话每次换行都要给整首歌词（可能几百行）重写一遍自定义属性，
// 每行还各自跑一次 filter/opacity 过渡。
let lineDist = [];

function applyBlurGradient() {
  // 静态歌词（无时间戳的纯文本）压根没有「当前行」，整块统一就行，不做梯度
  if (state.lyricDoms.length === 0 || state.currentLyrics[0]?.isStatic) return;
  // 还没唱到第一句时 currentLineIndex 是 -1；按第 0 行算，
  // 否则梯度会停在「上一次有效位置」不再更新
  const active = Math.max(0, state.currentLineIndex);
  for (let i = 0; i < state.lyricDoms.length; i++) {
    const dist = Math.abs(i - active);
    if (lineDist[i] === dist) continue;
    lineDist[i] = dist;
    applyLineDepth(state.lyricDoms[i], dist);
  }
}

// 把「离当前行多远」折算成模糊量与亮度，写进该行的自定义属性（CSS 负责消费）
function applyLineDepth(el, dist) {
  el.style.setProperty('--lyric-blur', `${Math.min(BLUR_MAX, dist * BLUR_STEP)}px`);
  el.style.setProperty('--lyric-dim', `${Math.max(DIM_MIN, 1 - dist * DIM_STEP)}`);
}

export function renderLyricsToDom() {
  if (!lyricsScroll) return;
  lyricsScroll.innerHTML = '';
  state.lyricDoms = [];
  lineDist = []; // 行重建了，上一版记的距离不再对应，必须清掉

  // 当前歌词没有任何翻译行时,隐藏翻译开关按钮
  const hasAnyTranslation = (state.currentLyrics || []).some((l) => l.translation);
  btnLyricTranslation.style.display = hasAnyTranslation ? 'flex' : 'none';

  if (state.currentLyrics && state.currentLyrics.length > 0) {
    const fragment = document.createDocumentFragment();
    const isStatic = state.currentLyrics[0].isStatic;

    state.currentLyrics.forEach((line, index) => {
      const p = document.createElement('p');
      p.className = 'lyric-line';
      p.dataset.index = index;

      // 原文 + 翻译(原文下方小字,可开关);原文缺失时翻译顶替为主文本
      const mainText = line.text || line.translation || '';
      const translation =
        state.showLyricsTranslation && line.text && line.translation ? line.translation : null;
      // 原文与译文是两个独立 span（原来中间夹了 <br>）。样式上靠 flex 列 +
      // 5px 间距把它们贴成一对，不需要换行符。
      p.innerHTML = `<span class="lyric-text">${escapeHtml(mainText)}</span>${
        translation ? `<span class="lyric-translation">${escapeHtml(translation)}</span>` : ''
      }`;

      if (!isStatic) {
        p.onclick = () => {
          audio.currentTime = line.time / 1000;
          if (audio.paused) {
            audio.play();
            updatePlayButton(true);
          }
        };
      } else {
        p.style.cursor = 'default';
        p.style.opacity = '0.9';
        p.style.margin = '8px 0';
      }
      fragment.appendChild(p);
      state.lyricDoms.push(p);
    });
    lyricsScroll.appendChild(fragment);

    // 重渲染后恢复当前播放行的高亮(翻译开关切换会触发重渲染,currentLineIndex 未变)
    if (!isStatic && state.currentLineIndex !== -1 && state.lyricDoms[state.currentLineIndex]) {
      state.lyricDoms[state.currentLineIndex].classList.add('active');
      setupLineMarquee(state.lyricDoms[state.currentLineIndex]);
    }
    applyBlurGradient(); // 重渲染后模糊梯度也要补一遍（开关翻译会走到这里）
  } else {
    lyricsScroll.innerHTML = `<p class="lyric-line placeholder">Dreamisle<br><br>${t('lyrics.noLyrics')}</p>`;
  }
}

export function syncLyrics(currentTime) {
  if (
    !state.currentLyrics.length ||
    state.currentLyrics[0].isStatic ||
    state.lyricDoms.length === 0
  ) {
    setMiniLyrics();
    pushDesktopLyrics('');
    return;
  }

  // 二分定位当前行(歌词时间为毫秒)
  const activeIndex = universalLyricParser.getCurrentIndex(state.currentLyrics, currentTime * 1000);

  if (activeIndex === state.currentLineIndex) return;

  if (state.currentLineIndex !== -1 && state.lyricDoms[state.currentLineIndex]) {
    const prev = state.lyricDoms[state.currentLineIndex];
    prev.classList.remove('active');
    // 必须一并清掉滚动动画：只移除 active 的话，凡是当过当前行的歌词都会
    // 永久保留 overflowing 的水平偏移，表现为左侧文字被裁掉。
    clearLineMarquee(prev);
  }

  state.currentLineIndex = activeIndex;
  applyBlurGradient(); // 换了当前行，整条梯度跟着挪一格

  if (activeIndex !== -1 && state.lyricDoms[activeIndex]) {
    const targetLine = state.lyricDoms[activeIndex];
    targetLine.classList.add('active');
    setupLineMarquee(targetLine); // 激活行长文本水平滚动
    if (!state.isUserScrolling) {
      lyricsScroll.scrollTop =
        targetLine.offsetTop - lyricsContainer.clientHeight / 2 + targetLine.clientHeight / 2;
    }

    if (state.currentLyrics[activeIndex]) {
      // 小窗与桌面歌词只显示原文,不含翻译
      const text = state.currentLyrics[activeIndex].text || '';
      setMiniLyrics(activeIndex);
      pushDesktopLyrics(text);
    }
  } else {
    setMiniLyrics();
    pushDesktopLyrics('');
  }
}

// 翻译开关:更新按钮激活态与标题,重渲染歌词
export function setLyricsTranslationVisible(visible) {
  state.showLyricsTranslation = !!visible;
  btnLyricTranslation.classList.toggle('active', state.showLyricsTranslation);
  btnLyricTranslation.title = t(
    state.showLyricsTranslation ? 'lyrics.translationHide' : 'lyrics.translationShow'
  );
  renderLyricsToDom();
}

export function toggleLyricsTranslation() {
  setLyricsTranslationVisible(!state.showLyricsTranslation);
  window.dreamApi.setLyricsTranslation(state.showLyricsTranslation).catch(() => {});
}

// 清除一行的水平滚动状态（换行时对旧行调用，否则它会一直偏移）
function clearLineMarquee(lineEl) {
  if (!lineEl) return;
  for (const el of [
    lineEl.querySelector('.lyric-text'),
    lineEl.querySelector('.lyric-translation'),
  ]) {
    if (el) el.classList.remove('overflowing');
  }
}

// 激活行长文本水平滚动:原文/翻译各自检测溢出,设置滚动距离与时长
function setupLineMarquee(lineEl) {
  const spans = [
    lineEl.querySelector('.lyric-text'),
    lineEl.querySelector('.lyric-translation'),
  ].filter(Boolean);

  for (const el of spans) {
    const overflow = el.scrollWidth - lineEl.clientWidth;
    if (overflow > 0) {
      el.classList.add('overflowing');
      el.style.setProperty('--marquee-shift', `-${overflow}px`);
      el.style.setProperty('--marquee-duration', `${Math.max(4, overflow / 40)}s`);
    } else {
      el.classList.remove('overflowing');
    }
  }
}

// 向主进程推送桌面歌词文本（含翻译行合并、去重）
export function pushDesktopLyrics(text) {
  if (text === state.lastDesktopText) return;
  state.lastDesktopText = text;
  window.dreamApi.updateDesktopLyrics(text);
}

export function bindLyricsEvents() {
  if (btnLyricTranslation) btnLyricTranslation.onclick = toggleLyricsTranslation;

  lyricsScroll.addEventListener('wheel', () => {
    state.isUserScrolling = true;
    clearTimeout(state.userScrollTimeout);
    state.userScrollTimeout = setTimeout(() => {
      state.isUserScrolling = false;
      if (state.currentLineIndex !== -1 && state.lyricDoms[state.currentLineIndex]) {
        const activeLine = state.lyricDoms[state.currentLineIndex];
        lyricsScroll.scrollTop =
          activeLine.offsetTop - lyricsContainer.clientHeight / 2 + activeLine.clientHeight / 2;
      }
    }, 3000);
  });

  // 窗口尺寸变化时重测激活行溢出(滚动距离与容器宽度相关)
  window.addEventListener('resize', () => {
    if (state.currentLineIndex !== -1 && state.lyricDoms[state.currentLineIndex]) {
      setupLineMarquee(state.lyricDoms[state.currentLineIndex]);
    }
  });
}
