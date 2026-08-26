import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import {
  playlistsDrawer,
  playlistDrawer,
  playlistsListView,
  playlistsDetailView,
  playlistsListEl,
  playlistsCountEl,
  btnNewPlaylist,
  playlistsDetailName,
  playlistsRenameInput,
  btnPlaylistsBack,
  btnRenamePlaylist,
  btnDeletePlaylist,
  playlistsSongListEl,
  contextMenu,
  ctxAddToPlaylist,
  ctxPlaylistOptions,
  playlistEl,
} from './dom.js';
import { escapeHtml, showToast } from './helpers.js';
import { setQueue } from './playlist.js';
import { playSong } from './playback.js';

// 拉取主进程歌单并缓存
export async function loadPlaylists() {
  state.playlists = await window.dreamApi.playlists.list();
}

// 按曲库校验歌单:移除曲库中已不存在的路径(与"正在播放"列表的文件消失行为一致)
// 注意:曲库为空时(未配置文件夹)跳过,避免误清空用户歌单
export async function prunePlaylistsFromLibrary() {
  if (state.librarySongs.length === 0) return;
  const validPaths = state.librarySongs.map((s) => s.path);
  const { pruned } = await window.dreamApi.playlists.prune(validPaths);
  if (pruned === 0) return;
  await loadPlaylists();
  renderPlaylistsList();
  if (state.playlistsView === 'detail') renderDetailSongs();
  // 当前歌单队列中的歌曲被清理时,同步队列
  const active = state.playlists.find(
    (p) => state.activeQueue.type === 'playlist' && p.id === state.activeQueue.id
  );
  if (active) setQueue(active.songs, state.activeQueue);
}

// 渲染歌单卡片列表(含顶部固定的"全部歌曲"项)
export function renderPlaylistsList() {
  playlistsListEl.innerHTML = '';
  playlistsCountEl.innerText = t('playlists.count', { n: state.playlists.length });

  // 固定"全部歌曲"项:切回完整曲库队列
  const allSongs = document.createElement('li');
  allSongs.className = `playlists-card all-songs${state.activeQueue.type === 'library' ? ' active' : ''}`;
  allSongs.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18V5l12-2v13"></path>
      <circle cx="6" cy="18" r="3"></circle>
      <circle cx="18" cy="16" r="3"></circle>
    </svg>
    <span class="playlists-card-name">${escapeHtml(t('playlists.allSongs'))}</span>
    <span class="playlists-card-count">${t('playlist.count', { n: state.librarySongs.length })}</span>`;
  allSongs.onclick = () => {
    setQueue(state.librarySongs, { type: 'library' });
    renderPlaylistsList();
  };
  playlistsListEl.appendChild(allSongs);

  for (const pl of state.playlists) {
    const li = document.createElement('li');
    li.className = `playlists-card${state.activeQueue.type === 'playlist' && state.activeQueue.id === pl.id ? ' active' : ''}`;
    li.dataset.playlistId = pl.id;
    li.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18"></path><path d="M3 12h18"></path><path d="M3 18h18"></path>
      </svg>
      <span class="playlists-card-name">${escapeHtml(pl.name)}</span>
      <span class="playlists-card-count">${t('playlist.count', { n: pl.songs.length })}</span>
      <button class="playlists-card-btn" data-role="rename-playlist" title="${escapeHtml(t('playlists.rename'))}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
        </svg>
      </button>
      <button class="playlists-card-btn" data-role="delete-playlist" title="${escapeHtml(t('playlists.delete'))}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"></path>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
      <svg class="playlists-card-arrow" data-role="open-detail" title="${escapeHtml(t('playlists.manage'))}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 6l6 6-6 6"></path>
      </svg>`;
    li.onclick = (e) => {
      if (e.detail === 0) return; // 拖放后合成的 click(detail 0),不是真实点击
      // 点击按钮/箭头/输入框等管理控件不触发播放
      if (
        e.target.closest('.playlists-card-btn') ||
        e.target.closest('[data-role="open-detail"]') ||
        e.target.closest('input')
      )
        return;
      setQueue(pl.songs, { type: 'playlist', id: pl.id });
      if (pl.songs.length > 0) playSong(0); // 切换歌单:直接播放第一首
      renderPlaylistsList();
    };
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const song = state.dragSong;
      state.dragSong = null;
      if (!song || !li.dataset.playlistId) return;
      const pl = state.playlists.find((p) => p.id === li.dataset.playlistId);
      if (pl) await addSongToPlaylist(pl, song);
    });
    playlistsListEl.appendChild(li);
  }

  if (state.playlists.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'playlists-empty';
    empty.textContent = t('playlists.empty');
    playlistsListEl.appendChild(empty);
  }
}

