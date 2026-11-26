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
  playlistsDetailMeta,
  playlistsDetailName,
  playlistsDetailCount,
  playlistsRenameInput,
  btnPlaylistsBack,
  btnLocatePlaylistCurrent,
  btnRenamePlaylist,
  btnDeletePlaylist,
  playlistsSongListEl,
  contextMenu,
  ctxPlayNext,
  ctxRemoveFromQueue,
  ctxAddToQueue,
  ctxAddToPlaylist,
  ctxPlaylistOptions,
  playlistEl,
} from './dom.js';
import { escapeHtml, showToast } from './helpers.js';
import { buildFolderTree } from '../../shared/folder.js';
import { groupSongsByAlbum } from '../../shared/albums.js';
import { addSongToQueueEnd, moveSongToNext, removeSongFromQueue, setQueue } from './playlist.js';
import { playSong } from './playback.js';
import { openAlbums, closeAlbums } from './albums.js';

// 文件夹树里被折叠的节点与分组折叠态（会话级，不持久化）
const collapsedFolders = new Set();
let foldersSectionCollapsed = false;
// 按 librarySongs 引用缓存专辑数，避免每次抽屉重渲染重复全量分组
let cachedAlbumCountSource = null;
let cachedAlbumCount = 0;

function getAlbumCount() {
  if (cachedAlbumCountSource !== state.librarySongs) {
    cachedAlbumCountSource = state.librarySongs;
    cachedAlbumCount = groupSongsByAlbum(state.librarySongs).length;
  }
  return cachedAlbumCount;
}

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

// 歌单抽屉内联图标（统一 1.8 线宽，随文字色继承）
const ICON_LIBRARY = `<svg class="playlists-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
const ICON_ALBUMS = `<svg class="playlists-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="12" height="16" rx="2"></rect><path d="M16 7.5a4.5 4.5 0 1 1 0 9"></path><circle cx="16" cy="12" r="1.2" fill="currentColor" stroke="none"></circle></svg>`;
const ICON_CHEVRON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>`;
const ICON_FOLDER = `<svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`;
const ICON_EMPTY_PLAYLIST = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
const ICON_REMOVE = `<svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5"></line><line x1="8.5" y1="1.5" x2="1.5" y2="8.5"></line></svg>`;

