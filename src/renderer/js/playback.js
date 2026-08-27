import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import {
  audio,
  coverContainer,
  coverImg,
  defaultCover,
  volumeHud,
  titleEl,
  artistEl,
  progressBar,
  currentTimeEl,
  totalTimeEl,
  btnPlay,
  btnMode,
  iconLoop,
  iconOne,
  iconShuffle,
} from './dom.js';
import { formatTime } from './helpers.js';
import { updateVirtualList } from './playlist.js';
import { loadAndRenderLyrics, syncLyrics } from './lyrics.js';
import { updateThemeColor, updateProgressStyle } from './theme.js';
import { onSongChanged, onCoverReady } from './stats.js';

audio.volume = 0.5;

// 拖动进度条直接拖到末尾会触发 ended,此类不计入完整播放:记录最近一次 seek 时间用于过滤
let lastSeekAt = 0;

export function initSongInfo(index) {
  if (index < 0 || index >= state.songs.length) return;
  state.currentIndex = index;
  const song = state.songs[index];
  audio.src = song.url;

  titleEl.innerText = song.title;
  artistEl.innerText = song.artist;
  updateVirtualList();

  updateCoverAndColor(song);
  loadAndRenderLyrics(song);
  onSongChanged();
}

export function playSong(index) {
  if (index < 0 || index >= state.songs.length) return;
  state.currentIndex = index;
  const song = state.songs[index];

  audio.src = song.url;
  audio.play();

  const infoContainer = document.querySelector('.song-info');
  infoContainer.classList.add('changing');

  setTimeout(() => {
    titleEl.innerText = song.title;
    artistEl.innerText = song.artist;
    infoContainer.classList.remove('changing');
  }, 300);

  updatePlayButton(true);

  state.vsStartIndex = -1;
  updateVirtualList();

  updateCoverAndColor(song);
  loadAndRenderLyrics(song);
  onSongChanged();

  saveStateOnChange();
}

