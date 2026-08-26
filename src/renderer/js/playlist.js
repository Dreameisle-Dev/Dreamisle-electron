import { t } from '../../shared/i18n.js';
import { state, ITEM_HEIGHT } from './state.js';
import {
  playlistDrawer,
  playlistsDrawer,
  playlistEl,
  playlistCountEl,
  searchInput,
  btnPlaylist,
  btnSortDefault,
  btnSortTitle,
  btnSortArtist,
  btnSortRandom,
  lyricsScroll,
} from './dom.js';
import { compareMixed } from './helpers.js';
import { playSong, resetToEmptyLibrary } from './playback.js';
import { resetLyrics } from './lyrics.js';
import { resolveRestoredIndex } from './playback-restore.js';

export function initVirtualList(filterText = '') {
  const lowerFilter = filterText.toLowerCase();
  state.filteredSongs = filterText
    ? state.songs
        .map((s, i) => ({ ...s, originalIndex: i }))
        .filter(
          (s) =>
            s.title.toLowerCase().includes(lowerFilter) ||
            s.artist.toLowerCase().includes(lowerFilter)
        )
    : state.songs.map((s, i) => ({ ...s, originalIndex: i }));

  playlistCountEl.innerText = t('playlist.count', { n: state.filteredSongs.length });

  state.vsStartIndex = -1;
  updateVirtualList();
}

export function updateVirtualList() {
  const scrollTop = playlistEl.scrollTop;
  const viewportHeight = playlistEl.clientHeight || 800;

  const newStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 5);
  const newEnd = Math.min(
    state.filteredSongs.length,
    Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + 5
  );

  if (
    newStart === state.vsStartIndex &&
    newEnd === state.vsEndIndex &&
    playlistEl.children.length > 0
  )
    return;

  state.vsStartIndex = newStart;
  state.vsEndIndex = newEnd;

  let spacer = document.getElementById('playlistSpacer');
  if (!spacer) {
    spacer = document.createElement('div');
    spacer.id = 'playlistSpacer';
  }
  spacer.style.height = `${state.filteredSongs.length * ITEM_HEIGHT}px`;
  spacer.style.width = '100%';

  playlistEl.innerHTML = '';
  playlistEl.appendChild(spacer);

  const fragment = document.createDocumentFragment();
  for (let i = state.vsStartIndex; i < state.vsEndIndex; i++) {
    const songInfo = state.filteredSongs[i];
    const li = document.createElement('li');
    li.className = `playlist-item ${songInfo.originalIndex === state.currentIndex ? 'active' : ''}`;

    li.style.top = '10px';
    li.style.transform = `translateY(${i * ITEM_HEIGHT}px)`;

    li.draggable = true;
    li.dataset.path = songInfo.path;

    li.innerHTML = `<div class="item-title">${songInfo.title}</div><div class="item-artist">${songInfo.artist}</div>`;
    li.onclick = (e) => {
      if (e.detail === 0) return; // 拖放后合成的 click(detail 0),不是真实点击
      playSong(songInfo.originalIndex);
    };
    fragment.appendChild(li);
  }
  playlistEl.appendChild(fragment);
}

/**
 * 更新排序按钮的高亮状态
 */
function updateSortButtons(activeBtn) {
  [btnSortDefault, btnSortTitle, btnSortArtist, btnSortRandom].forEach((btn) => {
    if (btn) btn.classList.remove('active');
  });
  if (activeBtn) activeBtn.classList.add('active');
}

/**
 * 执行队列重排并更新播放指针
 */
export function applySort(mode, btnEl) {
  if (state.originalSongs.length === 0) return;

  updateSortButtons(btnEl);

  // 记录当前播放的歌曲，以便重排后重定向指针，不干扰当前播放
  const currentPlayingSong = state.songs[state.currentIndex];

  if (mode === 'default') {
    state.songs = [...state.originalSongs];
  } else if (mode === 'title') {
    state.songs = [...state.originalSongs].sort((a, b) => compareMixed(a.title, b.title));
  } else if (mode === 'artist') {
    state.songs = [...state.originalSongs].sort((a, b) => compareMixed(a.artist, b.artist));
  } else if (mode === 'random') {
    // 洗牌算法重新排列
    state.songs = [...state.originalSongs].sort(() => Math.random() - 0.5);
  }

  if (currentPlayingSong) {
    state.currentIndex = state.songs.findIndex((s) => s.path === currentPlayingSong.path);
  }

  // 刷新前端过滤和列表渲染，保留搜索框已有字符
  initVirtualList(searchInput.value.trim());
}