// 渲染歌单卡片列表(含顶部固定的"全部歌曲"项)
export function renderPlaylistsList() {
  const prevScrollTop = playlistsListEl.scrollTop;
  const fragment = document.createDocumentFragment();
  playlistsCountEl.innerText = t('playlists.count', { n: state.playlists.length });

  // 固定"全部歌曲"项:切回完整曲库队列
  const allSongs = document.createElement('li');
  allSongs.className = `playlists-card all-songs${state.activeQueue.type === 'library' ? ' active' : ''}`;
  allSongs.innerHTML = `
    ${ICON_LIBRARY}
    <span class="playlists-card-name">${escapeHtml(t('playlists.allSongs'))}</span>
    <span class="playlists-card-count">${t('playlist.count', { n: state.librarySongs.length })}</span>`;
  allSongs.onclick = () => {
    setQueue(state.librarySongs, { type: 'library' });
    closeAlbums();
    renderPlaylistsList();
  };
  fragment.appendChild(allSongs);

  // 固定"专辑"入口:打开 Cover Flow 专辑墙
  const albumCount = getAlbumCount();
  const albumsEntry = document.createElement('li');
  albumsEntry.className = `playlists-card albums-entry-card${state.activeQueue.type === 'album' ? ' active' : ''}`;
  albumsEntry.id = 'btnDrawerAlbums';
  albumsEntry.innerHTML = `
    ${ICON_ALBUMS}
    <span class="playlists-card-name">${escapeHtml(t('albums.title'))}</span>
    <span class="playlists-card-count">${t('albums.count', { n: albumCount })}</span>`;
  albumsEntry.onclick = () => {
    openAlbums();
  };
  fragment.appendChild(albumsEntry);

  const appendDivider = () => {
    const divider = document.createElement('li');
    divider.className = 'playlists-section-sep';
    divider.setAttribute('aria-hidden', 'true');
    fragment.appendChild(divider);
  };

  // 文件夹树：以设置的曲库根目录为根，父文件夹包含子文件夹的歌曲
  const folderRoots = buildFolderTree(state.librarySongs, state.musicFolders);
  if (folderRoots.length > 0) {
    appendDivider();
    const folderLabel = document.createElement('li');
    folderLabel.className = 'playlists-section-label-wrap';
    folderLabel.innerHTML = `<button type="button" class="playlists-section-toggle" aria-expanded="${!foldersSectionCollapsed}" title="${escapeHtml(
      foldersSectionCollapsed ? t('folders.expand') : t('folders.collapse')
    )}"><span>${escapeHtml(t('folders.section'))}</span>${ICON_CHEVRON}</button>`;
    folderLabel.querySelector('.playlists-section-toggle').onclick = () => {
      foldersSectionCollapsed = !foldersSectionCollapsed;
      renderPlaylistsList();
    };
    fragment.appendChild(folderLabel);

    const appendFolderNode = (node, depth, isConfiguredRoot) => {
      // 纯容器的根目录（本身没有直接歌曲）不显示，把子文件夹提上来
      if (isConfiguredRoot && node.directSongs.length === 0) {
        for (const child of node.children) appendFolderNode(child, depth, false);
        return;
      }

      const active = state.activeQueue.type === 'folder' && state.activeQueue.path === node.path;
      const li = document.createElement('li');
      li.className = `playlists-card folder-card${depth > 0 ? ' folder-card-child' : ''}${active ? ' active' : ''}`;
      li.style.setProperty('--depth', String(depth));
      li.title = node.path;

      const hasChildren = node.children.length > 0;
      const collapsed = collapsedFolders.has(node.path);
      const caret = hasChildren
        ? `<button class="folder-caret" type="button" aria-label="${escapeHtml(
            collapsed ? t('folders.expand') : t('folders.collapse')
          )}" aria-expanded="${!collapsed}">${ICON_CHEVRON}</button>`
        : '<span class="folder-caret folder-caret-empty" aria-hidden="true"></span>';
      li.innerHTML =
        caret +
        ICON_FOLDER +
        `<span class="playlists-card-name">${escapeHtml(node.name)}</span>` +
        `<span class="playlists-card-count">${t('playlist.count', { n: node.songs.length })}</span>`;

      if (hasChildren) {
        li.querySelector('.folder-caret').onclick = (e) => {
          e.stopPropagation();
          if (collapsedFolders.has(node.path)) collapsedFolders.delete(node.path);
          else collapsedFolders.add(node.path);
          renderPlaylistsList();
        };
      }

      li.onclick = (e) => {
        if (e.detail === 0) return; // 拖放后合成的 click(detail 0)，不是真实点击
        if (e.target.closest('.folder-caret')) return;
        // 当前歌曲就在这棵文件夹树里时继续播放；否则从第一首开始
        const playingPath = state.songs[state.currentIndex]?.path;
        const keepPlaying = node.songs.some((song) => song.path === playingPath);
        setQueue(node.songs, { type: 'folder', path: node.path });
        if (!keepPlaying) playSong(0);
        closeAlbums();
        renderPlaylistsList();
      };

      fragment.appendChild(li);

      if (hasChildren && !collapsed) {
        for (const child of node.children) appendFolderNode(child, depth + 1, false);
      }
    };

    if (!foldersSectionCollapsed) {
      for (const root of folderRoots) appendFolderNode(root, 0, true);
    }
  }

  // 分隔“全部歌曲/文件夹”与用户自建歌单区域
  appendDivider();
  const playlistLabel = document.createElement('li');
  playlistLabel.className = 'playlists-section-label';
  playlistLabel.textContent = t('playlists.title');
  fragment.appendChild(playlistLabel);

  for (const pl of state.playlists) {
    const li = document.createElement('li');
    li.className = `playlists-card playlist-item-card${state.activeQueue.type === 'playlist' && state.activeQueue.id === pl.id ? ' active' : ''}`;
    li.dataset.playlistId = pl.id;
    li.innerHTML = `
      <span class="playlists-card-name">${escapeHtml(pl.name)}</span>
      <span class="playlists-card-meta">
        <span class="playlists-card-count">${t('playlist.count', { n: pl.songs.length })}</span>
        <span class="playlists-card-actions">
          <button type="button" class="playlists-card-btn" data-role="rename-playlist" title="${escapeHtml(t('playlists.rename'))}" aria-label="${escapeHtml(t('playlists.rename'))}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
            </svg>
          </button>
          <button type="button" class="playlists-card-btn" data-role="delete-playlist" title="${escapeHtml(t('playlists.delete'))}" aria-label="${escapeHtml(t('playlists.delete'))}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 6h18"></path>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </span>
      </span>
      <button type="button" class="playlists-card-btn playlists-card-open" data-role="open-detail" title="${escapeHtml(t('playlists.manage'))}" aria-label="${escapeHtml(t('playlists.manage'))}">
        ${ICON_CHEVRON}
      </button>`;
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
      closeAlbums();
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
    fragment.appendChild(li);
  }

  if (state.playlists.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'playlists-empty';
    empty.innerHTML = `${ICON_EMPTY_PLAYLIST}<span>${escapeHtml(t('playlists.empty'))}</span>`;
    fragment.appendChild(empty);
  }

  playlistsListEl.replaceChildren(fragment);
  playlistsListEl.scrollTop = prevScrollTop;
}

