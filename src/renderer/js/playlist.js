import { t } from '../../shared/i18n.js';
import { state, ITEM_HEIGHT } from './state.js';
import {
  playlistDrawer,
  playlistsDrawer,
  playlistEl,
  playlistCountEl,
  searchInput,
  letterIndexEl,
  btnPlaylist,
  btnSortTitle,
  btnSortArtist,
  btnSortRandom,
  lyricsScroll,
} from './dom.js';
import { compareByInitial, buildLetterIndex } from '../../shared/initial-letter.js';
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
  refreshLetterIndex();
}

// 索引取哪一列，取决于当前排序模式；默认/随机没有可索引的顺序
const INDEX_KEY = {
  title: (song) => song.title,
  artist: (song) => song.artist,
};

// 重建字母索引表与索引条 DOM。只在按歌名/歌手排序且列表非空时出现。
function refreshLetterIndex() {
  const keyOf = INDEX_KEY[state.sortMode];
  const visible = Boolean(keyOf) && state.filteredSongs.length > 0;

  if (!letterIndexEl) return;

  if (!visible) {
    state.letterIndex = [];
    letterIndexEl.hidden = true;
    letterIndexEl.innerHTML = '';
    return;
  }

  state.letterIndex = buildLetterIndex(state.filteredSongs, keyOf);
  letterIndexEl.hidden = false;
  letterIndexEl.innerHTML = '';

  const fragment = document.createDocumentFragment();
  for (const { letter, index } of state.letterIndex) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'letter-index-item';
    btn.dataset.letter = letter;
    btn.innerText = letter;
    fragment.appendChild(btn);
  }
  letterIndexEl.appendChild(fragment);

  updateActiveLetter();
}

// 高亮当前滚动位置所属的字母组
function updateActiveLetter() {
  if (!letterIndexEl || letterIndexEl.hidden || state.letterIndex.length === 0) return;

  const firstVisibleRow = Math.floor(playlistEl.scrollTop / ITEM_HEIGHT);
  let active = state.letterIndex[0].letter;
  for (const entry of state.letterIndex) {
    if (entry.index > firstVisibleRow) break;
    active = entry.letter;
  }

  for (const btn of letterIndexEl.children) {
    btn.classList.toggle('active', btn.dataset.letter === active);
  }
}

// 跳到某字母组的第一行。
// 这里显式刷新虚拟列表与高亮，而不是等 scroll 事件：滚动事件是异步派发的，
// 而点击是同步动作；把结果押在事件上会让「点同一个字母两次」这类情况没有反应。
function jumpToLetter(letter) {
  const entry = state.letterIndex.find((e) => e.letter === letter);
  if (!entry) return;

  playlistEl.scrollTop = entry.index * ITEM_HEIGHT;
  updateVirtualList();
  updateActiveLetter();
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

    // i 是过滤后列表里的位置，直接当序号用，不需要新数据
    li.innerHTML =
      `<span class="item-index">${i + 1}</span>` +
      `<div class="item-meta">` +
      `<div class="item-title">${songInfo.title}</div>` +
      `<div class="item-artist">${songInfo.artist}</div>` +
      `</div>`;
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
  [btnSortTitle, btnSortArtist, btnSortRandom].forEach((btn) => {
    if (btn) btn.classList.remove('active');
  });
  if (activeBtn) activeBtn.classList.add('active');
}

/**
 * 执行队列重排并更新播放指针
 */
export function applySort(mode, btnEl) {
  if (state.originalSongs.length === 0) return;

  state.sortMode = mode;
  updateSortButtons(btnEl);

  // 记录当前播放的歌曲，以便重排后重定向指针，不干扰当前播放
  const currentPlayingSong = state.songs[state.currentIndex];

  if (mode === 'title') {
    state.songs = [...state.originalSongs].sort((a, b) => compareByInitial(a.title, b.title));
  } else if (mode === 'artist') {
    state.songs = [...state.originalSongs].sort((a, b) => compareByInitial(a.artist, b.artist));
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

// 套用当前激活的排序按钮。任何「列表重新出现」的路径（启动、换队列）都必须走这里：
// 直接调 initVirtualList 是按 state.songs 的物理顺序渲染，而按钮高亮仍是「歌名」——
// 列表顺序和按钮说法对不上，字母索引也会跟着错位。
export function applyActiveSort() {
  const activeSortBtn = [btnSortTitle, btnSortArtist, btnSortRandom].find(
    (btn) => btn && btn.classList.contains('active')
  );
  if (activeSortBtn) applySort(activeSortBtn.dataset.mode, activeSortBtn);
  else applySort('title', btnSortTitle); // 兜底：按钮全没高亮时按歌名排
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

  applyActiveSort();
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

// 手动拖拽调整"正在播放"队列顺序：按 path 重排 songs。
// 列表现在恒处于某种排序下，所以拖拽只改当前播放顺序，
// 下一次重排（点排序按钮 / 换队列 / 同步文件夹）会从 originalSongs 重新生成并覆盖它。
function reorderQueue(fromPath, toPath) {
  if (fromPath === toPath) return;
  const from = state.songs.findIndex((s) => s.path === fromPath);
  const to = state.songs.findIndex((s) => s.path === toPath);
  if (from < 0 || to < 0) return;

  const playingPath = state.songs[state.currentIndex] ? state.songs[state.currentIndex].path : null;
  const [moved] = state.songs.splice(from, 1);
  state.songs.splice(to, 0, moved);

  if (playingPath) {
    state.currentIndex = state.songs.findIndex((s) => s.path === playingPath);
    if (state.currentIndex === -1) state.currentIndex = 0;
  }

  initVirtualList(searchInput.value.trim());
}

export function bindPlaylistEvents() {
  playlistEl.addEventListener('scroll', updateVirtualList);
  // 滚动时同步高亮当前字母组
  playlistEl.addEventListener('scroll', updateActiveLetter);

  if (letterIndexEl) {
    letterIndexEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.letter-index-item');
      if (btn) jumpToLetter(btn.dataset.letter);
    });
  }

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