// 应用一套新队列:重定位当前歌曲、套用激活排序、刷新列表(空队列复位)
function applyQueueSongs(songs) {
  const playingPath = state.songs[state.currentIndex] ? state.songs[state.currentIndex].path : null;

  state.originalSongs = [...songs];
  state.songs = [...state.originalSongs];
  state.currentIndex = resolveRestoredIndex(state.songs, { currentSongPath: playingPath });
  if (state.currentIndex === -1) state.currentIndex = state.songs.length > 0 ? 0 : -1;

  // 空队列(如切到空歌单)：停止播放并复位界面状态
  if (state.songs.length === 0) {
    resetToEmptyLibrary();
    resetLyrics();
    if (lyricsScroll) {
      lyricsScroll.innerHTML = `<p class="lyric-line placeholder">${t('lyrics.noLyrics')}</p>`;
    }
  }

  const activeSortBtn = [btnSortDefault, btnSortTitle, btnSortArtist, btnSortRandom].find(
    (btn) => btn && btn.classList.contains('active')
  );
  if (activeSortBtn && activeSortBtn !== btnSortDefault) {
    applySort(activeSortBtn.dataset.mode, activeSortBtn);
  } else {
    initVirtualList(searchInput.value.trim());
  }
}

// 切换播放队列:歌单队列或曲库队列
export function setQueue(songs, activeQueue) {
  state.activeQueue = activeQueue;
  applyQueueSongs(songs);
}

// 用主进程返回的新播放列表替换本地列表:曲库上下文,同时更新曲库缓存
export function applyPlaylistFromMain(playlist) {
  state.librarySongs = [...playlist];
  setQueue(playlist, { type: 'library' });
}

// 手动拖拽调整"正在播放"队列顺序:按 path 重排 songs;默认排序激活时同步 originalSongs 以保持顺序
function reorderQueue(fromPath, toPath) {
  if (fromPath === toPath) return;
  const from = state.songs.findIndex((s) => s.path === fromPath);
  const to = state.songs.findIndex((s) => s.path === toPath);
  if (from < 0 || to < 0) return;

  const playingPath = state.songs[state.currentIndex] ? state.songs[state.currentIndex].path : null;
  const [moved] = state.songs.splice(from, 1);
  state.songs.splice(to, 0, moved);

  if (btnSortDefault && btnSortDefault.classList.contains('active')) {
    const of = state.originalSongs.findIndex((s) => s.path === fromPath);
    const ot = state.originalSongs.findIndex((s) => s.path === toPath);
    if (of >= 0 && ot >= 0) {
      const [m] = state.originalSongs.splice(of, 1);
      state.originalSongs.splice(ot, 0, m);
    }
  }

  if (playingPath) {
    state.currentIndex = state.songs.findIndex((s) => s.path === playingPath);
    if (state.currentIndex === -1) state.currentIndex = 0;
  }

  initVirtualList(searchInput.value.trim());
}

export function bindPlaylistEvents() {
  playlistEl.addEventListener('scroll', updateVirtualList);
  searchInput.addEventListener('input', (e) => initVirtualList(e.target.value.trim()));

  btnPlaylist.addEventListener('click', (e) => {
    e.stopPropagation();
    playlistDrawer.classList.toggle('open');
    playlistsDrawer.classList.remove('open'); // 互斥：打开右侧关左侧
  });
  document.querySelector('.app-container').addEventListener('click', () => {
    playlistDrawer.classList.remove('open');
    playlistsDrawer.classList.remove('open');
  });
  playlistDrawer.addEventListener('click', (e) => e.stopPropagation());

  if (btnSortDefault) btnSortDefault.onclick = () => applySort('default', btnSortDefault);
  if (btnSortTitle) btnSortTitle.onclick = () => applySort('title', btnSortTitle);
  if (btnSortArtist) btnSortArtist.onclick = () => applySort('artist', btnSortArtist);
  if (btnSortRandom) btnSortRandom.onclick = () => applySort('random', btnSortRandom);

  // 拖拽到歌单的起点记录
  playlistEl.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.playlist-item');
    if (!item) return;
    const song = state.songs.find((s) => s.path === item.dataset.path);
    if (!song) return;
    state.dragSong = song;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', song.path);
  });
  // 拖拽结束(含取消)时清理起点记录,防止残留被后续 drop 误消费
  playlistEl.addEventListener('dragend', () => {
    state.dragSong = null;
  });

  // 拖拽调整"正在播放"队列顺序:拖到目标行松手按 path 重排
  playlistEl.addEventListener('dragover', (e) => {
    const item = e.target.closest('.playlist-item');
    if (!item || !state.dragSong) return;
    e.preventDefault();
  });
  playlistEl.addEventListener('drop', (e) => {
    const item = e.target.closest('.playlist-item');
    if (!item || !state.dragSong) return;
    e.preventDefault();
    reorderQueue(state.dragSong.path, item.dataset.path);
    state.dragSong = null;
  });
}
