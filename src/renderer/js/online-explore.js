// 在线音源探索与搜索浮层（按需懒加载，仅在启用至少一个 music-source 插件后展示入口）。
import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import {
  playlistDrawer,
  playlistsDrawer,
  statsOverlay,
  helpOverlayEl,
  settingsOverlay,
} from './dom.js';
import { escapeHtml, formatTime } from './helpers.js';
import { setQueue } from './playlist.js';
import { playSong } from './playback.js';
import { openContextMenu } from './playlists.js';
import { closeAlbums, toggleSettings } from './lazy-overlays.js';

const FALLBACK_GRADIENTS = [
  'linear-gradient(145deg, #4e3b8c, #241a3e)',
  'linear-gradient(145deg, #8c3853, #3a1929)',
  'linear-gradient(145deg, #285966, #142a32)',
  'linear-gradient(145deg, #8f552b, #382214)',
  'linear-gradient(145deg, #2f5c49, #162b23)',
  'linear-gradient(145deg, #374a7a, #19223a)',
];

const ICON_NOTE = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;

let bound = false;
let activePluginId = null;
// 空搜索词：'explore' | 'myPlaylists'；有搜索词：'tracks' | 'albums' | 'playlists'
let activeTab = 'explore';
let searchQuery = '';
let searchTimer = null;
let loadSeq = 0;

// 列表与分页状态
let currentPage = 1;
let currentHasMore = false;
let currentItems = [];
// 专辑 / 歌单钻取详情态：{ kind: 'album' | 'playlist', id, title, subtitle, tracks, page, hasMore }
let detailView = null;

function getEl(id) {
  return document.getElementById(id);
}

function getEnabledSourcePlugins() {
  return (state.plugins || []).filter(
    (p) =>
      p.enabled &&
      !p.invalid &&
      p.status !== 'crashed' &&
      Array.isArray(p.manifest?.capabilities) &&
      p.manifest.capabilities.includes('music-source')
  );
}

function pickGradient(seed) {
  let hash = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return FALLBACK_GRADIENTS[Math.abs(hash) % FALLBACK_GRADIENTS.length];
}

function formatErr(err) {
  if (!err) return t('plugins.err.INTERNAL_ERROR');
  if (err.code) {
    const key = `plugins.err.${err.code}`;
    const msg = t(key);
    if (msg !== key) return msg;
  }
  return err.message || t('plugins.err.INTERNAL_ERROR');
}

export function isOnlineExploreOpen() {
  const overlay = getEl('onlineOverlay');
  return Boolean(overlay && overlay.classList.contains('open'));
}

export function closeOnlineExplore() {
  const overlay = getEl('onlineOverlay');
  if (!overlay || !overlay.classList.contains('open')) return;
  loadSeq++;
  resetCoverLoader();
  clearTimeout(searchTimer);
  searchTimer = null;
  document.body.classList.remove('online-open');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

export function openOnlineExplore() {
  const overlay = getEl('onlineOverlay');
  if (!overlay || state.isMiniMode) return;
  if (playlistDrawer) playlistDrawer.classList.remove('open');
  if (playlistsDrawer) playlistsDrawer.classList.remove('open');
  if (statsOverlay) statsOverlay.classList.remove('open', 'playing');
  if (helpOverlayEl) helpOverlayEl.classList.remove('open');
  if (settingsOverlay) settingsOverlay.classList.remove('open');
  closeAlbums();
  window.dispatchEvent(new Event('dreamisle:online-opened'));

  document.body.classList.add('online-open');
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');

  syncSourcesAndLoad();
}

export function toggleOnlineExplore() {
  if (isOnlineExploreOpen()) closeOnlineExplore();
  else openOnlineExplore();
}

function ensureActivePlugin() {
  const sources = getEnabledSourcePlugins();
  if (sources.length === 0) {
    activePluginId = null;
    return sources;
  }
  if (!sources.some((p) => p.id === activePluginId)) {
    activePluginId = sources[0].id;
    detailView = null;
  }
  return sources;
}

function renderSourcePills(sources) {
  const tabsEl = getEl('onlineSourceTabs');
  if (!tabsEl) return;
  const frag = document.createDocumentFragment();
  for (const src of sources) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `online-source-pill${src.id === activePluginId ? ' active' : ''}`;
    btn.dataset.pluginId = src.id;
    btn.textContent = src.manifest?.name || src.id;
    frag.appendChild(btn);
  }
  tabsEl.replaceChildren(frag);
}

