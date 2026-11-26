// 专辑 Cover Flow 氛围浮层：固定 15 槽位 DOM 卡片池、零回流弹簧渲染、磁盘+内存缩略图预热缓存与按专辑原曲序播放。
import { t } from '../../shared/i18n.js';
import { albumKeyOf, groupSongsByAlbum } from '../../shared/albums.js';
import { state } from './state.js';
import {
  audio,
  playlistDrawer,
  playlistsDrawer,
  statsOverlay,
  helpOverlayEl,
  settingsOverlay,
  albumsOverlay,
  albumsCountEl,
  albumsCounterEl,
  albumsSearchInput,
  btnAlbumsSearchClear,
  btnAlbumsClose,
  albumsViewport,
  albumsTrack,
  albumsEmptyEl,
  albumsEmptyTextEl,
  albumsDock,
  albumsMetaEl,
  albumsTitleEl,
  albumsPlayingBadgeEl,
  albumsSubEl,
  btnAlbumPlay,
  iconAlbumPlay,
  iconAlbumPause,
  btnAlbumPlayLabel,
  btnAlbumFlip,
  btnAlbumFlipLabel,
  albumsScrubberRow,
  albumsScrubber,
  btnAlbumPrev,
  btnAlbumNext,
} from './dom.js';
import { escapeHtml, formatTime } from './helpers.js';
import { setQueue } from './playlist.js';
import { playSong, updatePlayButton, saveStateOnChange } from './playback.js';

// 固定 15 槽位卡片池覆盖 ±6 预挂载视窗与翻面保活，全程 0 DOM 建删
const MOUNT_RADIUS = 6;
const POOL_SIZE = 15;
const COVER_THUMB_SIZE = 320;
// 严格控内存：使用稳定 dream-thumb:// URL（0 Blob 分配、0 二进制常驻），热解码池仅留 20 张（~8MB），关闭浮层清空
const MAX_COVER_CACHE = 300;
const MAX_WARM_DECODED = 20;
const MAX_COVER_CONCURRENCY = 3;
const FAST_COVER_CONCURRENCY = 2;
const IDLE_PREWARM_CONCURRENCY = 1;
const IDLE_PREWARM_RADIUS = 16;
const LOOKAHEAD_COUNT = 6;
const FAST_VELOCITY_THRESHOLD = 9;
const TANH_1 = Math.tanh(1.85);
const TANH_Z = Math.tanh(2.1);

// 仅在确认无内嵌封面时使用的柔和 Dreamisle 氛围配色
const FALLBACK_PALETTES = [
  ['#4e3b8c', '#9a5ca8', '#b87cd4'],
  ['#8c3853', '#c86c72', '#e07a8a'],
  ['#285966', '#568d99', '#6eb3c2'],
  ['#8f552b', '#c98e54', '#e0a569'],
  ['#2f5c49', '#618f76', '#7ab896'],
  ['#374a7a', '#6380b8', '#7ca1e0'],
  ['#6a3d68', '#a86996', '#c787b4'],
  ['#51566b', '#878da3', '#a6adc4'],
];

