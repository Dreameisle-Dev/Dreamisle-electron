import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import { audio, lyricsContainer, lyricsScroll, miniLyricsEl } from './dom.js';
import { escapeHtml } from './helpers.js';
import { updatePlayButton } from './playback.js';

export function parseLrc(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return [];
  const lines = lrcText.split(/\r\n|\r|\n/);

  const timeExp = /\[(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\]/g;
  let hasTimestamps = false;
  const result = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const matches = [...trimmedLine.matchAll(timeExp)];

    if (matches.length > 0) {
      hasTimestamps = true;
      const text = trimmedLine.replace(/\[\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?\]/g, '').trim();

      if (text) {
        for (const match of matches) {
          const min = parseInt(match[1]);
          const sec = parseInt(match[2]);
          const ms = match[3] ? parseFloat('0.' + match[3]) : 0;
          const time = min * 60 + sec + ms;
          result.push({ time, text });
        }
      }
    }
  }

  if (!hasTimestamps && lines.length > 0) {
    return lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^\[.*?\]$/.test(line))
      .map((text) => ({ time: 0, text, isStatic: true }));
  }

  result.sort((a, b) => a.time - b.time);
  return result;
}

export function groupTranslations(lyricsArray) {
  if (!lyricsArray || lyricsArray.length === 0 || lyricsArray[0].isStatic) return lyricsArray;

  const tempMap = new Map();
  for (const item of lyricsArray) {
    const timeKey = item.time.toFixed(2);
    if (tempMap.has(timeKey)) {
      tempMap.set(timeKey, tempMap.get(timeKey) + '\n' + item.text);
    } else {
      tempMap.set(timeKey, item.text);
    }
  }

  const result = Array.from(tempMap.entries()).map(([time, text]) => ({
    time: parseFloat(time),
    text,
  }));
  result.sort((a, b) => a.time - b.time);
  return result;
}

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
        state.currentLyrics = lrcData.syncText.map((item) => ({
          time: item.timestamp / 1000,
          text: item.text || '',
        }));
        state.currentLyrics.sort((a, b) => a.time - b.time);
      } else if (typeof lrcData.text === 'string') {
        state.currentLyrics = parseLrc(lrcData.text);
      } else if (lrcData.type === 'Buffer') {
        try {
          state.currentLyrics = parseLrc(new TextDecoder().decode(new Uint8Array(lrcData.data)));
        } catch (e) {}
      }
    } else if (typeof lrcData === 'string') {
      state.currentLyrics = parseLrc(lrcData);
    }
  }

  if (state.currentLyrics && state.currentLyrics.length > 0) {
    state.currentLyrics = groupTranslations(state.currentLyrics);
    // 统一过滤掉空白行，防止在不同歌词来源下，渲染列表与数据列表因空白行产生索引错位
    state.currentLyrics = state.currentLyrics.filter(
      (line) => line.text && line.text.trim() !== ''
    );
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

      const textParts = line.text.split('\n').map(escapeHtml);
      if (textParts.length > 1) {
        p.innerHTML = `${textParts[0]}<br><span style="font-size: 0.8em; opacity: 0.75; margin-top: 6px; display: inline-block; font-weight: 400;">${textParts.slice(1).join('<br>')}</span>`;
      } else {
        p.innerText = line.text;
      }

      if (!isStatic) {
        p.onclick = () => {
          audio.currentTime = line.time;
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

  let activeIndex = -1;
  for (let i = 0; i < state.currentLyrics.length; i++) {
    if (currentTime >= state.currentLyrics[i].time) activeIndex = i;
    else break;
  }

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
      const text = state.currentLyrics[activeIndex].text || '';
      miniLyricsEl.innerText = text.replace(/\n/g, ' / ');
      pushDesktopLyrics(miniLyricsEl.innerText);
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