function renderModeTabs() {
  const modeBar = getEl('onlineModeTabs');
  const detailBar = getEl('onlineDetailBar');
  if (!modeBar || !detailBar) return;

  if (detailView) {
    modeBar.hidden = true;
    detailBar.hidden = false;
    const titleEl = getEl('onlineDetailTitle');
    const subEl = getEl('onlineDetailSub');
    if (titleEl) titleEl.textContent = detailView.title || '';
    if (subEl) subEl.textContent = detailView.subtitle || '';
    return;
  }

  detailBar.hidden = true;
  modeBar.hidden = false;

  const hasQuery = searchQuery.trim().length > 0;
  const tabs = hasQuery
    ? [
        { id: 'tracks', label: t('online.tabTracks') },
        { id: 'albums', label: t('online.tabAlbums') },
        { id: 'playlists', label: t('online.tabPlaylists') },
      ]
    : [
        { id: 'explore', label: t('online.tabExplore') },
        { id: 'myPlaylists', label: t('online.tabMyPlaylists') },
      ];

  if (!tabs.some((tab) => tab.id === activeTab)) {
    activeTab = tabs[0].id;
  }

  const frag = document.createDocumentFragment();
  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `online-mode-tab${tab.id === activeTab ? ' active' : ''}`;
    btn.dataset.tab = tab.id;
    btn.textContent = tab.label;
    frag.appendChild(btn);
  }
  modeBar.replaceChildren(frag);
}

function renderStatusBox(message, { showSettingsBtn = false } = {}) {
  const contentEl = getEl('onlineContent');
  const loadMoreBtn = getEl('btnOnlineLoadMore');
  if (loadMoreBtn) loadMoreBtn.hidden = true;
  if (!contentEl) return;

  const box = document.createElement('div');
  box.className = 'online-empty';
  box.innerHTML = `<p>${escapeHtml(message)}</p>`;
  if (showSettingsBtn) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'albums-action-btn';
    btn.textContent = t('online.openSettings');
    btn.onclick = () => {
      closeOnlineExplore();
      toggleSettings();
    };
    box.appendChild(btn);
  }
  contentEl.replaceChildren(box);
}

// 可见区封面懒加载 + 有界并发池（避免大歌单瞬间并发 50+ 封面拉取触发上游限流或超时）
const MAX_ONLINE_COVER_CONCURRENCY = 6;
let activeCoverJobs = 0;
const pendingCoverJobs = [];
const observedCoverMeta = new WeakMap();
let coverObserver = null;

function resetCoverLoader() {
  pendingCoverJobs.length = 0;
  if (coverObserver) {
    coverObserver.disconnect();
    coverObserver = null;
  }
}

function pumpCoverJobs() {
  while (activeCoverJobs < MAX_ONLINE_COVER_CONCURRENCY && pendingCoverJobs.length > 0) {
    const job = pendingCoverJobs.shift();
    if (!job || job.seq !== loadSeq || !job.imgEl.isConnected) continue;
    activeCoverJobs++;
    Promise.resolve()
      .then(job.run)
      .then((url) => {
        if (job.seq !== loadSeq || !url || !job.imgEl.isConnected) return;
        job.imgEl.src = url;
        job.imgEl.classList.add('loaded');
      })
      .catch(() => {})
      .finally(() => {
        activeCoverJobs--;
        pumpCoverJobs();
      });
  }
}

function ensureCoverObserver() {
  if (coverObserver) return coverObserver;
  const scrollRoot = document.querySelector('#onlineOverlay .online-scroll');
  coverObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const imgEl = entry.target;
        coverObserver.unobserve(imgEl);
        const job = observedCoverMeta.get(imgEl);
        if (!job || job.seq !== loadSeq) continue;
        observedCoverMeta.delete(imgEl);
        pendingCoverJobs.push(job);
      }
      pumpCoverJobs();
    },
    { root: scrollRoot || null, rootMargin: '220px 0px' }
  );
  return coverObserver;
}

function scheduleCoverHydration(imgEl, seq, run) {
  if (!imgEl) return;
  const job = { imgEl, seq, run };
  observedCoverMeta.set(imgEl, job);
  ensureCoverObserver().observe(imgEl);
}

function hydrateTrackCover(imgEl, songPath, seq) {
  if (!imgEl || !songPath) return;
  scheduleCoverHydration(imgEl, seq, () => window.dreamApi.getCoverThumb(songPath, 160));
}

