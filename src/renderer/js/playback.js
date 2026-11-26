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
  albumEl,
  currentTimeEl,
  totalTimeEl,
  vizWrap,
  vizHoverLine,
  vizTooltip,
  vizTooltipTime,
  vizTooltipLyric,
  miniProgress,
  btnPlay,
  btnMode,
  iconLoop,
  iconOne,
  iconShuffle,
} from './dom.js';
import { formatTime } from './helpers.js';
import { updateVirtualList } from './playlist.js';
import { loadAndRenderLyrics, syncLyrics, getLyricPreviewAt } from './lyrics.js';
import { updateThemeColor, updateProgressStyle } from './theme.js';
import { buildPlaybackState } from '../../shared/taskbar-lyrics-document.js';
import { createShuffleSession } from '../../shared/shuffle.js';

const shuffleSession = createShuffleSession();

export function resetShuffle() {
  shuffleSession.reset();
}

export function syncShuffleCurrent(index = state.currentIndex) {
  if (state.playMode === 2 && state.songs.length > 0 && index >= 0) {
    shuffleSession.syncCurrent(state.songs, index);
  }
}

export function isShuffleNext(targetIndex) {
  return state.playMode === 2 && shuffleSession.isNext(targetIndex);
}

export function pinShuffleNext(targetIndex) {
  if (state.playMode === 2) {
    shuffleSession.pinNext(state.songs, state.currentIndex, targetIndex);
  }
}

export function syncShuffleOnReorder(from, to) {
  shuffleSession.onQueueReorder(from, to);
}

export function syncShuffleOnMoveToNext(from, to) {
  if (state.playMode === 2) {
    shuffleSession.onQueueMoveToNext(state.songs, state.currentIndex, from, to);
  } else {
    shuffleSession.onQueueReorder(from, to);
  }
}

export function syncShuffleOnInsert(insertAt, { playNext = false } = {}) {
  if (state.playMode === 2) {
    shuffleSession.onQueueInsert(state.songs, state.currentIndex, insertAt, { playNext });
  } else {
    shuffleSession.reset();
  }
}

export function syncShuffleOnRemove(removedIndex) {
  shuffleSession.onQueueRemove(removedIndex);
}

// 默认音量 100%；启动恢复播放状态时如果存过音量，会用保存值覆盖
audio.volume = 1;

// 任务栏歌词播放状态：timeupdate 约 4Hz，再节流到 ≥200ms；切歌/暂停/跳转时强制补一拍。
const TASKBAR_PLAYBACK_MIN_INTERVAL_MS = 200;
let lastTaskbarPlaybackAt = -Infinity;

export function pushTaskbarPlayback(force = false) {
  const song = state.songs[state.currentIndex];
  if (!song) return;

  const now = performance.now();
  if (!force && now - lastTaskbarPlaybackAt < TASKBAR_PLAYBACK_MIN_INTERVAL_MS) return;
  lastTaskbarPlaybackAt = now;

  window.dreamApi.updateTaskbarLyricsPlayback(
    buildPlaybackState(song, {
      currentTimeSec: audio.currentTime,
      playing: !audio.paused,
      rate: audio.playbackRate || 1,
    })
  );
}

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

// 歌名/歌手/专辑三行一起写。主窗口的传输条只显示前两行（.bar-album 平时 display:none），
// 小窗三行都显示 —— 所以凡是改这几行的地方都得走这里，
// 否则小窗的专辑行会留着上一首的内容。
function setTrackInfo(song) {
  titleEl.innerText = song.title;
  artistEl.innerText = song.artist;
  albumEl.innerText = song.album || '';
}

// 切语言后恢复动态曲目信息：barArtist 不再挂 data-i18n，避免被 applyLang 覆盖；
// 空库则回到当前语言的“等待音乐中”。
window.addEventListener('dreamisle:language-changed', () => {
  const song = state.songs[state.currentIndex];
  if (song) setTrackInfo(song);
  else artistEl.innerText = t('app.waitingForMusic');
});