function getDetailPlaylist() {
  return state.playlists.find((p) => p.id === state.detailPlaylistId) || null;
}

// 详情视图歌曲列表渲染
function renderDetailSongs() {
  const pl = getDetailPlaylist();
  if (!pl) return;
  playlistsSongListEl.innerHTML = '';

  if (pl.songs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'playlists-empty';
    empty.textContent = t('playlists.emptySongs');
    playlistsSongListEl.appendChild(empty);
    return;
  }

  pl.songs.forEach((song, index) => {
    const li = document.createElement('li');
    li.className = 'playlists-song-item';
    li.draggable = true;
    li.dataset.index = index;
    li.innerHTML = `
      <span class="playlists-song-title">${escapeHtml(song.title)}</span>
      <span class="playlists-song-artist">${escapeHtml(song.artist)}</span>
      <button class="playlists-song-remove" title="${escapeHtml(t('playlists.remove'))}">✕</button>`;
    li.addEventListener('dragstart', () => {
      dragFrom = Number(li.dataset.index);
    });
    li.onclick = (e) => {
      if (e.target.closest('.playlists-song-remove')) return;
      if (e.detail === 0) return; // 拖放后合成的 click(detail 0),不是真实点击
      setQueue(pl.songs, { type: 'playlist', id: pl.id }); // 队列与歌单一致
      const sortedIndex = state.songs.findIndex((s) => s.path === song.path);
      playSong(sortedIndex >= 0 ? sortedIndex : 0); // 排序激活时按 path 重定位
      renderPlaylistsList(); // 同步卡片高亮
    };
    li.querySelector('.playlists-song-remove').onclick = (e) => {
      e.stopPropagation();
      removeSongFromDetail(song.path);
    };
    playlistsSongListEl.appendChild(li);
  });
}

function renderDetail() {
  const pl = getDetailPlaylist();
  if (!pl) {
    closePlaylistDetail();
    return;
  }
  playlistsDetailName.textContent = pl.name;
  renderDetailSongs();
}

function openPlaylistDetail(id) {
  resetDeleteConfirm(); // 进入新详情前清除上一个歌单残留的删除确认态
  state.detailPlaylistId = id;
  state.playlistsView = 'detail';
  playlistsListView.style.display = 'none';
  playlistsDetailView.style.display = 'flex';
  renderDetail();
}

function closePlaylistDetail() {
  resetDeleteConfirm(); // 返回列表视图时清除删除确认态
  state.playlistsView = 'list';
  state.detailPlaylistId = null;
  playlistsDetailView.style.display = 'none';
  playlistsListView.style.display = 'flex';
  renderPlaylistsList(); // 同步歌曲数等变化
}

// ===== 右键菜单 =====
let contextSong = null;

export function closeContextMenu() {
  contextMenu.classList.remove('open');
  contextSong = null;
}