function hydrateArtworkCover(imgEl, pluginId, artworkUrl, seq) {
  if (!imgEl || !pluginId || !artworkUrl || !window.dreamApi.plugins?.getArtworkThumb) return;
  scheduleCoverHydration(imgEl, seq, () =>
    window.dreamApi.plugins.getArtworkThumb(pluginId, artworkUrl, 320)
  );
}

function createTrackListEl(tracks, seq) {
  const list = document.createElement('ul');
  list.className = 'online-track-list';
  const currentPlayingPath = state.songs[state.currentIndex]?.path || null;

  tracks.forEach((song, idx) => {
    const li = document.createElement('li');
    li.className = `online-track-row${currentPlayingPath === song.path ? ' active' : ''}`;
    li.dataset.trackIndex = String(idx);
    const dur =
      Number.isFinite(song.duration) && song.duration > 0 ? formatTime(song.duration) : '';

    li.innerHTML = `
      <span class="online-track-num">${idx + 1}</span>
      <span class="online-track-thumb" style="background: ${pickGradient(song.path)}">
        <img alt="" loading="lazy" />
      </span>
      <div class="online-track-main">
        <div class="online-track-title">${escapeHtml(song.title)}</div>
        <div class="online-track-sub">${escapeHtml(song.artist)}${
          song.album ? ` · ${escapeHtml(song.album)}` : ''
        }</div>
      </div>
      <span class="online-track-dur">${escapeHtml(dur)}</span>
    `;

    hydrateTrackCover(li.querySelector('img'), song.path, seq);

    li.addEventListener('click', () => {
      window.dreamApi.plugins?.registerTracks(tracks);
      setQueue(tracks, { type: 'custom' });
      const targetIdx = state.songs.findIndex((s) => s.path === song.path);
      playSong(targetIdx >= 0 ? targetIdx : 0);
      syncPlayingRowHighlight();
    });

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.dreamApi.plugins?.registerTracks([song]);
      openContextMenu(e.clientX, e.clientY, song, -1);
    });

    list.appendChild(li);
  });

  return list;
}

function createMediaCardGridEl(kind, items, pluginId, seq) {
  const grid = document.createElement('div');
  grid.className = 'online-card-grid';

  for (const item of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'online-media-card';
    const subParts = [];
    if (kind === 'albums' && item.artist) subParts.push(item.artist);
    if (kind === 'playlists' && item.creator) subParts.push(item.creator);
    if (Number.isInteger(item.trackCount) && item.trackCount > 0) {
      subParts.push(t('online.trackCount', { n: item.trackCount }));
    }

    card.innerHTML = `
      <span class="online-media-cover" style="background: ${pickGradient(item.id)}">
        <span class="online-media-fallback">${ICON_NOTE}</span>
        <img alt="" loading="lazy" />
      </span>
      <span class="online-media-title">${escapeHtml(item.title)}</span>
      <span class="online-media-sub">${escapeHtml(subParts.join(' · '))}</span>
    `;

    if (item.artworkUrl) {
      hydrateArtworkCover(card.querySelector('img'), pluginId, item.artworkUrl, seq);
    }

    card.addEventListener('click', () => {
      openMediaDetail(kind === 'albums' ? 'album' : 'playlist', item);
    });

    grid.appendChild(card);
  }
  return grid;
}

function syncPlayingRowHighlight() {
  const contentEl = getEl('onlineContent');
  if (!contentEl) return;
  const currentPath = state.songs[state.currentIndex]?.path || null;
  const rows = contentEl.querySelectorAll('.online-track-row');
  if (rows.length === 0) return;

  const list = detailView ? detailView.tracks : currentItems;
  rows.forEach((row) => {
    const idx = Number(row.dataset.trackIndex);
    const song = list?.[idx];
    row.classList.toggle('active', Boolean(song && currentPath && song.path === currentPath));
  });
}

async function openMediaDetail(kind, item) {
  if (!activePluginId || !item?.id) return;
  const seq = ++loadSeq;
  resetCoverLoader();
  detailView = {
    kind,
    id: item.id,
    title: item.title || '',
    subtitle: kind === 'album' ? item.artist || '' : item.creator || '',
    tracks: [],
    page: 1,
    hasMore: false,
  };
  renderModeTabs();
  renderStatusBox(t('online.loading'));

  const res =
    kind === 'album'
      ? await window.dreamApi.plugins.getAlbumTracks(activePluginId, item.id)
      : await window.dreamApi.plugins.getPlaylistTracks(activePluginId, item.id, 1, 50);

  if (seq !== loadSeq) return;
  if (!res?.ok) {
    renderStatusBox(formatErr(res?.error));
    return;
  }

  if (kind === 'album') {
    detailView.tracks = res.data?.tracks || [];
    detailView.hasMore = false;
  } else {
    detailView.tracks = res.data?.tracks?.items || [];
    detailView.hasMore = res.data?.tracks?.hasMore === true;
  }

  const contentEl = getEl('onlineContent');
  const loadMoreBtn = getEl('btnOnlineLoadMore');
  if (!contentEl) return;

  if (detailView.tracks.length === 0) {
    renderStatusBox(t('online.noResults'));
    return;
  }

  contentEl.replaceChildren(createTrackListEl(detailView.tracks, seq));
  if (loadMoreBtn) loadMoreBtn.hidden = !detailView.hasMore;
}