export function initSongInfo(index, { preloadedCoverUrl, preloadedLyrics } = {}) {
  if (index < 0 || index >= state.songs.length) return;
  if (cancelActiveScrub) cancelActiveScrub(false);
  state.currentIndex = index;
  if (state.playMode === 2) shuffleSession.syncCurrent(state.songs, index);
  const song = state.songs[index];
  audio.src = song.url;

  setTrackInfo(song);
  setMediaMetadata(song); // 封面等 updateCoverAndColor 拿到后再补
  state.vsStartIndex = -1;
  updateVirtualList();

  updateCoverAndColor(song, preloadedCoverUrl);
  loadAndRenderLyrics(song, preloadedLyrics);
  window.dispatchEvent(new Event('dreamisle:song-changed'));
  pushTaskbarPlayback(true);
}

export function playSong(index, { fromShuffle = false } = {}) {
  if (index < 0 || index >= state.songs.length) return;
  if (cancelActiveScrub) cancelActiveScrub(false);
  state.currentIndex = index;
  if (state.playMode === 2 && !fromShuffle) {
    shuffleSession.syncCurrent(state.songs, index);
  }
  const song = state.songs[index];

  audio.src = song.url;
  audio.play().catch(() => {});

  setTrackInfo(song);
  setMediaMetadata(song); // 封面等 updateCoverAndColor 拿到后再补

  updatePlayButton(true);

  state.vsStartIndex = -1;
  updateVirtualList();

  updateCoverAndColor(song);
  loadAndRenderLyrics(song);
  window.dispatchEvent(new Event('dreamisle:song-changed'));

  saveStateOnChange();
  pushTaskbarPlayback(true);
}

export function playNext(auto = false) {
  if (state.songs.length === 0) return;
  if (auto && state.playMode === 1) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (state.playMode === 2) {
    const next = shuffleSession.next(state.songs, state.currentIndex);
    if (next >= 0) playSong(next, { fromShuffle: true });
    return;
  }
  const next = (state.currentIndex + 1) % state.songs.length;
  playSong(next);
}

let coverRequestToken = 0;
let coverCoalesceTimer = null;
let coverPrefetchTimer = null;
let lastCoverSwitchAt = 0;

// 渲染进程封面 URL 缓存（存 58B 稳定 dream-thumb:// 字符串或 null）+ 热解码位图池（最多 10 张，淘汰即清空 src 释放）
const MAX_COVER_URL_CACHE = 300;
const MAX_WARM_COVER_IMAGES = 10;
const RAPID_SWITCH_WINDOW_MS = 130;
const BURST_COALESCE_MS = 55;
const PREFETCH_DELAY_MS = 110;

const coverUrlCache = new Map();
const warmCoverImages = new Map();

function revokeIfBlobUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

function getCachedCoverUrl(songPath) {
  if (!coverUrlCache.has(songPath)) return undefined;
  const hit = coverUrlCache.get(songPath);
  coverUrlCache.delete(songPath);
  coverUrlCache.set(songPath, hit);
  return hit;
}

function setCachedCoverUrl(songPath, url) {
  // 仅缓存稳定 dream-thumb:// URL 与 null；兜底 blob: 不放长期缓存避免生命周期混乱
  if (typeof url === 'string' && url.startsWith('blob:')) return;
  coverUrlCache.delete(songPath);
  coverUrlCache.set(songPath, url || null);
  if (coverUrlCache.size > MAX_COVER_URL_CACHE) {
    const oldestKey = coverUrlCache.keys().next().value;
    coverUrlCache.delete(oldestKey);
  }
}

function getWarmDecodedCover(url) {
  if (!url || !warmCoverImages.has(url)) return null;
  const img = warmCoverImages.get(url);
  warmCoverImages.delete(url);
  warmCoverImages.set(url, img);
  return img.complete && img.naturalWidth > 0 ? img : null;
}

function warmDecodeCover(url) {
  if (!url) return Promise.resolve(null);
  const existing = warmCoverImages.get(url);
  if (existing) {
    warmCoverImages.delete(url);
    warmCoverImages.set(url, existing);
    if (existing.complete && existing.naturalWidth > 0) return Promise.resolve(existing);
    return existing.decode().then(
      () => existing,
      () => existing
    );
  }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = url;
  warmCoverImages.delete(url);
  warmCoverImages.set(url, img);

  if (warmCoverImages.size > MAX_WARM_COVER_IMAGES) {
    const oldestUrl = warmCoverImages.keys().next().value;
    if (oldestUrl !== url) {
      const oldImg = warmCoverImages.get(oldestUrl);
      if (oldImg) oldImg.src = '';
      warmCoverImages.delete(oldestUrl);
    }
  }

  return img.decode().then(
    () => img,
    () => img
  );
}

