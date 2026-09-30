import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import {
  audio,
  coverContainer,
  coverImg,
  defaultCover,
  barThumb,
  volumeHud,
  titleEl,
  artistEl,
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

// 系统媒体控制（Windows SMTC / 媒体键）。媒体键行为加在下面的 setActionHandler 里，
// 不要另用 globalShortcut 注册 —— 会和这条管道抢，表现为系统浮层不出现。
const mediaSession = navigator.mediaSession || null;

function setMediaMetadata(song, coverUrl) {
  if (!mediaSession || !song) return;
  mediaSession.metadata = new MediaMetadata({
    title: song.title || '',
    artist: song.artist || '',
    album: song.album || '',
    // 封面是 blob: URL —— Chromium 自己解码成位图交给系统，不用落地成文件
    artwork: coverUrl ? [{ src: coverUrl, sizes: '512x512' }] : [],
  });
}

function setPlaybackState(isPlaying) {
  if (!mediaSession) return;
  mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
}

// 系统浮层的进度条。position 必须落在 [0, duration] 内，否则 setPositionState 会抛 ——
// 切歌瞬间 currentTime 和 duration 会短暂对不上，所以每次都夹一下。
function setPositionState() {
  if (!mediaSession || !mediaSession.setPositionState) return;
  if (!audio.duration || !Number.isFinite(audio.duration)) return;
  try {
    mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(Math.max(audio.currentTime, 0), audio.duration),
    });
  } catch (e) {}
}

export function initSongInfo(index) {
  if (index < 0 || index >= state.songs.length) return;
  state.currentIndex = index;
  const song = state.songs[index];
  audio.src = song.url;

  titleEl.innerText = song.title;
  artistEl.innerText = song.artist;
  setMediaMetadata(song); // 封面等 updateCoverAndColor 拿到后再补
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

  titleEl.innerText = song.title;
  artistEl.innerText = song.artist;
  setMediaMetadata(song); // 封面等 updateCoverAndColor 拿到后再补

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
    if (barThumb) barThumb.src = coverUrl;
    updateThemeColor(coverUrl);
    setMediaMetadata(song, coverUrl); // 系统浮层的封面
    onCoverReady(coverUrl);
  } else {
    if (barThumb) barThumb.removeAttribute('src');
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

// 上一首。按钮和系统媒体键共用一份逻辑，避免两处各写一遍走岔。
export function playPrev() {
  if (state.songs.length === 0) return;
  let prev = state.currentIndex - 1;
  if (state.playMode === 2) prev = Math.floor(Math.random() * state.songs.length);
  else if (prev < 0) prev = state.songs.length - 1;
  playSong(prev);
}

// 系统媒体键 / 系统浮层上的按钮，全部走应用自己的播放逻辑
function registerMediaSessionHandlers() {
  if (!mediaSession) return;
  const on = (action, handler) => {
    try {
      mediaSession.setActionHandler(action, handler);
    } catch (e) {
      // 个别 action 在旧 Chromium 上不存在，忽略即可
    }
  };

  on('play', () => {
    if (audio.paused) {
      if (state.currentIndex === -1 && state.songs.length) playSong(0);
      else audio.play();
      updatePlayButton(true);
    }
  });
  on('pause', () => {
    audio.pause();
    updatePlayButton(false);
  });
  on('previoustrack', () => playPrev());
  on('nexttrack', () => playNext(false));
  on('seekto', (d) => {
    if (typeof d.seekTime !== 'number' || !audio.duration) return;
    audio.currentTime = Math.min(Math.max(d.seekTime, 0), audio.duration);
    updateProgressStyle((audio.currentTime / audio.duration) * 100);
    currentTimeEl.innerText = formatTime(audio.currentTime);
    syncLyrics(audio.currentTime);
  });
  on('seekbackward', (d) => {
    audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10));
  });
  on('seekforward', (d) => {
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10));
  });
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
  if (mediaSession) {
    mediaSession.metadata = null;
    mediaSession.playbackState = 'none';
  }
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
      updateProgressStyle(p);
      currentTimeEl.innerText = formatTime(audio.currentTime);
      totalTimeEl.innerText = formatTime(audio.duration);
      syncLyrics(audio.currentTime);
      setPositionState();
    }
  });

  // 进度可视化不是 range input，seek 由点击位置的比例直接算出。
  // 原来的 input/change 两个监听器（拖拽预览 + 提交）因此一并去掉。
  const vizWrap = document.getElementById('vizWrap');
  if (vizWrap) {
    vizWrap.addEventListener('click', (e) => {
      if (!audio.duration) return;
      const r = vizWrap.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      audio.currentTime = ratio * audio.duration;
      updateProgressStyle(ratio * 100);
      currentTimeEl.innerText = formatTime(audio.currentTime);
      syncLyrics(audio.currentTime);
    });
  }

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
  document.getElementById('btnPrev').addEventListener('click', () => playPrev());

  // 系统媒体控制：按钮回调 + 播放状态同步
  registerMediaSessionHandlers();
  audio.addEventListener('play', () => setPlaybackState(true));
  audio.addEventListener('pause', () => setPlaybackState(false));

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