async function loadActiveView({ append = false } = {}) {
  const sources = ensureActivePlugin();
  renderSourcePills(sources);
  renderModeTabs();

  if (sources.length === 0 || !activePluginId) {
    renderStatusBox(t('online.noSources'), { showSettingsBtn: true });
    return;
  }

  const seq = ++loadSeq;
  resetCoverLoader();
  const contentEl = getEl('onlineContent');
  const loadMoreBtn = getEl('btnOnlineLoadMore');
  if (!contentEl) return;

  if (!append) {
    currentPage = 1;
    currentHasMore = false;
    currentItems = [];
    renderStatusBox(t('online.loading'));
  } else if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
  }

  const query = searchQuery.trim();
  const pluginId = activePluginId;

  try {
    if (!query && activeTab === 'explore') {
      const res = await window.dreamApi.plugins.getHome(pluginId);
      if (seq !== loadSeq) return;
      if (!res?.ok) {
        renderStatusBox(formatErr(res?.error));
        return;
      }
      const sections = res.data || [];
      if (sections.length === 0) {
        renderStatusBox(t('online.emptyExplore'));
        return;
      }
      const frag = document.createDocumentFragment();
      for (const sec of sections) {
        if (!sec?.items?.length) continue;
        const secWrap = document.createElement('section');
        secWrap.className = 'online-section';
        const heading = document.createElement('h3');
        heading.className = 'online-section-title';
        heading.textContent = sec.title;
        secWrap.appendChild(heading);

        if (sec.kind === 'tracks') {
          secWrap.appendChild(createTrackListEl(sec.items, seq));
        } else {
          secWrap.appendChild(createMediaCardGridEl(sec.kind, sec.items, pluginId, seq));
        }
        frag.appendChild(secWrap);
      }
      contentEl.replaceChildren(frag);
      if (loadMoreBtn) loadMoreBtn.hidden = true;
      return;
    }

    if (!query && activeTab === 'myPlaylists') {
      const res = await window.dreamApi.plugins.getUserPlaylists(pluginId);
      if (seq !== loadSeq) return;
      if (!res?.ok) {
        renderStatusBox(formatErr(res?.error), {
          showSettingsBtn: res?.error?.code === 'AUTH_REQUIRED',
        });
        return;
      }
      const playlists = res.data || [];
      if (playlists.length === 0) {
        renderStatusBox(t('online.emptyUserPlaylists'), { showSettingsBtn: true });
        return;
      }
      contentEl.replaceChildren(createMediaCardGridEl('playlists', playlists, pluginId, seq));
      if (loadMoreBtn) loadMoreBtn.hidden = true;
      return;
    }

    // 搜索视图：单曲 / 专辑 / 歌单
    const nextPage = append ? currentPage + 1 : 1;
    const type = activeTab === 'albums' || activeTab === 'playlists' ? activeTab : 'tracks';
    const res = await window.dreamApi.plugins.search(pluginId, {
      type,
      query,
      page: nextPage,
      pageSize: 30,
    });
    if (seq !== loadSeq) return;
    if (!res?.ok) {
      renderStatusBox(formatErr(res?.error));
      return;
    }

    const pageItems = res.data?.items || [];
    currentPage = nextPage;
    currentHasMore = res.data?.hasMore === true;
    currentItems = append ? [...currentItems, ...pageItems] : pageItems;

    if (currentItems.length === 0) {
      renderStatusBox(t('online.noResults'));
      return;
    }

    if (type === 'tracks') {
      contentEl.replaceChildren(createTrackListEl(currentItems, seq));
    } else {
      contentEl.replaceChildren(createMediaCardGridEl(type, currentItems, pluginId, seq));
    }

    if (loadMoreBtn) {
      loadMoreBtn.hidden = !currentHasMore;
      loadMoreBtn.disabled = false;
    }
  } finally {
    if (loadMoreBtn) loadMoreBtn.disabled = false;
  }
}