export function playNext(auto = false) {
  if (state.songs.length === 0) return;
  if (auto && state.playMode === 1) {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  let next =
    state.playMode === 2
      ? Math.floor(Math.random() * state.songs.length)
      : (state.currentIndex + 1) % state.songs.length;
  playSong(next);
}

export async function updateCoverAndColor(song) {
  coverImg.style.display = 'none';
  defaultCover.style.display = 'flex';
  updateThemeColor(null);

  if (state.currentCoverBlobUrl) {
    URL.revokeObjectURL(state.currentCoverBlobUrl);
    state.currentCoverBlobUrl = null;
  }

  const coverUrl = await window.dreamApi.getCover(song.path);
  if (coverUrl) {
    state.currentCoverBlobUrl = coverUrl;
    coverImg.src = coverUrl;
    coverImg.style.display = 'block';
    defaultCover.style.display = 'none';
    updateThemeColor(coverUrl);
    onCoverReady(coverUrl);
  } else {
    onCoverReady(null);
  }
}

export function handleVolumeWheel(e) {
  e.preventDefault();
  let newVolume = audio.volume - (e.deltaY > 0 ? 0.05 : -0.05);
  if (newVolume > 1) newVolume = 1;
  if (newVolume < 0) newVolume = 0;
  audio.volume = newVolume;

  volumeHud.innerText = t('hud.volume', { n: Math.round(newVolume * 100) });
  volumeHud.classList.add('visible');
  clearTimeout(state.volumeTimeout);
  state.volumeTimeout = setTimeout(() => volumeHud.classList.remove('visible'), 1000);
  saveStateOnChange();
}

export function updatePlayButton(isPlaying) {
  document.getElementById('iconPlay').style.display = isPlaying ? 'none' : 'block';
  document.getElementById('iconPause').style.display = isPlaying ? 'block' : 'none';

  const ambientBg = document.querySelector('.ambient-bg');
  if (isPlaying) {
    document.querySelector('.album-art-container').classList.add('playing');
    if (ambientBg) ambientBg.classList.add('playing');
  } else {
    document.querySelector('.album-art-container').classList.remove('playing');
    if (ambientBg) ambientBg.classList.remove('playing');
  }
}

// 空库复位（如移除最后一个文件夹）：停止播放并复位界面与封面状态
export function resetToEmptyLibrary() {
  audio.pause();
  updatePlayButton(false);
  titleEl.innerText = 'Dreamisle';
  artistEl.innerText = t('app.waitingForMusic');
  if (state.currentCoverBlobUrl) {
    URL.revokeObjectURL(state.currentCoverBlobUrl);
    state.currentCoverBlobUrl = null;
  }
  coverImg.style.display = 'none';
  defaultCover.style.display = 'flex';
  updateThemeColor(null);
}

export async function savePlaybackState() {
  if (state.songs.length === 0) return;
  const stateToSave = {
    currentIndex: state.currentIndex,
    currentSongPath: state.songs[state.currentIndex] ? state.songs[state.currentIndex].path : null,
    currentTime: audio.currentTime || 0,
    volume: audio.volume,
    playMode: state.playMode,
    isPlaying: !audio.paused,
  };
  try {
    await window.dreamApi.savePlaybackState(stateToSave);
  } catch (e) {}
}

export function saveStateOnChange() {
  if (state.songs.length > 0) savePlaybackState();
}

export function bindPlaybackEvents() {
  btnMode.addEventListener('click', () => {
    state.playMode = (state.playMode + 1) % 3;
    iconLoop.style.display = state.playMode === 0 ? 'block' : 'none';
    iconOne.style.display = state.playMode === 1 ? 'block' : 'none';
    iconShuffle.style.display = state.playMode === 2 ? 'block' : 'none';
    saveStateOnChange();
  });

  audio.addEventListener('timeupdate', () => {
    if (!state.isDragging && audio.duration) {
      const p = (audio.currentTime / audio.duration) * 100;
      progressBar.value = p;
      updateProgressStyle(p);
      currentTimeEl.innerText = formatTime(audio.currentTime);
      totalTimeEl.innerText = formatTime(audio.duration);
      syncLyrics(audio.currentTime);
    }
  });

  progressBar.addEventListener('input', () => {
    state.isDragging = true;
    updateProgressStyle(progressBar.value);
    currentTimeEl.innerText = formatTime((progressBar.value / 100) * audio.duration);
  });

  progressBar.addEventListener('change', () => {
    state.isDragging = false;
    if (audio.duration) {
      const seekTime = (progressBar.value / 100) * audio.duration;
      audio.currentTime = seekTime;
      syncLyrics(seekTime);
    }
  });

  btnPlay.addEventListener('click', () => {
    if (audio.paused) {
      if (state.currentIndex === -1 && state.songs.length) playSong(0);
      else audio.play();
      updatePlayButton(true);
    } else {
      audio.pause();
      updatePlayButton(false);
    }
  });

  coverContainer.addEventListener('wheel', handleVolumeWheel);

  document.getElementById('btnNext').addEventListener('click', () => playNext(false));
  document.getElementById('btnPrev').addEventListener('click', () => {
    let prev = state.currentIndex - 1;
    if (state.playMode === 2) prev = Math.floor(Math.random() * state.songs.length);
    else if (prev < 0) prev = state.songs.length - 1;
    playSong(prev);
  });

  audio.addEventListener('seeking', () => {
    lastSeekAt = Date.now();
  });

  audio.addEventListener('ended', () => {
    // 完整播放计次;单曲循环模式下额外计一次循环重播(在切歌前捕获当前歌曲)
    const finished = state.songs[state.currentIndex];
    if (finished && Date.now() - lastSeekAt > 1000) {
      window.dreamApi.recordPlay(finished.path, 'full').catch(() => {});
      if (state.playMode === 1) window.dreamApi.recordPlay(finished.path, 'loop').catch(() => {});
    }
    playNext(true);
  });

  setInterval(() => {
    if (state.songs.length > 0) savePlaybackState();
  }, 60000);

  window.addEventListener('beforeunload', () => {
    if (state.songs.length > 0) {
      const stateToSave = {
        currentIndex: state.currentIndex,
        currentSongPath: state.songs[state.currentIndex]
          ? state.songs[state.currentIndex].path
          : null,
        currentTime: audio.currentTime || 0,
        volume: audio.volume,
        playMode: state.playMode,
        isPlaying: !audio.paused,
      };
      window.dreamApi.savePlaybackState(stateToSave).catch(() => {});
    }
  });

  audio.addEventListener('play', saveStateOnChange);
  audio.addEventListener('pause', saveStateOnChange);
  audio.addEventListener('volumechange', saveStateOnChange);
}