function getDetailPlaylist() {
  return state.playlists.find((p) => p.id === state.detailPlaylistId) || null;
}

let detailLocateFlashTimer = null;

function syncDetailLocateButton(pl = getDetailPlaylist()) {
  if (!btnLocatePlaylistCurrent) return;
  const currentPath = state.songs[state.currentIndex]?.path || null;
  const exists = Boolean(
    pl && currentPath && pl.songs.some((song) => song && song.path === currentPath)
  );
  btnLocatePlaylistCurrent.hidden = !exists;
}

function locateCurrentInPlaylistDetail() {
  const pl = getDetailPlaylist();
  const currentPath = state.songs[state.currentIndex]?.path || null;
  if (!pl || !currentPath) return false;

  let targetRow = null;
  for (const li of playlistsSongListEl.children) {
    if (li.dataset && li.dataset.path === currentPath) {
      targetRow = li;
      break;
    }
  }
  if (!targetRow) return false;

  const viewportHeight = playlistsSongListEl.clientHeight || 600;
  const rowCenter = targetRow.offsetTop + targetRow.offsetHeight / 2;
  const maxScroll = Math.max(0, playlistsSongListEl.scrollHeight - viewportHeight);
  const targetTop = Math.max(0, Math.min(maxScroll, Math.round(rowCenter - viewportHeight / 2)));

  const isPerf = document.body.classList.contains('performance-mode');
  const distance = Math.abs(targetTop - playlistsSongListEl.scrollTop);
  if (isPerf || distance > viewportHeight * 2 || distance < 4) {
    playlistsSongListEl.scrollTop = targetTop;
  } else {
    playlistsSongListEl.scrollTo({ top: targetTop, behavior: 'smooth' });
  }

  clearTimeout(detailLocateFlashTimer);
  targetRow.classList.remove('locate-flash');
  void targetRow.offsetWidth;
  targetRow.classList.add('locate-flash');
  detailLocateFlashTimer = setTimeout(() => {
    detailLocateFlashTimer = null;
    targetRow.classList.remove('locate-flash');
  }, 820);
  return true;
}

// 详情视图歌曲列表渲染
function renderDetailSongs() {
  const pl = getDetailPlaylist();
  if (!pl) return;
  syncDetailLocateButton(pl);
  if (playlistsDetailCount) {
    playlistsDetailCount.textContent = t('playlist.count', { n: pl.songs.length });
  }
  const prevScrollTop = playlistsSongListEl.scrollTop;
  const fragment = document.createDocumentFragment();

  if (pl.songs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'playlists-empty';
    empty.innerHTML = `${ICON_EMPTY_PLAYLIST}<span>${escapeHtml(t('playlists.emptySongs'))}</span>`;
    fragment.appendChild(empty);
    playlistsSongListEl.replaceChildren(fragment);
    return;
  }

  const playingPath =
    state.activeQueue.type === 'playlist' && state.activeQueue.id === pl.id
      ? state.songs[state.currentIndex]?.path
      : null;

  pl.songs.forEach((song, index) => {
    const li = document.createElement('li');
    const isPlaying = playingPath && song.path === playingPath;
    li.className = `playlists-song-item${isPlaying ? ' active' : ''}`;
    li.draggable = true;
    li.dataset.index = String(index);
    li.dataset.path = song.path;
    // 序号 + 标题/歌手双行，与播放队列保持一致的扫视节奏；交互走容器事件委托
    li.innerHTML = `
      <span class="playlists-song-index">${index + 1}</span>
      <div class="item-meta">
        <div class="playlists-song-title">${escapeHtml(song.title)}</div>
        <div class="playlists-song-artist">${escapeHtml(song.artist)}</div>
      </div>
      <button type="button" class="playlists-song-remove" title="${escapeHtml(t('playlists.remove'))}" aria-label="${escapeHtml(t('playlists.remove'))}">${ICON_REMOVE}</button>`;
    fragment.appendChild(li);
  });

  playlistsSongListEl.replaceChildren(fragment);
  playlistsSongListEl.scrollTop = prevScrollTop;
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
  playlistsSongListEl.replaceChildren(); // 立即释放详情页歌曲 DOM
  renderPlaylistsList(); // 同步歌曲数等变化
}