async function loadMoreDetailPlaylist() {
  if (!detailView || detailView.kind !== 'playlist' || !detailView.hasMore || !activePluginId)
    return;
  const seq = ++loadSeq;
  const loadMoreBtn = getEl('btnOnlineLoadMore');
  if (loadMoreBtn) loadMoreBtn.disabled = true;

  try {
    const nextPage = detailView.page + 1;
    const res = await window.dreamApi.plugins.getPlaylistTracks(
      activePluginId,
      detailView.id,
      nextPage,
      50
    );
    if (seq !== loadSeq) return;
    if (!res?.ok) return;

    const added = res.data?.tracks?.items || [];
    detailView.page = nextPage;
    detailView.tracks = [...detailView.tracks, ...added];
    detailView.hasMore = res.data?.tracks?.hasMore === true;

    const contentEl = getEl('onlineContent');
    if (contentEl) {
      contentEl.replaceChildren(createTrackListEl(detailView.tracks, seq));
    }
    if (loadMoreBtn) loadMoreBtn.hidden = !detailView.hasMore;
  } finally {
    if (loadMoreBtn) loadMoreBtn.disabled = false;
  }
}

function syncSourcesAndLoad() {
  detailView = null;
  loadActiveView({ append: false });
}

export function bindOnlineExploreEvents() {
  if (bound) return;
  bound = true;

  const btnClose = getEl('btnOnlineClose');
  if (btnClose) btnClose.addEventListener('click', closeOnlineExplore);

  const sourceTabs = getEl('onlineSourceTabs');
  if (sourceTabs) {
    sourceTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.online-source-pill');
      if (!btn || !btn.dataset.pluginId) return;
      if (btn.dataset.pluginId === activePluginId && !detailView) return;
      activePluginId = btn.dataset.pluginId;
      detailView = null;
      loadActiveView({ append: false });
    });
  }

  const modeTabs = getEl('onlineModeTabs');
  if (modeTabs) {
    modeTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.online-mode-tab');
      if (!btn || !btn.dataset.tab || btn.dataset.tab === activeTab) return;
      activeTab = btn.dataset.tab;
      loadActiveView({ append: false });
    });
  }

  const searchInput = getEl('onlineSearchInput');
  const clearBtn = getEl('btnOnlineSearchClear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      if (clearBtn) clearBtn.hidden = searchQuery.length === 0;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        detailView = null;
        activeTab = searchQuery.trim() ? 'tracks' : 'explore';
        loadActiveView({ append: false });
      }, 260);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchTimer);
        detailView = null;
        activeTab = searchQuery.trim() ? 'tracks' : 'explore';
        loadActiveView({ append: false });
      }
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      searchQuery = '';
      clearBtn.hidden = true;
      detailView = null;
      activeTab = 'explore';
      loadActiveView({ append: false });
      if (searchInput) searchInput.focus();
    });
  }

  const btnBack = getEl('btnOnlineDetailBack');
  if (btnBack) {
    btnBack.addEventListener('click', () => {
      detailView = null;
      loadActiveView({ append: false });
    });
  }

  const btnPlayAll = getEl('btnOnlinePlayAll');
  if (btnPlayAll) {
    btnPlayAll.addEventListener('click', () => {
      if (!detailView?.tracks?.length) return;
      window.dreamApi.plugins?.registerTracks(detailView.tracks);
      setQueue(detailView.tracks, { type: 'custom' });
      playSong(0);
      syncPlayingRowHighlight();
    });
  }

  const loadMoreBtn = getEl('btnOnlineLoadMore');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      if (detailView) loadMoreDetailPlaylist();
      else loadActiveView({ append: true });
    });
  }

  window.addEventListener('dreamisle:albums-opened', closeOnlineExplore);
  window.addEventListener('dreamisle:song-changed', () => {
    if (isOnlineExploreOpen()) syncPlayingRowHighlight();
  });
  window.addEventListener('dreamisle:plugins-changed', () => {
    if (!isOnlineExploreOpen()) return;
    const sources = getEnabledSourcePlugins();
    if (sources.length === 0) {
      closeOnlineExplore();
    } else if (!sources.some((s) => s.id === activePluginId)) {
      syncSourcesAndLoad();
    } else {
      renderSourcePills(sources);
    }
  });
  window.addEventListener('dreamisle:language-changed', () => {
    if (isOnlineExploreOpen()) {
      renderModeTabs();
    }
  });
}
