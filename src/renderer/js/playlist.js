import { t } from '../../shared/i18n.js';
import { state, ITEM_HEIGHT } from './state.js';
import {
  playlistDrawer,
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

    li.innerHTML = `<div class="item-title">${songInfo.title}</div><div class="item-artist">${songInfo.artist}</div>`;
    li.onclick = () => playSong(songInfo.originalIndex);
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

// 用主进程返回的新播放列表替换本地列表：按路径重定位当前歌曲、套用排序、刷新列表
export function applyPlaylistFromMain(playlist) {
  const playingPath = state.songs[state.currentIndex] ? state.songs[state.currentIndex].path : null;

  state.originalSongs = [...playlist];
  state.songs = [...state.originalSongs];
  state.currentIndex = resolveRestoredIndex(state.songs, { currentSongPath: playingPath });
  if (state.currentIndex === -1) state.currentIndex = state.songs.length > 0 ? 0 : -1;

  // 空库（如移除最后一个文件夹）：停止播放并复位界面状态
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

export function bindPlaylistEvents() {
  playlistEl.addEventListener('scroll', updateVirtualList);
  searchInput.addEventListener('input', (e) => initVirtualList(e.target.value.trim()));

  btnPlaylist.addEventListener('click', (e) => {
    e.stopPropagation();
    playlistDrawer.classList.toggle('open');
  });
  document
    .querySelector('.app-container')
    .addEventListener('click', () => playlistDrawer.classList.remove('open'));
  playlistDrawer.addEventListener('click', (e) => e.stopPropagation());

  if (btnSortDefault) btnSortDefault.onclick = () => applySort('default', btnSortDefault);
  if (btnSortTitle) btnSortTitle.onclick = () => applySort('title', btnSortTitle);
  if (btnSortArtist) btnSortArtist.onclick = () => applySort('artist', btnSortArtist);
  if (btnSortRandom) btnSortRandom.onclick = () => applySort('random', btnSortRandom);
}
