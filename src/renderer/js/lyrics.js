import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import { audio, lyricsContainer, lyricsScroll, miniLyricsEl } from './dom.js';
import { escapeHtml } from './helpers.js';
import { updatePlayButton } from './playback.js';
import universalLyricParser from '../../shared/universal-lyric-parser.js';
import { parseLyricsText, parseSyncLyrics } from '../../shared/lyrics-parse.js';

// 清空歌词状态：切换歌曲 / 空库复位时调用
export function resetLyrics() {
  state.currentLyrics = [];
  state.currentLineIndex = -1;
  state.lyricDoms = [];
  state.lastDesktopText = null;
  pushDesktopLyrics('');
  if (miniLyricsEl) miniLyricsEl.innerText = '';
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

  if (state.currentLyrics && state.currentLyrics.length > 0) {
    const fragment = document.createDocumentFragment();
    const isStatic = state.currentLyrics[0].isStatic;

    state.currentLyrics.forEach((line, index) => {
      const p = document.createElement('p');
      p.className = 'lyric-line';
      p.dataset.index = index;

      // 原文 + 翻译(原文下方小字);原文缺失时翻译顶替为主文本
      const mainText = line.text || line.translation || '';
      const translation = line.text && line.translation ? line.translation : null;
      p.innerHTML = `${escapeHtml(mainText)}${
        translation ? `<br><span class="lyric-translation">${escapeHtml(translation)}</span>` : ''
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
    if (miniLyricsEl) miniLyricsEl.innerText = '';
    pushDesktopLyrics('');
    return;
  }

  // 二分定位当前行(歌词时间为毫秒)
  const activeIndex = universalLyricParser.getCurrentIndex(state.currentLyrics, currentTime * 1000);

  if (activeIndex === state.currentLineIndex) return;

  if (state.currentLineIndex !== -1 && state.lyricDoms[state.currentLineIndex]) {
    state.lyricDoms[state.currentLineIndex].classList.remove('active');
  }

  state.currentLineIndex = activeIndex;

  if (activeIndex !== -1 && state.lyricDoms[activeIndex]) {
    const targetLine = state.lyricDoms[activeIndex];
    targetLine.classList.add('active');
    if (!state.isUserScrolling) {
      lyricsScroll.scrollTop =
        targetLine.offsetTop - lyricsContainer.clientHeight / 2 + targetLine.clientHeight / 2;
    }

    if (miniLyricsEl && state.currentLyrics[activeIndex]) {
      // 小窗与桌面歌词只显示原文,不含翻译
      const text = state.currentLyrics[activeIndex].text || '';
      miniLyricsEl.innerText = text;
      pushDesktopLyrics(text);
    }
  } else {
    if (miniLyricsEl) miniLyricsEl.innerText = '';
    pushDesktopLyrics('');
  }
}

// 向主进程推送桌面歌词文本（含翻译行合并、去重）
export function pushDesktopLyrics(text) {
  if (text === state.lastDesktopText) return;
  state.lastDesktopText = text;
  window.dreamApi.updateDesktopLyrics(text);
}

export function bindLyricsEvents() {
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
}
