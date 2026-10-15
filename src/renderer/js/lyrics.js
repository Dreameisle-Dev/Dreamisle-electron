import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import {
  audio,
  lyricsContainer,
  lyricsScroll,
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
// 所有「写入」和「清空」都走这里，免得漏清某一行、留下上一首的残句。
const MINI_LYRIC_SLOTS = [miniLyricPrevEl, miniLyricNowEl, miniLyricNextEl, miniLyricNext2El];
const MINI_NOW_SLOT = 1; // 当前句固定在第 2 行（用户选的「上 1 下 2」）

// activeIndex = 当前句下标；传 null 表示清空（切歌 / 无歌词 / 空库）。
// 开头还没唱到第一句时 activeIndex 为 -1，此时后两格会显示即将到来的句子，符合预期。
function setMiniLyrics(activeIndex = null) {
  MINI_LYRIC_SLOTS.forEach((el, i) => {
    if (!el) return;
    const line = activeIndex === null ? null : state.currentLyrics[activeIndex - MINI_NOW_SLOT + i];
    el.innerText = line ? line.text || '' : '';
    el.classList.toggle('now', activeIndex !== null && i === MINI_NOW_SLOT);
  });
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

export function renderLyricsToDom() {
  if (!lyricsScroll) return;
  lyricsScroll.innerHTML = '';
  state.lyricDoms = [];

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