function applyResolvedCover(song, coverUrl, decodedImg = null) {
  const prevUrl = state.currentCoverBlobUrl;
  if (prevUrl && prevUrl !== coverUrl) {
    revokeIfBlobUrl(prevUrl);
  }
  state.currentCoverBlobUrl = coverUrl || null;

  if (coverUrl) {
    const isWarm = Boolean(decodedImg && decodedImg.complete && decodedImg.naturalWidth > 0);
    coverImg.decoding = isWarm ? 'sync' : 'async';
    if (coverImg.src !== coverUrl) coverImg.src = coverUrl;
    coverImg.style.display = 'block';
    defaultCover.style.display = 'none';
    if (barThumb) {
      barThumb.decoding = isWarm ? 'sync' : 'async';
      if (barThumb.src !== coverUrl) barThumb.src = coverUrl;
    }
    updateThemeColor(coverUrl, decodedImg);
    setMediaMetadata(song, coverUrl); // 系统浮层的封面
    window.dispatchEvent(new CustomEvent('dreamisle:cover-ready', { detail: coverUrl }));
  } else {
    coverImg.style.display = 'none';
    coverImg.removeAttribute('src');
    defaultCover.style.display = 'flex';
    if (barThumb) barThumb.removeAttribute('src');
    updateThemeColor(null);
    setMediaMetadata(song, null);
    window.dispatchEvent(new CustomEvent('dreamisle:cover-ready', { detail: null }));
  }
}

function getPrefetchNeighbors() {
  const len = state.songs.length;
  const cur = state.currentIndex;
  if (len <= 1 || cur < 0 || cur >= len) return [];

  if (state.playMode === 2) {
    return shuffleSession
      .peekNeighbors(state.songs, cur, { nextCount: 2, prevCount: 1 })
      .map((i) => state.songs[i])
      .filter(Boolean);
  }

  const indices = [];
  const seen = new Set([cur]);
  for (const offset of [1, 2, -1]) {
    const idx = (cur + offset + len) % len;
    if (!seen.has(idx)) {
      seen.add(idx);
      indices.push(idx);
    }
  }
  return indices.map((i) => state.songs[i]).filter(Boolean);
}

// 后台低优先级串行预取相邻曲目（顺序/随机均精准预测下一首、下下首与上一首），切歌瞬间 0ms 命中
function scheduleCoverPrefetch(token) {
  clearTimeout(coverPrefetchTimer);
  coverPrefetchTimer = setTimeout(async () => {
    coverPrefetchTimer = null;
    if (token !== coverRequestToken) return;
    const neighbors = getPrefetchNeighbors();
    for (const neighbor of neighbors) {
      if (token !== coverRequestToken) return;
      let url = getCachedCoverUrl(neighbor.path);
      if (url === undefined) {
        try {
          url = await window.dreamApi.getCover(neighbor.path);
        } catch (e) {
          continue;
        }
        if (typeof url === 'string' && url.startsWith('blob:')) {
          revokeIfBlobUrl(url);
          continue;
        }
        setCachedCoverUrl(neighbor.path, url);
      }
      if (token !== coverRequestToken) return;
      if (url && !getWarmDecodedCover(url)) {
        await warmDecodeCover(url);
      }
    }
  }, PREFETCH_DELAY_MS);
}