function openContextMenu(x, y, song) {
  contextSong = song;
  ctxAddToPlaylist.style.display = 'block';
  ctxPlaylistOptions.style.display = 'none';
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 300)}px`;
  contextMenu.classList.add('open');
}

function openAddToPlaylistSubmenu() {
  ctxAddToPlaylist.style.display = 'none';
  ctxPlaylistOptions.style.display = 'block';
  ctxPlaylistOptions.innerHTML = '';

  for (const pl of state.playlists) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'context-menu-item';
    btn.textContent = pl.name;
    btn.onclick = async () => {
      const song = contextSong;
      closeContextMenu();
      if (song) await addSongToPlaylist(pl, song);
    };
    li.appendChild(btn);
    ctxPlaylistOptions.appendChild(li);
  }

  const liNew = document.createElement('li');
  const btnNew = document.createElement('button');
  btnNew.className = 'context-menu-item';
  btnNew.textContent = t('playlists.newPlaylist');
  btnNew.onclick = async () => {
    const song = contextSong;
    closeContextMenu();
    if (!song) return;
    const { playlist } = await window.dreamApi.playlists.create();
    state.playlists.push(playlist);
    await addSongToPlaylist(playlist, song);
  };
  liNew.appendChild(btnNew);
  ctxPlaylistOptions.appendChild(liNew);
}

// 添加歌曲到歌单:调用主进程,成功后同步缓存并 toast
async function addSongToPlaylist(pl, song) {
  const res = await window.dreamApi.playlists.addSong(pl.id, {
    path: song.path,
    title: song.title,
    artist: song.artist,
    url: song.url,
  });
  if (!res.ok) return;
  const idx = state.playlists.findIndex((p) => p.id === pl.id);
  if (idx >= 0 && res.ok) state.playlists[idx] = res.playlist;
  showToast(res.duplicate ? t('playlists.duplicate') : t('playlists.added'));
  renderPlaylistsList();
  if (state.playlistsView === 'detail' && state.detailPlaylistId === pl.id) renderDetailSongs();
}

// 详情内移除歌曲:更新缓存;若当前队列正是该歌单则同步队列
async function removeSongFromDetail(path) {
  const pl = getDetailPlaylist();
  if (!pl) return;
  const { ok, playlist } = await window.dreamApi.playlists.removeSong(pl.id, path);
  if (!ok) return;
  const idx = state.playlists.findIndex((p) => p.id === pl.id);
  if (idx >= 0) state.playlists[idx] = playlist;
  if (state.activeQueue.type === 'playlist' && state.activeQueue.id === pl.id) {
    setQueue(playlist.songs, state.activeQueue);
  }
  renderDetailSongs();
}

// 歌单内拖拽排序:模块级 dragFrom 记录起点,drop 提交
let dragFrom = null;

// 重命名取消标记:Esc 置位后吞掉输入框隐藏触发的 blur→commitRename,避免"取消变提交"
let renameCancelled = false;

// 重命名:内联输入框,Enter/失焦提交,Esc 取消
async function commitRename() {
  if (renameCancelled) {
    renameCancelled = false;
    return;
  }
  if (playlistsRenameInput.style.display === 'none') return; // blur 触发的二次提交
  const pl = getDetailPlaylist();
  if (!pl) return;
  const name = playlistsRenameInput.value.trim();
  playlistsRenameInput.style.display = 'none';
  playlistsDetailName.style.display = 'block';
  if (!name || name === pl.name) return;
  const { ok, playlist } = await window.dreamApi.playlists.rename(pl.id, name);
  if (!ok) return;
  const idx = state.playlists.findIndex((p) => p.id === pl.id);
  if (idx >= 0) state.playlists[idx] = playlist;
  playlistsDetailName.textContent = playlist.name;
  renderPlaylistsList(); // 列表视图同步名称
}

function cancelRename() {
  renameCancelled = true; // 先置位再隐藏,blur 触发的 commitRename 将被吞掉
  const pl = getDetailPlaylist();
  playlistsRenameInput.style.display = 'none';
  playlistsDetailName.style.display = 'block';
  if (pl) playlistsDetailName.textContent = pl.name;
}

// 两段式删除确认:第一次点击进入确认态,3 秒超时复原
let deleteConfirmTimer = null;

// 重置删除确认态:清除定时器并恢复按钮外观(切换详情/返回列表时清除残留确认态)
function resetDeleteConfirm() {
  clearTimeout(deleteConfirmTimer);
  btnDeletePlaylist.classList.remove('confirm-danger');
  btnDeletePlaylist.title = t('playlists.delete');
}

async function confirmDeletePlaylist(id) {
  clearTimeout(deleteConfirmTimer);
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return;
  const { ok } = await window.dreamApi.playlists.delete(id);
  if (!ok) return;
  state.playlists = state.playlists.filter((p) => p.id !== id);
  // 当前队列来自被删歌单:切回曲库
  if (state.activeQueue.type === 'playlist' && state.activeQueue.id === id) {
    setQueue(state.librarySongs, { type: 'library' });
  }
  if (state.playlistsView === 'detail' && state.detailPlaylistId === id) {
    closePlaylistDetail();
  } else {
    renderPlaylistsList();
  }
}

// 卡片内联重命名:名称变输入框,Enter/失焦提交,Esc 取消(done 守卫防 blur 二次提交)
function startCardRename(card) {
  const pl = state.playlists.find((p) => p.id === card.dataset.playlistId);
  if (!pl) return;
  const nameSpan = card.querySelector('.playlists-card-name');
  const input = document.createElement('input');
  input.className = 'playlists-card-rename-input';
  input.value = pl.name;
  input.maxLength = 30;
  nameSpan.style.display = 'none';
  nameSpan.after(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!name || name === pl.name) {
      renderPlaylistsList();
      return;
    }
    const { ok, playlist } = await window.dreamApi.playlists.rename(pl.id, name);
    if (!ok) {
      renderPlaylistsList();
      return;
    }
    const idx = state.playlists.findIndex((p) => p.id === pl.id);
    if (idx >= 0) state.playlists[idx] = playlist;
    renderPlaylistsList();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    renderPlaylistsList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', commit);
}

// 卡片两段式删除:按钮进入确认态,再点一次执行删除
function handleCardDelete(btn) {
  if (btn.classList.contains('confirm-danger')) {
    const card = btn.closest('.playlists-card');
    btn.classList.remove('confirm-danger');
    btn.title = t('playlists.delete');
    if (card) confirmDeletePlaylist(card.dataset.playlistId);
  } else {
    btn.classList.add('confirm-danger');
    btn.title = t('playlists.confirmDelete');
    setTimeout(() => {
      btn.classList.remove('confirm-danger');
      btn.title = t('playlists.delete');
    }, 3000);
  }
}

// 长按 Left Ctrl 呼出的歌单抽屉:切换显隐,与右侧播放列表抽屉互斥;打开时刷新列表
export async function togglePlaylistsDrawer() {
  if (playlistsDrawer.classList.contains('open')) {
    playlistsDrawer.classList.remove('open');
  } else {
    playlistDrawer.classList.remove('open');
    playlistsDrawer.classList.add('open');
    await loadPlaylists();
    renderPlaylistsList();
  }
}

export function bindPlaylistsEvents() {
  // 点击抽屉内部不冒泡到主区域(主区域点击关闭由 playlist.js 统一处理)
  playlistsDrawer.addEventListener('click', (e) => e.stopPropagation());

  // 新建歌单(自动命名)
  btnNewPlaylist.onclick = async () => {
    const { playlist } = await window.dreamApi.playlists.create();
    state.playlists.push(playlist);
    renderPlaylistsList();
  };

  // 卡片控件委托:箭头 → 详情视图;重命名/删除按钮 → 对应操作(卡片 onclick 已拦截这些控件,不会误触发播放)
  playlistsListEl.addEventListener('click', (e) => {
    const card = e.target.closest('.playlists-card');
    if (!card || !card.dataset.playlistId) return;
    if (e.target.closest('[data-role="open-detail"]')) {
      e.stopPropagation();
      openPlaylistDetail(card.dataset.playlistId);
    } else if (e.target.closest('[data-role="rename-playlist"]')) {
      e.stopPropagation();
      startCardRename(card);
    } else if (e.target.closest('[data-role="delete-playlist"]')) {
      e.stopPropagation();
      handleCardDelete(e.target.closest('[data-role="delete-playlist"]'));
    }
  });

  // 返回列表视图
  btnPlaylistsBack.onclick = closePlaylistDetail;

  // 重命名
  btnRenamePlaylist.onclick = () => {
    const pl = getDetailPlaylist();
    if (!pl) return;
    playlistsDetailName.style.display = 'none';
    playlistsRenameInput.style.display = 'block';
    playlistsRenameInput.value = pl.name;
    playlistsRenameInput.focus();
    playlistsRenameInput.select();
  };
  playlistsRenameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  });
  playlistsRenameInput.addEventListener('blur', commitRename);

  // 两段式删除(详情视图)
  btnDeletePlaylist.onclick = () => {
    if (btnDeletePlaylist.classList.contains('confirm-danger')) {
      confirmDeletePlaylist(state.detailPlaylistId);
    } else {
      btnDeletePlaylist.classList.add('confirm-danger');
      btnDeletePlaylist.title = t('playlists.confirmDelete');
      clearTimeout(deleteConfirmTimer);
      deleteConfirmTimer = setTimeout(resetDeleteConfirm, 3000);
    }
  };

  // 歌单内拖拽排序
  playlistsSongListEl.addEventListener('dragover', (e) => {
    const target = e.target.closest('.playlists-song-item');
    if (!target || dragFrom === null) return;
    e.preventDefault();
  });
  playlistsSongListEl.addEventListener('drop', async (e) => {
    const target = e.target.closest('.playlists-song-item');
    if (!target || dragFrom === null) return;
    e.preventDefault();
    const from = dragFrom;
    dragFrom = null;
    const to = Number(target.dataset.index);
    if (to === from) return;
    const pl = getDetailPlaylist();
    if (!pl) return;
    const { ok, playlist } = await window.dreamApi.playlists.reorder(pl.id, from, to);
    if (!ok) return;
    const idx = state.playlists.findIndex((p) => p.id === pl.id);
    if (idx >= 0) state.playlists[idx] = playlist;
    if (state.activeQueue.type === 'playlist' && state.activeQueue.id === pl.id) {
      setQueue(playlist.songs, state.activeQueue);
    }
    renderDetailSongs();
  });

  // 右侧播放列表右键 → 添加到歌单
  playlistEl.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.playlist-item');
    if (!item) return;
    e.preventDefault();
    const song = state.songs.find((s) => s.path === item.dataset.path);
    if (song) openContextMenu(e.clientX, e.clientY, song);
  });

  // 菜单交互
  ctxAddToPlaylist.onclick = openAddToPlaylistSubmenu;
  document.addEventListener('click', (e) => {
    if (contextMenu.classList.contains('open') && !contextMenu.contains(e.target))
      closeContextMenu();
  });

  // 从右侧列表拖拽歌曲时,靠近左缘自动展开歌单抽屉作为投放目标;拖拽结束恢复原状
  document.addEventListener('dragstart', () => {
    state.dragAutoOpenedDrawer = false;
  });
  document.addEventListener('dragover', (e) => {
    if (!state.dragSong) return;
    if (e.clientX < 60 && !playlistsDrawer.classList.contains('open')) {
      playlistsDrawer.classList.add('open');
      loadPlaylists()
        .then(() => renderPlaylistsList())
        .catch(() => {});
      state.dragAutoOpenedDrawer = true;
    }
  });
  document.addEventListener('dragend', () => {
    if (state.dragAutoOpenedDrawer) {
      playlistsDrawer.classList.remove('open');
      state.dragAutoOpenedDrawer = false;
    }
  });
}