let contextSong = null;
// 右键来源是播放队列行时，记录该行在 state.songs 中的下标（队列允许重复歌曲）
let contextQueueIndex = -1;
let contextAnchor = { x: 0, y: 0 };

export function closeContextMenu() {
  contextMenu.classList.remove('open');
  contextSong = null;
  contextQueueIndex = -1;
}

// 菜单高度不是常量：展开「添加到歌单」后条目数 = 歌单数 + 1，歌单一多菜单会变很高。
// 所以按实测尺寸贴边，而不是用写死的 300px 之类。
const MENU_EDGE = 8;

function placeContextMenu() {
  const w = contextMenu.offsetWidth;
  const h = contextMenu.offsetHeight;
  const maxX = Math.max(MENU_EDGE, window.innerWidth - w - MENU_EDGE);
  const maxY = Math.max(MENU_EDGE, window.innerHeight - h - MENU_EDGE);
  contextMenu.style.left = `${Math.max(MENU_EDGE, Math.min(contextAnchor.x, maxX))}px`;
  contextMenu.style.top = `${Math.max(MENU_EDGE, Math.min(contextAnchor.y, maxY))}px`;
}

function openContextMenu(x, y, song, queueIndex = -1) {
  contextSong = song;
  contextQueueIndex = queueIndex;
  contextAnchor = { x, y };
  // 在当前播放队列里的歌才显示“从播放队列移除”
  const inQueue = queueIndex >= 0 || (song && state.songs.some((item) => item.path === song.path));
  ctxRemoveFromQueue.style.display = inQueue ? 'block' : 'none';
  ctxAddToPlaylist.style.display = 'block';
  ctxPlaylistOptions.style.display = 'none';
  // 先挂 open 再量：opacity/transform 不参与布局，量到的就是最终尺寸
  contextMenu.classList.add('open');
  placeContextMenu();
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

  const liSep = document.createElement('li');
  liSep.className = 'sep';
  ctxPlaylistOptions.appendChild(liSep);

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

  // 展开后菜单变高，重新贴一次边，否则贴底弹出的菜单会伸到窗口外
  placeContextMenu();
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
  if (playlistsDetailMeta) playlistsDetailMeta.style.display = '';
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
  if (playlistsDetailMeta) playlistsDetailMeta.style.display = '';
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
const cardDeleteTimers = new WeakMap();

function handleCardDelete(btn) {
  const prevTimer = cardDeleteTimers.get(btn);
  if (prevTimer) {
    clearTimeout(prevTimer);
    cardDeleteTimers.delete(btn);
  }
  if (btn.classList.contains('confirm-danger')) {
    const card = btn.closest('.playlists-card');
    btn.classList.remove('confirm-danger');
    btn.title = t('playlists.delete');
    if (card) confirmDeletePlaylist(card.dataset.playlistId);
  } else {
    btn.classList.add('confirm-danger');
    btn.title = t('playlists.confirmDelete');
    const timer = setTimeout(() => {
      cardDeleteTimers.delete(btn);
      btn.classList.remove('confirm-danger');
      btn.title = t('playlists.delete');
    }, 3000);
    cardDeleteTimers.set(btn, timer);
  }
}

// 长按 Left Ctrl 呼出的歌单抽屉:切换显隐,与右侧播放列表抽屉互斥;打开时刷新列表
export async function togglePlaylistsDrawer() {
  if (playlistsDrawer.classList.contains('open')) {
    playlistsDrawer.classList.remove('open');
    if (state.playlistsView === 'detail') playlistsSongListEl.replaceChildren();
  } else {
    playlistDrawer.classList.remove('open');
    playlistsDrawer.classList.add('open');
    await loadPlaylists();
    renderPlaylistsList();
    if (state.playlistsView === 'detail') renderDetail();
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
    playlistsListEl.scrollTop = playlistsListEl.scrollHeight;
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
  if (btnLocatePlaylistCurrent) {
    btnLocatePlaylistCurrent.onclick = locateCurrentInPlaylistDetail;
  }

  // 重命名
  btnRenamePlaylist.onclick = () => {
    const pl = getDetailPlaylist();
    if (!pl) return;
    if (playlistsDetailMeta) playlistsDetailMeta.style.display = 'none';
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

  // 歌单详情行交互统一走事件委托，避免大歌单为每行绑定多个独立闭包
  playlistsSongListEl.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.playlists-song-item');
    if (!item) return;
    dragFrom = Number(item.dataset.index);
  });

  playlistsSongListEl.addEventListener('click', (e) => {
    const item = e.target.closest('.playlists-song-item');
    if (!item) return;
    if (e.target.closest('.playlists-song-remove')) {
      e.stopPropagation();
      if (item.dataset.path) removeSongFromDetail(item.dataset.path);
      return;
    }
    if (e.detail === 0) return; // 拖放后合成的 click(detail 0),不是真实点击
    const pl = getDetailPlaylist();
    const song = pl && pl.songs[Number(item.dataset.index)];
    if (!pl || !song) return;
    setQueue(pl.songs, { type: 'playlist', id: pl.id }); // 队列与歌单一致
    const sortedIndex = state.songs.findIndex((s) => s.path === song.path);
    playSong(sortedIndex >= 0 ? sortedIndex : 0); // 排序激活时按 path 重定位
    renderPlaylistsList(); // 同步卡片高亮
    renderDetailSongs(); // 同步详情内当前播放行高亮
  });

  // 歌单详情里右键同样可以加入播放队列 / 添加到歌单
  playlistsSongListEl.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.playlists-song-item');
    if (!item) return;
    const pl = getDetailPlaylist();
    const song = pl && pl.songs[Number(item.dataset.index)];
    if (!song) return;
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, song, -1);
  });

  // 歌单内拖拽排序
  const clearSongDragOver = () => {
    playlistsSongListEl
      .querySelectorAll('.playlists-song-item.drag-over')
      .forEach((el) => el.classList.remove('drag-over'));
  };
  playlistsSongListEl.addEventListener('dragover', (e) => {
    const target = e.target.closest('.playlists-song-item');
    if (!target || dragFrom === null) return;
    e.preventDefault();
    if (!target.classList.contains('drag-over')) {
      clearSongDragOver();
      target.classList.add('drag-over');
    }
  });
  playlistsSongListEl.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.playlists-song-item');
    if (target && !target.contains(e.relatedTarget)) target.classList.remove('drag-over');
  });
  playlistsSongListEl.addEventListener('dragend', () => {
    dragFrom = null;
    clearSongDragOver();
  });
  playlistsSongListEl.addEventListener('drop', async (e) => {
    const target = e.target.closest('.playlists-song-item');
    clearSongDragOver();
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

  // 右侧播放队列右键 → 队列操作 / 添加到歌单
  playlistEl.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.playlist-item');
    if (!item) return;
    e.preventDefault();
    const index = Number(item.dataset.index);
    const song = state.songs[index];
    if (song) openContextMenu(e.clientX, e.clientY, song, index);
  });

  // 菜单交互：下一首播放 / 添加到播放队列 / 从播放队列移除
  ctxPlayNext.onclick = () => {
    const song = contextSong;
    const queueIndex = contextQueueIndex;
    closeContextMenu();
    if (!song) return;

    const result = moveSongToNext(song, queueIndex);
    if (result === 'current') showToast(t('queue.playingNow'));
    else if (result === 'alreadyNext') showToast(t('queue.alreadyNext'));
    else if (result === 'moved' || result === 'added') showToast(t('queue.addedNext'));
  };

  ctxAddToQueue.onclick = () => {
    const song = contextSong;
    closeContextMenu();
    if (!song) return;

    if (addSongToQueueEnd(song) === 'added') showToast(t('queue.added'));
  };

  ctxRemoveFromQueue.onclick = () => {
    const song = contextSong;
    const queueIndex = contextQueueIndex;
    closeContextMenu();
    if (!song) return;

    const result = removeSongFromQueue(song, queueIndex);
    if (result === 'current') showToast(t('queue.playingCannotRemove'));
    else if (result === 'removed') showToast(t('queue.removed'));
  };

  ctxAddToPlaylist.onclick = openAddToPlaylistSubmenu;
  document.addEventListener('click', (e) => {
    if (contextMenu.classList.contains('open') && !contextMenu.contains(e.target))
      closeContextMenu();
  });

  // 队列在外部变更（如从专辑墙点播）且抽屉正开着时，实时同步高亮状态
  window.addEventListener('dreamisle:queue-changed', () => {
    if (playlistsDrawer.classList.contains('open')) renderPlaylistsList();
  });
  window.addEventListener('dreamisle:song-changed', () => {
    if (state.playlistsView === 'detail') renderDetailSongs();
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
        .then(() => {
          renderPlaylistsList();
          if (state.playlistsView === 'detail') renderDetail();
        })
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