export async function updateCoverAndColor(song, preloadedUrl = undefined) {
  const token = ++coverRequestToken;
  clearTimeout(coverCoalesceTimer);
  coverCoalesceTimer = null;
  clearTimeout(coverPrefetchTimer);
  coverPrefetchTimer = null;

  const now = performance.now();
  const isRapidBurst = now - lastCoverSwitchAt < RAPID_SWITCH_WINDOW_MS;
  lastCoverSwitchAt = now;

  // 启动预热命中：主进程在 bootstrap 中已随带封面 URL，跳过二次 IPC 往返直接解码上屏
  if (preloadedUrl !== undefined) {
    setCachedCoverUrl(song.path, preloadedUrl);
    if (!preloadedUrl) {
      applyResolvedCover(song, null, null);
      scheduleCoverPrefetch(token);
      return;
    }
    const decodedImg = await warmDecodeCover(preloadedUrl);
    if (token !== coverRequestToken) {
      revokeIfBlobUrl(preloadedUrl);
      return;
    }
    applyResolvedCover(song, preloadedUrl, decodedImg);
    scheduleCoverPrefetch(token);
    return;
  }

  // 1. 缓存命中：已预取或已访问过的曲目直接同帧切换，零空白闪烁、零 IPC 往返
  const cached = getCachedCoverUrl(song.path);
  if (cached !== undefined) {
    if (!cached) {
      applyResolvedCover(song, null, null);
      scheduleCoverPrefetch(token);
      return;
    }
    const warmImg = getWarmDecodedCover(cached);
    if (warmImg) {
      applyResolvedCover(song, cached, warmImg);
      scheduleCoverPrefetch(token);
      return;
    }
    const decodedImg = await warmDecodeCover(cached);
    if (token !== coverRequestToken) return;
    applyResolvedCover(song, cached, decodedImg);
    scheduleCoverPrefetch(token);
    return;
  }

  // 2. 冷缓存 + 高频连切：短暂合并 55ms，防止连按 10 次下一首在主进程并发积压 10 个大文件 parseFile；
  // 常规单次切歌（间隔 >= 130ms）零延迟立即发起。等待期间不提前清空当前封面，避免空白闪烁。
  const runFetch = async () => {
    if (token !== coverRequestToken) return;
    let coverUrl = null;
    try {
      coverUrl = await window.dreamApi.getCover(song.path);
    } catch (e) {
      coverUrl = null;
    }
    setCachedCoverUrl(song.path, coverUrl);

    if (token !== coverRequestToken) {
      revokeIfBlobUrl(coverUrl);
      return;
    }

    if (coverUrl) {
      const decodedImg = await warmDecodeCover(coverUrl);
      if (token !== coverRequestToken) {
        revokeIfBlobUrl(coverUrl);
        return;
      }
      applyResolvedCover(song, coverUrl, decodedImg);
    } else {
      applyResolvedCover(song, null, null);
    }
    scheduleCoverPrefetch(token);
  };

  if (isRapidBurst) {
    coverCoalesceTimer = setTimeout(() => {
      coverCoalesceTimer = null;
      runFetch();
    }, BURST_COALESCE_MS);
  } else {
    runFetch();
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
  if (state.playMode === 2) {
    const prev = shuffleSession.prev(state.songs, state.currentIndex);
    if (prev >= 0) playSong(prev, { fromShuffle: true });
    return;
  }
  let prev = state.currentIndex - 1;
  if (prev < 0) prev = state.songs.length - 1;
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
  if (cancelActiveScrub) cancelActiveScrub(false);
  coverRequestToken++;
  clearTimeout(coverCoalesceTimer);
  coverCoalesceTimer = null;
  clearTimeout(coverPrefetchTimer);
  coverPrefetchTimer = null;
  shuffleSession.reset();
  audio.pause();
  updatePlayButton(false);
  titleEl.innerText = 'Dreamisle';
  artistEl.innerText = t('app.waitingForMusic');
  albumEl.innerText = '';
  if (state.currentCoverBlobUrl) {
    revokeIfBlobUrl(state.currentCoverBlobUrl);
    state.currentCoverBlobUrl = null;
  }
  coverImg.style.display = 'none';
  coverImg.removeAttribute('src');
  defaultCover.style.display = 'flex';
  if (barThumb) barThumb.removeAttribute('src');
  updateThemeColor(null);
  window.dispatchEvent(new CustomEvent('dreamisle:cover-ready', { detail: null }));
  window.dispatchEvent(new Event('dreamisle:song-changed'));
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

// 拖动进度条状态：在切歌/播完/空库复位/按 Esc 时通过 cancelActiveScrub 安全取消并复位
let cancelActiveScrub = null;

// 进度条悬停预览 + 拖动预览 + 松手提交（覆盖主窗口 #vizWrap 与小窗 #miniProgress）
function bindProgressScrub() {
  let dragTarget = null; // vizWrap | miniProgress
  let dragPointerId = null;
  let dragRatio = 0;

  const hasValidDuration = () => Number.isFinite(audio.duration) && audio.duration > 0;

  const ratioFromEvent = (el, e) => {
    const r = el.getBoundingClientRect();
    if (!r.width) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  const updateTooltipAt = (ratio) => {
    if (!vizWrap || !vizTooltip || !hasValidDuration()) return;
    const previewTime = ratio * audio.duration;
    if (vizTooltipTime) vizTooltipTime.textContent = formatTime(previewTime);
    if (vizTooltipLyric) {
      const lyricText = getLyricPreviewAt(previewTime);
      if (lyricText) {
        vizTooltipLyric.textContent = lyricText;
        vizTooltipLyric.hidden = false;
      } else {
        vizTooltipLyric.textContent = '';
        vizTooltipLyric.hidden = true;
      }
    }

    const r = vizWrap.getBoundingClientRect();
    const x = ratio * r.width;
    if (vizHoverLine) vizHoverLine.style.left = `${(ratio * 100).toFixed(3)}%`;

    // 气泡横坐标夹在 [halfW, width - halfW] 内，两端 0:00 / 末尾绝不越界裁切
    const halfW = (vizTooltip.offsetWidth || 44) / 2;
    const clampedX =
      r.width > halfW * 2 ? Math.max(halfW, Math.min(r.width - halfW, x)) : r.width / 2;
    vizTooltip.style.left = `${clampedX.toFixed(1)}px`;
  };

  const applyDragPreview = (ratio) => {
    dragRatio = ratio;
    state.scrubProgress = ratio;
    updateProgressStyle(ratio * 100);
    if (hasValidDuration()) {
      currentTimeEl.innerText = formatTime(ratio * audio.duration);
      if (dragTarget === vizWrap) updateTooltipAt(ratio);
    }
  };

  const restoreToActualPlayback = () => {
    if (hasValidDuration()) {
      const pct = Math.min(100, Math.max(0, (audio.currentTime / audio.duration) * 100));
      updateProgressStyle(pct);
      currentTimeEl.innerText = formatTime(audio.currentTime);
    } else {
      updateProgressStyle(0);
      currentTimeEl.innerText = formatTime(0);
    }
  };

  const endDrag = ({ commit = false, keepHover = false } = {}) => {
    if (!state.isDragging) return;
    const target = dragTarget;
    const pointerId = dragPointerId;
    const finalRatio = dragRatio;

    state.isDragging = false;
    state.scrubProgress = null;
    dragTarget = null;
    dragPointerId = null;

    if (target && pointerId !== null) {
      try {
        if (target.hasPointerCapture && target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
      } catch (e) {}
    }

    if (vizWrap) {
      vizWrap.classList.remove('dragging');
      if (!keepHover) vizWrap.classList.remove('hovering');
    }

    if (commit && hasValidDuration()) {
      const targetTime = Math.min(audio.duration, Math.max(0, finalRatio * audio.duration));
      audio.currentTime = targetTime;
      updateProgressStyle((targetTime / audio.duration) * 100);
      currentTimeEl.innerText = formatTime(targetTime);
      syncLyrics(targetTime);
      setPositionState();
      pushTaskbarPlayback(true);
    } else {
      restoreToActualPlayback();
    }
  };

  cancelActiveScrub = (restore = true) => {
    if (!state.isDragging) {
      if (vizWrap) vizWrap.classList.remove('hovering');
      return;
    }
    if (restore) {
      endDrag({ commit: false, keepHover: false });
    } else {
      const target = dragTarget;
      const pointerId = dragPointerId;
      state.isDragging = false;
      state.scrubProgress = null;
      dragTarget = null;
      dragPointerId = null;
      if (target && pointerId !== null) {
        try {
          if (target.hasPointerCapture && target.hasPointerCapture(pointerId)) {
            target.releasePointerCapture(pointerId);
          }
        } catch (e) {}
      }
      if (vizWrap) vizWrap.classList.remove('dragging', 'hovering');
    }
  };

  const attachScrubTarget = (el, { withHover = false } = {}) => {
    if (!el) return;

    if (withHover) {
      el.addEventListener('pointerenter', (e) => {
        if (state.isDragging || !hasValidDuration()) return;
        el.classList.add('hovering');
        updateTooltipAt(ratioFromEvent(el, e));
      });
      el.addEventListener('pointerleave', () => {
        if (!state.isDragging) el.classList.remove('hovering');
      });
      el.addEventListener('pointermove', (e) => {
        if (state.isDragging || !hasValidDuration()) return;
        if (!el.classList.contains('hovering')) el.classList.add('hovering');
        updateTooltipAt(ratioFromEvent(el, e));
      });
    }

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !hasValidDuration()) return;
      e.preventDefault();
      dragTarget = el;
      dragPointerId = e.pointerId;
      state.isDragging = true;
      if (withHover) {
        el.classList.add('dragging');
        el.classList.remove('hovering');
      }
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {}
      applyDragPreview(ratioFromEvent(el, e));
    });
  };

  attachScrubTarget(vizWrap, { withHover: true });
  attachScrubTarget(miniProgress, { withHover: false });

  // 在 window 上承接拖拽中的 move/up/cancel：即使光标移出轨道、移出窗口或不支持 pointer capture 也能顺滑跟手
  window.addEventListener('pointermove', (e) => {
    if (!state.isDragging || !dragTarget || e.pointerId !== dragPointerId) return;
    if (!hasValidDuration()) return;
    applyDragPreview(ratioFromEvent(dragTarget, e));
  });

  window.addEventListener('pointerup', (e) => {
    if (!state.isDragging || !dragTarget || e.pointerId !== dragPointerId) return;
    const el = dragTarget;
    const withHover = el === vizWrap;
    const r = el.getBoundingClientRect();
    const inside =
      withHover &&
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom;
    dragRatio = ratioFromEvent(el, e);
    endDrag({ commit: true, keepHover: inside });
    if (inside) {
      el.classList.add('hovering');
      updateTooltipAt(dragRatio);
    }
  });

  window.addEventListener('pointercancel', (e) => {
    if (state.isDragging && e.pointerId === dragPointerId) {
      endDrag({ commit: false, keepHover: false });
    }
  });

  // 拖动期间按 Esc 直接取消本次拖拽并还原进度，不误关抽屉或浮层
  window.addEventListener(
    'keydown',
    (e) => {
      if (state.isDragging && e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        endDrag({ commit: false, keepHover: false });
      }
    },
    true
  );

  // 窗口失焦时若正处于拖拽态，自动安全取消避免卡死在 isDragging = true
  window.addEventListener('blur', () => {
    if (state.isDragging) endDrag({ commit: false, keepHover: false });
  });
}

export function bindPlaybackEvents() {
  btnMode.addEventListener('click', () => {
    state.playMode = (state.playMode + 1) % 3;
    iconLoop.style.display = state.playMode === 0 ? 'block' : 'none';
    iconOne.style.display = state.playMode === 1 ? 'block' : 'none';
    iconShuffle.style.display = state.playMode === 2 ? 'block' : 'none';
    // 切入随机模式时以当前曲目为起点构建全新洗牌袋；切出时清空，并刷新相邻曲目封面预取
    shuffleSession.reset();
    if (state.playMode === 2 && state.songs.length > 0 && state.currentIndex >= 0) {
      shuffleSession.syncCurrent(state.songs, state.currentIndex);
    }
    if (state.songs.length > 1 && state.currentIndex >= 0) {
      scheduleCoverPrefetch(coverRequestToken);
    }
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
    pushTaskbarPlayback();
  });

  bindProgressScrub();

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

  // 任务栏歌词：play/pause/seeking/seeked/ended 都是「立即补一拍」的时机，
  // 不能等下一次 timeupdate，否则暂停或跳转后歌词条会慢半拍。
  for (const event of ['play', 'pause', 'seeking', 'seeked', 'ended']) {
    audio.addEventListener(event, () => pushTaskbarPlayback(true));
  }

  audio.addEventListener('ended', () => {
    if (cancelActiveScrub) cancelActiveScrub(false);
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