const ICON_DISC_FALLBACK = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="2.6"></circle><path d="M12 3a9 9 0 0 1 6.36 2.64"></path></svg>`;

let allAlbums = [];
let filteredAlbums = [];
let albumIndexByKey = new Map();
let searchQuery = '';

let pos = 0;
let target = 0;
let vel = 0;
let activeIdx = 0;
let flippedIdx = -1;
let lastWindowCenter = -9999;
let swipeDirection = 1; // +1 向右预读，-1 向左预读

// 缓存的布局几何量：仅在打开浮层与 resize 时更新，热循环零 DOM 布局读取
let cachedStageW = 1000;
let cachedCardSize = 217;
let lastScrubberVal = -1;

// 指针拖拽状态
let pointerDown = false;
let activePointerId = null;
let dragging = false;
let dragMoved = false;
let dragStartX = 0;
let dragStartPos = 0;
let lastDragX = 0;
let lastDragTime = 0;
let dragVelocity = 0;
let scrubbing = false;
let lastScrubAt = 0;

// 动画与防抖计时器
let rafId = 0;
let lastFrameAt = 0;
let metaTimer = null;
let idlePrewarmTimer = null;
let clickFlipTimer = null;
let lastCenterClickAt = 0;
let lastCenterClickIdx = -1;
let resizeTimer = null;

// 固定 DOM 卡片池
let poolInitialized = false;
const freePool = [];
const mountedCards = new Map(); // albumIdx -> CardSlot

// 渲染进程封面 LRU 缓存：albumKey -> { status: 'loading' | 'ready', url }
const coverCache = new Map();
// 保持最近 72 张热解码 Image 对象引用，让 Blink MemoryCache 留住位图，复用槽位换图当帧 0ms 直出
const warmDecodedImages = new Map();
const pendingCoverQueue = [];
const pendingCoverKeys = new Set();
let activeCoverLoads = 0;
let idlePrewarmCursor = 0;
let openGeneration = 0;

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function fallbackPaletteFor(key) {
  return FALLBACK_PALETTES[hashString(key || 'dreamisle') % FALLBACK_PALETTES.length];
}

function albumDisplayName(album) {
  return album.isUnknown ? t('albums.unknownAlbum') : album.name;
}

function albumDisplayArtist(album) {
  if (album.isVariousArtists) return t('albums.variousArtists');
  return album.artist || 'Unknown';
}

function currentPlayingSong() {
  return state.songs[state.currentIndex] || null;
}

function isAlbumQueueActive(album) {
  return !!album && state.activeQueue.type === 'album' && state.activeQueue.key === album.key;
}

function isCurrentSongInAlbum(album) {
  const song = currentPlayingSong();
  return !!album && !!song && albumKeyOf(song) === album.key;
}

export function isAlbumsOpen() {
  return !!albumsOverlay && albumsOverlay.classList.contains('open');
}

function measureStageMetrics() {
  cachedStageW = albumsViewport.clientWidth || window.innerWidth || 1000;
  const vh = window.innerHeight || 700;
  cachedCardSize = Math.max(184, Math.min(252, vh * 0.31));
}

function stopLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function ensureLoop() {
  if (!isAlbumsOpen()) return;
  if (!rafId) {
    lastFrameAt = performance.now();
    rafId = requestAnimationFrame(tick);
  }
}

function clampIndex(idx) {
  if (filteredAlbums.length === 0) return 0;
  return Math.max(0, Math.min(filteredAlbums.length - 1, idx));
}

function isMovingFast() {
  const activelyScrubbing = scrubbing && performance.now() - lastScrubAt < 85;
  return (
    activelyScrubbing ||
    Math.abs(vel) > FAST_VELOCITY_THRESHOLD ||
    (dragging && Math.abs(dragVelocity) > FAST_VELOCITY_THRESHOLD)
  );
}

// 后台热解码 320px 缩略图并保留最近 28 张引用（约 11MB 上限），淘汰时显式清空 src 立即释放位图
function warmDecodeCover(albumKey, url) {
  if (!url) return Promise.resolve();
  const existing = warmDecodedImages.get(albumKey);
  if (existing && existing.src === url) {
    warmDecodedImages.delete(albumKey);
    warmDecodedImages.set(albumKey, existing);
    return Promise.resolve();
  }

  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  warmDecodedImages.delete(albumKey);
  warmDecodedImages.set(albumKey, img);

  if (warmDecodedImages.size > MAX_WARM_DECODED) {
    const oldestKey = warmDecodedImages.keys().next().value;
    if (oldestKey !== albumKey) {
      const oldImg = warmDecodedImages.get(oldestKey);
      if (oldImg) oldImg.src = '';
      warmDecodedImages.delete(oldestKey);
    }
  }

  return img.decode().catch(() => {});
}

function clearWarmDecodedImages() {
  for (const img of warmDecodedImages.values()) {
    img.src = '';
  }
  warmDecodedImages.clear();
}

function revokeIfBlob(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
}

function clearAllCoverCache() {
  pendingCoverQueue.length = 0;
  pendingCoverKeys.clear();
  clearWarmDecodedImages();
  // 只清理未完成的 loading 项与兜底 blob: URL；稳定 dream-thumb:// 字符串极轻且跨次复用 Chromium 纹理缓存
  for (const [key, entry] of coverCache) {
    if (!entry || entry.status !== 'ready') {
      coverCache.delete(key);
    } else if (entry.url && entry.url.startsWith('blob:')) {
      URL.revokeObjectURL(entry.url);
      coverCache.delete(key);
    }
  }
}

function touchCoverCache(key, entry) {
  const prev = coverCache.get(key);
  if (prev && prev.url && prev.url !== entry.url) {
    revokeIfBlob(prev.url);
  }
  coverCache.delete(key);
  coverCache.set(key, entry);

  if (coverCache.size <= MAX_COVER_CACHE) return;
  const mountedKeys = new Set();
  for (const slot of mountedCards.values()) {
    if (slot.albumKey) mountedKeys.add(slot.albumKey);
  }

  for (const [oldKey, oldEntry] of coverCache) {
    if (coverCache.size <= MAX_COVER_CACHE) break;
    if (oldKey === key || mountedKeys.has(oldKey) || oldEntry.status === 'loading') continue;
    const oldWarm = warmDecodedImages.get(oldKey);
    if (oldWarm) {
      oldWarm.src = '';
      warmDecodedImages.delete(oldKey);
    }
    revokeIfBlob(oldEntry.url);
    coverCache.delete(oldKey);
  }
}

function setSlotCoverState(slot, mode) {
  slot.el.classList.toggle('is-cover-loading', mode === 'loading');
  slot.el.classList.toggle('is-cover-empty', mode === 'empty');
}

function applyCoverToSlot(slot, entry, instant = false) {
  if (!slot || !entry || entry.status !== 'ready') return;
  slot.el.classList.toggle('is-instant-cover', instant);

  if (entry.url) {
    setSlotCoverState(slot, 'ready');
    // 命中预解码热缓存时走 sync，复用槽位换图在当帧直接绘制真封面，杜绝闪白/闪色块
    const isWarm = instant && warmDecodedImages.has(slot.albumKey);
    slot.frontImg.decoding = isWarm ? 'sync' : 'async';
    slot.reflImg.decoding = isWarm ? 'sync' : 'async';
    if (slot.frontImg.src !== entry.url) {
      slot.frontImg.src = entry.url;
      slot.reflImg.src = entry.url;
    }
    slot.frontImg.classList.add('loaded');
    slot.reflImg.classList.add('loaded');
    slot.el.style.setProperty('--vinyl-label', 'var(--c1, var(--accent))');
  } else {
    setSlotCoverState(slot, 'empty');
    slot.frontImg.removeAttribute('src');
    slot.frontImg.classList.remove('loaded');
    slot.reflImg.removeAttribute('src');
    slot.reflImg.classList.remove('loaded');
  }
}

function enqueueCoverLoad(album) {
  if (!album) return;
  const existing = coverCache.get(album.key);
  if (existing) {
    if (existing.status === 'ready') {
      touchCoverCache(album.key, existing);
      if (existing.url) warmDecodeCover(album.key, existing.url);
    }
    return;
  }
  if (pendingCoverKeys.has(album.key)) return;
  pendingCoverKeys.add(album.key);
  pendingCoverQueue.push(album);
}

// 预加载当前可视范围 + 滑动方向前方 12 张 + 弹簧目标落点附近
function queueDirectionalCovers() {
  if (filteredAlbums.length === 0) return;
  const curCenter = clampIndex(Math.round(pos));
  const tgtCenter = clampIndex(Math.round(target));

  // 1. 当前可见窗口
  for (let d = 0; d <= MOUNT_RADIUS; d++) {
    if (curCenter + d < filteredAlbums.length) enqueueCoverLoad(filteredAlbums[curCenter + d]);
    if (d > 0 && curCenter - d >= 0) enqueueCoverLoad(filteredAlbums[curCenter - d]);
  }
  // 2. 弹簧目标落点附近（快速甩动或滑轨跳转时提前把终点封面备好）
  if (tgtCenter !== curCenter) {
    for (let d = 0; d <= MOUNT_RADIUS; d++) {
      if (tgtCenter + d < filteredAlbums.length) enqueueCoverLoad(filteredAlbums[tgtCenter + d]);
      if (d > 0 && tgtCenter - d >= 0) enqueueCoverLoad(filteredAlbums[tgtCenter - d]);
    }
  }
  // 3. 仅在非高速拖滑时才沿前进方向预读，避免滑轨扫过上百张专辑时无谓上传 GPU 纹理
  if (!isMovingFast()) {
    const dir = swipeDirection >= 0 ? 1 : -1;
    for (let step = MOUNT_RADIUS + 1; step <= MOUNT_RADIUS + LOOKAHEAD_COUNT; step++) {
      const idx = curCenter + dir * step;
      if (idx >= 0 && idx < filteredAlbums.length) enqueueCoverLoad(filteredAlbums[idx]);
    }
  }
}

function prunePendingCovers() {
  if (pendingCoverQueue.length === 0) return;
  const maxKeep = MOUNT_RADIUS + LOOKAHEAD_COUNT + 4;
  for (let i = pendingCoverQueue.length - 1; i >= 0; i--) {
    const album = pendingCoverQueue[i];
    const idx = albumIndexByKey.get(album.key);
    if (idx === undefined) {
      pendingCoverQueue.splice(i, 1);
      pendingCoverKeys.delete(album.key);
      continue;
    }
    const dist = Math.min(Math.abs(idx - pos), Math.abs(idx - target));
    if (dist > maxKeep) {
      pendingCoverQueue.splice(i, 1);
      pendingCoverKeys.delete(album.key);
    }
  }
}

function pumpCoverQueue() {
  if (!isAlbumsOpen()) return;
  prunePendingCovers();

  const concurrencyLimit = isMovingFast() ? FAST_COVER_CONCURRENCY : MAX_COVER_CONCURRENCY;
  while (activeCoverLoads < concurrencyLimit && pendingCoverQueue.length > 0) {
    let bestPos = 0;
    let bestScore = Infinity;
    for (let i = 0; i < pendingCoverQueue.length; i++) {
      const idx = albumIndexByKey.get(pendingCoverQueue[i].key);
      if (idx === undefined) continue;
      // 距离当前屏幕或弹簧终点越近优先级越高；同距离优先前进方向
      const dist = Math.min(Math.abs(idx - pos), Math.abs(idx - target));
      const dirBonus = (idx - pos) * swipeDirection >= 0 ? -0.35 : 0;
      const score = dist + dirBonus;
      if (score < bestScore) {
        bestScore = score;
        bestPos = i;
      }
    }

    const [album] = pendingCoverQueue.splice(bestPos, 1);
    pendingCoverKeys.delete(album.key);
    if (coverCache.has(album.key)) continue;

    const gen = openGeneration;
    activeCoverLoads++;
    coverCache.set(album.key, { status: 'loading', url: null });

    // 浮层已关闭或已切换打开代次：立刻释放刚拿到的 blob URL，杜绝跨代次泄漏
    loadAlbumCover(album)
      .then(async (url) => {
        if (gen !== openGeneration || !isAlbumsOpen()) {
          revokeIfBlob(url);
          return;
        }
        // 先在后台解完 320px 位图再挂到 DOM，避免刚切换 src 时露出半帧底色
        if (url) await warmDecodeCover(album.key, url);
        if (gen !== openGeneration || !isAlbumsOpen()) {
          revokeIfBlob(url);
          return;
        }
        const entry = { status: 'ready', url };
        touchCoverCache(album.key, entry);

        const idx = albumIndexByKey.get(album.key);
        const slot = idx !== undefined ? mountedCards.get(idx) : null;
        if (slot && slot.albumKey === album.key) {
          applyCoverToSlot(slot, entry, false);
        }
      })
      .finally(() => {
        activeCoverLoads--;
        if (gen === openGeneration && isAlbumsOpen()) {
          pumpCoverQueue();
          scheduleIdlePrewarm(80);
        }
      });
  }
}

// 闲时只对当前专辑周边 ±18 张做单路串行预热，避免一口气全库解析撑爆主进程原生位图内存
function scheduleIdlePrewarm(delay = 140) {
  clearTimeout(idlePrewarmTimer);
  if (!isAlbumsOpen() || filteredAlbums.length === 0) return;
  idlePrewarmTimer = setTimeout(() => {
    idlePrewarmTimer = null;
    runIdlePrewarmStep();
  }, delay);
}

function runIdlePrewarmStep() {
  if (!isAlbumsOpen() || isMovingFast() || activeCoverLoads >= IDLE_PREWARM_CONCURRENCY) return;
  if (pendingCoverQueue.length > 0) {
    pumpCoverQueue();
    return;
  }

  const total = filteredAlbums.length;
  const origin = clampIndex(activeIdx);
  const maxSteps = Math.min(total, IDLE_PREWARM_RADIUS * 2);

  while (idlePrewarmCursor < maxSteps && activeCoverLoads < IDLE_PREWARM_CONCURRENCY) {
    const ring = Math.floor(idlePrewarmCursor / 2) + 1;
    const candidateIdx = idlePrewarmCursor % 2 === 0 ? origin + ring : origin - ring;
    idlePrewarmCursor++;

    if (candidateIdx < 0 || candidateIdx >= total) continue;
    const album = filteredAlbums[candidateIdx];
    if (!album || coverCache.has(album.key) || pendingCoverKeys.has(album.key)) continue;

    const gen = openGeneration;
    activeCoverLoads++;
    coverCache.set(album.key, { status: 'loading', url: null });

    loadAlbumCover(album)
      .then(async (url) => {
        if (gen !== openGeneration || !isAlbumsOpen()) {
          revokeIfBlob(url);
          return;
        }
        if (url && Math.abs(candidateIdx - pos) <= MOUNT_RADIUS + LOOKAHEAD_COUNT) {
          await warmDecodeCover(album.key, url);
        }
        if (gen !== openGeneration || !isAlbumsOpen()) {
          revokeIfBlob(url);
          return;
        }
        const entry = { status: 'ready', url };
        touchCoverCache(album.key, entry);

        const idx = albumIndexByKey.get(album.key);
        const slot = idx !== undefined ? mountedCards.get(idx) : null;
        if (slot && slot.albumKey === album.key) {
          applyCoverToSlot(slot, entry, false);
        }
      })
      .finally(() => {
        activeCoverLoads--;
        if (gen !== openGeneration || !isAlbumsOpen()) return;
        if (pendingCoverQueue.length > 0) pumpCoverQueue();
        else scheduleIdlePrewarm(80);
      });
  }
}

async function loadAlbumCover(album) {
  const fetchCover = window.dreamApi.getCoverThumb
    ? (p) => window.dreamApi.getCoverThumb(p, COVER_THUMB_SIZE)
    : (p) => window.dreamApi.getCover(p);

  const candidates = album.songs.slice(0, 3);
  for (const song of candidates) {
    try {
      const url = await fetchCover(song.path);
      if (url) return url;
    } catch (e) {}
  }
  return null;
}

// 播放指定专辑（从 trackIndex 首开始，保持原碟曲序）
function playAlbumAt(album, trackIndex = 0) {
  if (!album || album.songs.length === 0) return;
  const idx = Math.max(0, Math.min(album.songs.length - 1, trackIndex));
  if (!isAlbumQueueActive(album)) {
    setQueue(album.songs, { type: 'album', key: album.key });
  }
  const targetSong = album.songs[idx];
  const queueIdx = state.songs.findIndex((s) => s.path === targetSong.path);
  playSong(queueIdx >= 0 ? queueIdx : 0);
  syncDockControls();
  syncAllCardStates();
}

function handlePrimaryAlbumAction() {
  const album = filteredAlbums[activeIdx];
  if (!album) return;
  if (isAlbumQueueActive(album)) {
    if (audio.paused) {
      if (state.currentIndex === -1 && state.songs.length > 0) playSong(0);
      else audio.play();
      updatePlayButton(true);
    } else {
      audio.pause();
      updatePlayButton(false);
    }
    saveStateOnChange();
    syncDockControls();
    syncAllCardStates();
    return;
  }
  playAlbumAt(album, 0);
}

// 背面曲目单仅在翻面瞬间按需渲染，未翻面卡片保持 0 个 <li>，大合辑滑动 0 卡顿
function ensureBackTracklist(slot, album) {
  if (!slot || !album) return;
  const playingPath = currentPlayingSong()?.path || null;
  if (slot.boundBackKey === album.key) {
    for (const li of slot.tracksList.children) {
      li.classList.toggle('active', !!playingPath && li.dataset.path === playingPath);
    }
    return;
  }

  slot.boundBackKey = album.key;
  const title = albumDisplayName(album);
  const metaTail = album.year
    ? `${album.year} · ${t('playlist.count', { n: album.songs.length })}`
    : t('playlist.count', { n: album.songs.length });
  slot.backTitle.textContent = title;
  slot.backMeta.textContent = metaTail;

  const fragment = document.createDocumentFragment();
  for (let ti = 0; ti < album.songs.length; ti++) {
    const song = album.songs[ti];
    const num = Number.isFinite(song.trackNo) && song.trackNo > 0 ? song.trackNo : ti + 1;
    const dur =
      Number.isFinite(song.duration) && song.duration > 0 ? formatTime(song.duration) : '';

    const li = document.createElement('li');
    li.className = `cf-back-track${playingPath && song.path === playingPath ? ' active' : ''}`;
    li.dataset.trackIdx = String(ti);
    li.dataset.path = song.path;
    li.innerHTML =
      `<span class="cf-track-num">${num}</span>` +
      `<span class="cf-track-name">${escapeHtml(song.title)}</span>` +
      (dur ? `<span class="cf-track-dur">${dur}</span>` : '');
    fragment.appendChild(li);
  }
  slot.tracksList.replaceChildren(fragment);
  slot.tracksList.scrollTop = 0;
}

function toggleFlip(idx) {
  if (idx < 0 || idx >= filteredAlbums.length) return;
  flippedIdx = flippedIdx === idx ? -1 : idx;
  if (flippedIdx === idx) {
    const slot = mountedCards.get(idx);
    const album = filteredAlbums[idx];
    if (slot && album) ensureBackTracklist(slot, album);
  }
  syncAllCardStates();
  syncDockControls();
}

// 一次性初始化 15 个固定 DOM 卡片槽位，之后滑动只改绑定数据与 transform，不再建删任何节点
function initCardPool() {
  if (poolInitialized) return;
  poolInitialized = true;

  const fragment = document.createDocumentFragment();
  for (let s = 0; s < POOL_SIZE; s++) {
    const el = document.createElement('div');
    el.className = 'albums-card is-pooled-hidden';
    el.innerHTML = `
      <div class="cf-vinyl" aria-hidden="true">
        <div class="cf-vinyl-disc"></div>
      </div>
      <div class="cf-flipper">
        <div class="cf-face cf-face-front">
          <div class="cf-cover-loading" aria-hidden="true">${ICON_DISC_FALLBACK}</div>
          <div class="cf-cover-fallback">
            ${ICON_DISC_FALLBACK}
            <span class="cf-cover-fallback-name"></span>
          </div>
          <img class="cf-cover-img" alt="" draggable="false" decoding="async" />
          <div class="cf-sheen"></div>
          <div class="cf-shade"></div>
        </div>
        <div class="cf-face cf-face-back">
          <div class="cf-back-head">
            <span class="cf-back-title"></span>
            <span class="cf-back-meta"></span>
          </div>
          <ul class="cf-back-tracks"></ul>
        </div>
      </div>
      <div class="cf-reflection" aria-hidden="true">
        <div class="cf-refl-fallback"></div>
        <img class="cf-refl-img" alt="" draggable="false" decoding="async" />
        <div class="cf-refl-shade"></div>
      </div>
    `;

    const slot = {
      el,
      flipper: el.querySelector('.cf-flipper'),
      frontImg: el.querySelector('.cf-cover-img'),
      reflImg: el.querySelector('.cf-refl-img'),
      fallbackName: el.querySelector('.cf-cover-fallback-name'),
      backTitle: el.querySelector('.cf-back-title'),
      backMeta: el.querySelector('.cf-back-meta'),
      tracksList: el.querySelector('.cf-back-tracks'),
      shade: el.querySelector('.cf-shade'),
      refShade: el.querySelector('.cf-refl-shade'),
      albumIdx: -1,
      albumKey: null,
      boundBackKey: null,
      lastZ: '',
      lastOpacity: '',
      lastPE: '',
      lastShade: '',
      lastRefShade: '',
    };

    slot.tracksList.addEventListener(
      'wheel',
      (e) => {
        if (
          flippedIdx === slot.albumIdx &&
          slot.tracksList.scrollHeight > slot.tracksList.clientHeight + 2
        ) {
          e.stopPropagation();
        }
      },
      { passive: true }
    );

    slot.tracksList.addEventListener('click', (e) => {
      const li = e.target.closest('.cf-back-track');
      if (!li) return;
      e.stopPropagation();
      if (dragMoved || slot.albumIdx !== activeIdx) return;
      const album = filteredAlbums[slot.albumIdx];
      if (!album) return;
      clearTimeout(clickFlipTimer);
      playAlbumAt(album, Number(li.dataset.trackIdx) || 0);
    });

    slot.flipper.addEventListener('click', () => {
      if (dragMoved) return;
      const idx = slot.albumIdx;
      if (idx < 0 || idx >= filteredAlbums.length) return;
      if (idx !== activeIdx || Math.abs(pos - idx) >= 0.16) {
        clearTimeout(clickFlipTimer);
        goTo(idx);
        return;
      }
      if (flippedIdx === idx) {
        clearTimeout(clickFlipTimer);
        toggleFlip(idx);
        return;
      }
      const now = performance.now();
      if (lastCenterClickIdx === idx && now - lastCenterClickAt < 260) {
        clearTimeout(clickFlipTimer);
        lastCenterClickAt = 0;
        lastCenterClickIdx = -1;
        playAlbumAt(filteredAlbums[idx], 0);
        return;
      }
      lastCenterClickIdx = idx;
      lastCenterClickAt = now;
      clearTimeout(clickFlipTimer);
      clickFlipTimer = setTimeout(() => {
        clickFlipTimer = null;
        if (activeIdx === idx && flippedIdx !== idx) toggleFlip(idx);
      }, 220);
    });

    freePool.push(slot);
    fragment.appendChild(el);
  }

  albumsTrack.appendChild(fragment);
}

function bindSlotToAlbum(slot, idx, album) {
  const [c1, c2, accent] = fallbackPaletteFor(album.key);
  const title = albumDisplayName(album);

  slot.albumIdx = idx;
  slot.albumKey = album.key;
  slot.boundBackKey = null;
  slot.lastZ = '';
  slot.lastOpacity = '';
  slot.lastPE = '';
  slot.lastShade = '';
  slot.lastRefShade = '';

  slot.el.dataset.index = String(idx);
  slot.el.classList.remove(
    'is-pooled-hidden',
    'is-center',
    'is-flipped',
    'vinyl-out',
    'vinyl-spinning',
    'is-instant-cover',
    'is-cover-loading',
    'is-cover-empty'
  );
  slot.el.style.setProperty('--vinyl-label', accent);
  slot.el.style.setProperty('--cf-fallback-bg', `linear-gradient(145deg, ${c1}, ${c2})`);
  slot.fallbackName.textContent = title;
  slot.frontImg.alt = title;
  if (slot.tracksList.childElementCount > 0) slot.tracksList.replaceChildren();

  const cached = coverCache.get(album.key);
  if (cached && cached.status === 'ready') {
    applyCoverToSlot(slot, cached, true);
  } else {
    // 加载中显示极淡中性磨砂底，不闪艳丽色块
    setSlotCoverState(slot, 'loading');
    slot.frontImg.removeAttribute('src');
    slot.frontImg.classList.remove('loaded');
    slot.reflImg.removeAttribute('src');
    slot.reflImg.classList.remove('loaded');
    enqueueCoverLoad(album);
  }

  syncCardState(idx, slot);
}

function releaseSlot(slot) {
  slot.albumIdx = -1;
  slot.albumKey = null;
  slot.boundBackKey = null;
  slot.frontImg.removeAttribute('src');
  slot.frontImg.classList.remove('loaded');
  slot.reflImg.removeAttribute('src');
  slot.reflImg.classList.remove('loaded');
  slot.el.removeAttribute('data-index');
  slot.el.classList.add('is-pooled-hidden');
  slot.el.classList.remove(
    'is-center',
    'is-flipped',
    'vinyl-out',
    'vinyl-spinning',
    'is-instant-cover',
    'is-cover-loading',
    'is-cover-empty'
  );
  if (slot.tracksList.childElementCount > 0) slot.tracksList.replaceChildren();
  freePool.push(slot);
}

function releaseAllSlots() {
  for (const slot of mountedCards.values()) releaseSlot(slot);
  mountedCards.clear();
  lastWindowCenter = -9999;
}

// 滑动窗口槽位复用：仅在整数中心索引变化时触发，零 DOM 创建销毁
function syncMountedWindow(force = false) {
  if (filteredAlbums.length === 0) {
    releaseAllSlots();
    return;
  }

  initCardPool();
  const center = clampIndex(Math.round(pos));
  if (!force && center === lastWindowCenter) return;
  if (lastWindowCenter >= 0 && center !== lastWindowCenter) {
    swipeDirection = center > lastWindowCenter ? 1 : -1;
  }
  lastWindowCenter = center;

  const minMount = Math.max(0, center - MOUNT_RADIUS);
  const maxMount = Math.min(filteredAlbums.length - 1, center + MOUNT_RADIUS);

  for (const [idx, slot] of mountedCards) {
    if (idx !== flippedIdx && (idx < minMount || idx > maxMount)) {
      mountedCards.delete(idx);
      releaseSlot(slot);
    }
  }

  for (let i = minMount; i <= maxMount; i++) {
    if (!mountedCards.has(i)) {
      const slot = freePool.pop();
      if (!slot) break;
      bindSlotToAlbum(slot, i, filteredAlbums[i]);
      mountedCards.set(i, slot);
    }
  }

  // 每次翻过一张专辑，立即按滑动方向预读前方 12 张 + 终点落点附近
  queueDirectionalCovers();
  pumpCoverQueue();
}

function syncCardState(idx, slot) {
  const album = filteredAlbums[idx];
  if (!album || !slot) return;
  const isCenter = idx === activeIdx;
  const isFlipped = idx === flippedIdx;
  const isPlayingThisAlbum = isCurrentSongInAlbum(album) && !audio.paused;

  slot.el.classList.toggle('is-center', isCenter);
  slot.el.classList.toggle('is-flipped', isFlipped);
  slot.el.classList.toggle('vinyl-out', isCenter && isPlayingThisAlbum);
  slot.el.classList.toggle('vinyl-spinning', isCenter && isPlayingThisAlbum);

  if (isFlipped) ensureBackTracklist(slot, album);
}

function syncAllCardStates() {
  for (const [idx, slot] of mountedCards) syncCardState(idx, slot);
}

function syncDockControls() {
  const album = filteredAlbums[activeIdx];
  if (!album) return;

  const isQueueThis = isAlbumQueueActive(album);
  const isPlayingNow = isQueueThis && !audio.paused;

  albumsPlayingBadgeEl.hidden = !isCurrentSongInAlbum(album) || audio.paused;

  if (isPlayingNow) {
    iconAlbumPlay.style.display = 'none';
    iconAlbumPause.style.display = 'block';
    btnAlbumPlayLabel.textContent = t('albums.pauseAlbum');
  } else if (isQueueThis && audio.paused) {
    iconAlbumPlay.style.display = 'block';
    iconAlbumPause.style.display = 'none';
    btnAlbumPlayLabel.textContent = t('albums.resumeAlbum');
  } else {
    iconAlbumPlay.style.display = 'block';
    iconAlbumPause.style.display = 'none';
    btnAlbumPlayLabel.textContent = t('albums.playAlbum');
  }

  btnAlbumFlipLabel.textContent =
    flippedIdx === activeIdx ? t('albums.frontCover') : t('albums.tracklist');

  if (btnAlbumPrev) btnAlbumPrev.disabled = activeIdx <= 0;
  if (btnAlbumNext) btnAlbumNext.disabled = activeIdx >= filteredAlbums.length - 1;
}

function syncActiveMeta(idx, immediate = false) {
  const album = filteredAlbums[idx];
  if (!album) return;

  const totalStr = String(filteredAlbums.length).padStart(2, '0');
  const curStr = String(idx + 1).padStart(2, '0');
  albumsCounterEl.textContent = `${curStr} / ${totalStr}`;

  syncDockControls();

  const title = albumDisplayName(album);
  const parts = [albumDisplayArtist(album)];
  if (album.year) parts.push(String(album.year));
  parts.push(t('playlist.count', { n: album.songs.length }));
  const sub = parts.join(' · ');

  clearTimeout(metaTimer);
  if (immediate || isMovingFast()) {
    albumsTitleEl.textContent = title;
    albumsSubEl.textContent = sub;
    albumsMetaEl.classList.remove('swapping');
    return;
  }

  albumsMetaEl.classList.add('swapping');
  metaTimer = setTimeout(() => {
    albumsTitleEl.textContent = title;
    albumsSubEl.textContent = sub;
    albumsMetaEl.classList.remove('swapping');
  }, 80);
}

function goTo(idx) {
  if (filteredAlbums.length === 0) return;
  const next = clampIndex(Math.round(idx));
  clearTimeout(clickFlipTimer);
  if (next !== target) swipeDirection = next > target ? 1 : -1;
  if (flippedIdx !== -1 && flippedIdx !== next) flippedIdx = -1;
  target = next;
  idlePrewarmCursor = 0;
  if (next !== activeIdx) {
    activeIdx = next;
    syncActiveMeta(activeIdx);
  }
  syncMountedWindow();
  queueDirectionalCovers();
  pumpCoverQueue();
  syncAllCardStates();
  syncDockControls();
  ensureLoop();
}

// 零回流逐帧 3D 几何布局：不读任何 DOM 尺寸，只按脏检查写 GPU 合成属性
function layoutCoverFlow() {
  if (filteredAlbums.length === 0) return;
  syncMountedWindow();

  const compact = cachedStageW < 760;
  const centerGap = cachedCardSize * (compact ? 0.74 : 0.88);
  const stackStep = cachedCardSize * (compact ? 0.23 : 0.28);
  const maxAngle = 62;

  for (const [i, card] of mountedCards) {
    const d = i - pos;
    const absD = Math.abs(d);
    const sign = d < 0 ? -1 : d > 0 ? 1 : 0;

    if (absD > 4.8) {
      if (card.lastOpacity !== '0') {
        card.el.style.opacity = '0';
        card.lastOpacity = '0';
      }
      if (card.lastPE !== 'none') {
        card.flipper.style.pointerEvents = 'none';
        card.lastPE = 'none';
      }
      continue;
    }

    const smooth1 = Math.tanh(absD * 1.85) / TANH_1;
    const x = sign * (stackStep * absD + (centerGap - stackStep) * Math.min(1.04, smooth1));
    const rotY = -sign * maxAngle * Math.min(1, smooth1);
    const zCurve = Math.min(1, Math.tanh(absD * 2.1) / TANH_Z);
    const z = 52 - 178 * zCurve - absD * 8;
    const opacity = absD > 3.5 ? Math.max(0, 1 - (absD - 3.5) / 1.2) : 1;
    const shadeAlpha = Math.min(0.42, zCurve * 0.34 + Math.max(0, absD - 1) * 0.04);

    card.el.style.transform = `translate3d(${x.toFixed(1)}px,0px,${z.toFixed(1)}px) rotateY(${rotY.toFixed(2)}deg)`;

    const zStr = String(100 - Math.round(absD * 10));
    if (zStr !== card.lastZ) {
      card.el.style.zIndex = zStr;
      card.lastZ = zStr;
    }

    const opStr = opacity >= 0.999 ? '1' : opacity.toFixed(3);
    if (opStr !== card.lastOpacity) {
      card.el.style.opacity = opStr;
      card.lastOpacity = opStr;
    }

    const peStr = opacity > 0.12 ? 'auto' : 'none';
    if (peStr !== card.lastPE) {
      card.flipper.style.pointerEvents = peStr;
      card.lastPE = peStr;
    }

    const shadeStr = shadeAlpha < 0.005 ? '0' : shadeAlpha.toFixed(2);
    if (shadeStr !== card.lastShade) {
      card.shade.style.opacity = shadeStr;
      card.lastShade = shadeStr;
    }

    const refShadeStr = shadeAlpha < 0.005 ? '0' : (shadeAlpha * 0.82).toFixed(2);
    if (refShadeStr !== card.lastRefShade) {
      card.refShade.style.opacity = refShadeStr;
      card.lastRefShade = refShadeStr;
    }
  }

  if (document.activeElement !== albumsScrubber && filteredAlbums.length > 1) {
    const nextVal = Math.round(pos * 100);
    if (nextVal !== lastScrubberVal) {
      albumsScrubber.value = String(nextVal);
      lastScrubberVal = nextVal;
    }
  }
}

function tick(now) {
  rafId = 0;
  if (!isAlbumsOpen()) return;
  const dt = Math.min(0.032, Math.max(0.004, (now - lastFrameAt) / 1000));
  lastFrameAt = now;

  if (!dragging) {
    const stiffness = 175;
    const damping = 23.5;
    const force = (target - pos) * stiffness;
    vel += (force - vel * damping) * dt;
    pos += vel * dt;

    const nearest = clampIndex(Math.round(pos));
    if (nearest !== activeIdx) {
      activeIdx = nearest;
      if (flippedIdx !== -1 && flippedIdx !== activeIdx) flippedIdx = -1;
      syncActiveMeta(activeIdx);
      syncAllCardStates();
    }

    if (Math.abs(target - pos) < 0.001 && Math.abs(vel) < 0.002) {
      pos = target;
      vel = 0;
      layoutCoverFlow();
      queueDirectionalCovers();
      pumpCoverQueue();
      scheduleIdlePrewarm(80);
      return;
    }
  }

  layoutCoverFlow();
  rafId = requestAnimationFrame(tick);
}

// 重建专辑列表并定位目标索引（默认聚焦正在播放的专辑，或保留当前选中专辑）
function rebuildAlbums({ preferKey = null, focusCurrent = false } = {}) {
  allAlbums = groupSongsByAlbum(state.librarySongs);
  albumsCountEl.textContent = t('albums.count', { n: allAlbums.length });

  const q = searchQuery.trim().toLowerCase();
  filteredAlbums = q
    ? allAlbums.filter((album) => {
        const name = albumDisplayName(album).toLowerCase();
        const artist = albumDisplayArtist(album).toLowerCase();
        return (
          name.includes(q) ||
          artist.includes(q) ||
          album.songs.some((s) => s.title.toLowerCase().includes(q))
        );
      })
    : allAlbums;

  albumIndexByKey = new Map();
  for (let i = 0; i < filteredAlbums.length; i++) {
    albumIndexByKey.set(filteredAlbums[i].key, i);
  }

  releaseAllSlots();
  flippedIdx = -1;
  vel = 0;
  idlePrewarmCursor = 0;

  if (filteredAlbums.length === 0) {
    albumsEmptyEl.hidden = false;
    albumsEmptyTextEl.textContent =
      allAlbums.length === 0 ? t('albums.empty') : t('albums.emptySearch');
    albumsDock.hidden = true;
    albumsCounterEl.textContent = '';
    return;
  }

  albumsEmptyEl.hidden = true;
  albumsDock.hidden = false;

  let nextIdx = 0;
  if (focusCurrent) {
    const playingKey =
      state.activeQueue.type === 'album'
        ? state.activeQueue.key
        : currentPlayingSong()
          ? albumKeyOf(currentPlayingSong())
          : null;
    if (playingKey && albumIndexByKey.has(playingKey)) {
      nextIdx = albumIndexByKey.get(playingKey);
    }
  } else if (preferKey && albumIndexByKey.has(preferKey)) {
    nextIdx = albumIndexByKey.get(preferKey);
  } else {
    nextIdx = clampIndex(activeIdx);
  }

  activeIdx = nextIdx;
  pos = nextIdx;
  target = nextIdx;

  albumsScrubberRow.hidden = filteredAlbums.length <= 1;
  albumsScrubber.min = '0';
  albumsScrubber.max = String(Math.max(0, (filteredAlbums.length - 1) * 100));
  lastScrubberVal = nextIdx * 100;
  albumsScrubber.value = String(lastScrubberVal);

  measureStageMetrics();
  syncMountedWindow(true);
  syncAllCardStates();
  syncActiveMeta(activeIdx, true);
  layoutCoverFlow();
  queueDirectionalCovers();
  pumpCoverQueue();
  scheduleIdlePrewarm(120);
}

export function openAlbums() {
  if (!albumsOverlay || state.isMiniMode) return;
  openGeneration++;
  playlistDrawer.classList.remove('open');
  playlistsDrawer.classList.remove('open');
  if (statsOverlay) statsOverlay.classList.remove('open', 'playing');
  if (helpOverlayEl) helpOverlayEl.classList.remove('open');
  if (settingsOverlay) settingsOverlay.classList.remove('open');
  window.dispatchEvent(new Event('dreamisle:albums-opened'));

  document.body.classList.add('albums-open');
  albumsOverlay.classList.add('open');
  albumsOverlay.setAttribute('aria-hidden', 'false');
  if (btnAlbums) btnAlbums.classList.add('active');

  rebuildAlbums({ focusCurrent: true });
  requestAnimationFrame(() => {
    if (isAlbumsOpen()) {
      measureStageMetrics();
      layoutCoverFlow();
    }
  });
}

export function closeAlbums() {
  if (!albumsOverlay || !isAlbumsOpen()) return;
  openGeneration++;
  stopLoop();
  clearTimeout(clickFlipTimer);
  clearTimeout(metaTimer);
  clearTimeout(idlePrewarmTimer);
  scrubbing = false;
  document.body.classList.remove('albums-open');
  albumsOverlay.classList.remove('open');
  albumsOverlay.setAttribute('aria-hidden', 'true');
  if (btnAlbums) btnAlbums.classList.remove('active');

  // 关闭时彻底回收槽位引用、热解码位图与全部 Blob URL（下次打开从主进程/磁盘缩略图缓存毫秒级重建）
  releaseAllSlots();
  clearAllCoverCache();
}

export function toggleAlbums() {
  if (isAlbumsOpen()) closeAlbums();
  else openAlbums();
}

export function handleAlbumsKeydown(e) {
  if (!isAlbumsOpen()) return false;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    goTo(target - 1);
    return true;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    goTo(target + 1);
    return true;
  }
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    toggleFlip(activeIdx);
    return true;
  }
  return false;
}

let albumsEventsBound = false;

export function bindAlbumsEvents() {
  if (!albumsOverlay || albumsEventsBound) return;
  albumsEventsBound = true;

  if (btnAlbumsClose) btnAlbumsClose.addEventListener('click', closeAlbums);
  if (btnAlbumPlay) btnAlbumPlay.addEventListener('click', handlePrimaryAlbumAction);
  if (btnAlbumFlip) btnAlbumFlip.addEventListener('click', () => toggleFlip(activeIdx));
  if (btnAlbumPrev) btnAlbumPrev.addEventListener('click', () => goTo(target - 1));
  if (btnAlbumNext) btnAlbumNext.addEventListener('click', () => goTo(target + 1));

  if (albumsSearchInput) {
    albumsSearchInput.addEventListener('input', () => {
      searchQuery = albumsSearchInput.value;
      if (btnAlbumsSearchClear) btnAlbumsSearchClear.hidden = searchQuery.length === 0;
      const currentKey = filteredAlbums[activeIdx]?.key || null;
      rebuildAlbums({ preferKey: currentKey });
    });
    albumsSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && albumsSearchInput.value) {
        e.stopPropagation();
        albumsSearchInput.value = '';
        searchQuery = '';
        if (btnAlbumsSearchClear) btnAlbumsSearchClear.hidden = true;
        rebuildAlbums({ focusCurrent: true });
      }
    });
  }

  if (btnAlbumsSearchClear) {
    btnAlbumsSearchClear.addEventListener('click', () => {
      albumsSearchInput.value = '';
      searchQuery = '';
      btnAlbumsSearchClear.hidden = true;
      rebuildAlbums({ focusCurrent: true });
      albumsSearchInput.focus();
    });
  }

  // Pointer 拖拽 + 惯性动量
  albumsViewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || filteredAlbums.length <= 1) return;
    pointerDown = true;
    activePointerId = e.pointerId;
    dragging = false;
    dragMoved = false;
    dragStartX = e.clientX;
    lastDragX = e.clientX;
    dragStartPos = pos;
    lastDragTime = performance.now();
    dragVelocity = 0;
  });

  albumsViewport.addEventListener('pointermove', (e) => {
    if (!pointerDown || e.pointerId !== activePointerId) return;
    const dx = e.clientX - dragStartX;
    if (!dragging) {
      if (Math.abs(dx) <= 5) return;
      dragging = true;
      dragMoved = true;
      vel = 0;
      clearTimeout(clickFlipTimer);
      albumsViewport.classList.add('dragging');
      try {
        albumsViewport.setPointerCapture(e.pointerId);
      } catch {}
      ensureLoop();
    }

    const now = performance.now();
    const dt = Math.max(8, now - lastDragTime);
    const dragScale = Math.max(135, cachedCardSize * 0.72);
    dragVelocity = (lastDragX - e.clientX) / dragScale / (dt / 1000);
    if (Math.abs(dragVelocity) > 0.2) swipeDirection = dragVelocity > 0 ? 1 : -1;
    lastDragX = e.clientX;
    lastDragTime = now;

    const raw = dragStartPos - dx / dragScale;
    const maxPos = filteredAlbums.length - 1;
    if (raw < 0) pos = raw * 0.32;
    else if (raw > maxPos) pos = maxPos + (raw - maxPos) * 0.32;
    else pos = raw;

    const nearest = clampIndex(Math.round(pos));
    if (nearest !== activeIdx) {
      activeIdx = nearest;
      if (flippedIdx !== -1) flippedIdx = -1;
      syncActiveMeta(activeIdx);
      syncAllCardStates();
    }
  });

  function endDrag(e) {
    if (!pointerDown) return;
    if (e && e.pointerId !== activePointerId) return;
    const wasDragging = dragging;
    const capturedId = activePointerId;
    pointerDown = false;
    activePointerId = null;
    dragging = false;

    if (!wasDragging) return;

    albumsViewport.classList.remove('dragging');
    try {
      if (capturedId != null && albumsViewport.hasPointerCapture(capturedId)) {
        albumsViewport.releasePointerCapture(capturedId);
      }
    } catch {}

    const projected = pos + dragVelocity * 0.14;
    vel = dragVelocity * 0.45;
    goTo(Math.round(projected));
    scheduleIdlePrewarm(100);
    setTimeout(() => {
      dragMoved = false;
    }, 0);
  }

  albumsViewport.addEventListener('pointerup', endDrag);
  albumsViewport.addEventListener('pointercancel', endDrag);

  // 滚轮切专辑
  let wheelAccum = 0;
  let wheelResetTimer = null;
  albumsViewport.addEventListener(
    'wheel',
    (e) => {
      if (filteredAlbums.length <= 1) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      wheelAccum += delta;
      if (Math.abs(wheelAccum) >= 48) {
        goTo(target + (wheelAccum > 0 ? 1 : -1));
        wheelAccum = 0;
      }
      clearTimeout(wheelResetTimer);
      wheelResetTimer = setTimeout(() => {
        wheelAccum = 0;
      }, 140);
    },
    { passive: false }
  );

  // 底部经典滑轨拖动：走 rAF 合并渲染，拖动中持续按方向预加载落点封面
  let scrubRaf = 0;
  albumsScrubber.addEventListener('input', () => {
    if (filteredAlbums.length <= 1) return;
    scrubbing = true;
    lastScrubAt = performance.now();
    const val = Number(albumsScrubber.value);
    const nextPos = val / 100;
    if (nextPos !== pos) swipeDirection = nextPos > pos ? 1 : -1;
    lastScrubberVal = val;
    target = nextPos;
    pos = nextPos;
    vel = 0;
    const nearest = clampIndex(Math.round(pos));
    if (nearest !== activeIdx) {
      activeIdx = nearest;
      if (flippedIdx !== -1) flippedIdx = -1;
      syncActiveMeta(activeIdx);
      syncAllCardStates();
    }
    if (!scrubRaf) {
      scrubRaf = requestAnimationFrame(() => {
        scrubRaf = 0;
        layoutCoverFlow();
      });
    }
  });

  albumsScrubber.addEventListener('change', () => {
    if (filteredAlbums.length <= 1) return;
    scrubbing = false;
    goTo(Math.round(Number(albumsScrubber.value) / 100));
    albumsScrubber.blur();
    scheduleIdlePrewarm(90);
  });

  const syncPlaybackVisuals = () => {
    if (!isAlbumsOpen()) return;
    syncAllCardStates();
    syncDockControls();
  };

  audio.addEventListener('play', syncPlaybackVisuals);
  audio.addEventListener('pause', syncPlaybackVisuals);
  window.addEventListener('dreamisle:song-changed', syncPlaybackVisuals);
  window.addEventListener('dreamisle:queue-changed', syncPlaybackVisuals);

  window.addEventListener('dreamisle:library-changed', () => {
    if (isAlbumsOpen()) {
      const currentKey = filteredAlbums[activeIdx]?.key || null;
      rebuildAlbums({ preferKey: currentKey });
    }
  });

  window.addEventListener('dreamisle:language-changed', () => {
    if (isAlbumsOpen()) {
      const currentKey = filteredAlbums[activeIdx]?.key || null;
      rebuildAlbums({ preferKey: currentKey });
    }
  });

  window.addEventListener('resize', () => {
    if (!isAlbumsOpen()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      measureStageMetrics();
      layoutCoverFlow();
    }, 60);
  });
}
