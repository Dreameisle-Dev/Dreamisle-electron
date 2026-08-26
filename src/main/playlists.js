import { ipcMain } from 'electron';
import { store } from './store.js';
import { t } from '../shared/i18n.js';

const KEY = 'playlists';

// 读取全部歌单(存储损坏时按空列表处理)
function loadPlaylists() {
  const raw = store.get(KEY);
  return Array.isArray(raw) ? raw : [];
}

function savePlaylists(playlists) {
  store.set(KEY, playlists);
}

function sanitizeName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

function isValidName(name) {
  return name.length > 0 && name.length <= 30;
}

// 自动命名:新建歌单 1、新建歌单 2……(避开已存在的自动名)
function nextAutoName(playlists) {
  let n = 1;
  while (true) {
    const candidate = t('playlists.autoName', { n });
    if (!playlists.some((p) => p.name === candidate)) return candidate;
    n++;
  }
}

function createPlaylist(name) {
  const playlists = loadPlaylists();
  let finalName = sanitizeName(name);
  if (!isValidName(finalName)) finalName = nextAutoName(playlists);
  const playlist = {
    id: `pl-${crypto.randomUUID()}`,
    name: finalName,
    createdAt: Date.now(),
    songs: [],
  };
  savePlaylists([...playlists, playlist]);
  return playlist;
}

function renamePlaylist(id, name) {
  const playlists = loadPlaylists();
  const cleaned = sanitizeName(name);
  if (!isValidName(cleaned)) return { ok: false };
  const pl = playlists.find((p) => p.id === id);
  if (!pl) return { ok: false };
  pl.name = cleaned;
  savePlaylists(playlists);
  return { ok: true, playlist: pl };
}

function deletePlaylist(id) {
  savePlaylists(loadPlaylists().filter((p) => p.id !== id));
  return { ok: true };
}

function addSongToPlaylist(id, song) {
  const playlists = loadPlaylists();
  const pl = playlists.find((p) => p.id === id);
  if (!pl || !song || typeof song.path !== 'string')
    return { ok: false, duplicate: false, playlist: pl || null };
  if (pl.songs.some((s) => s.path === song.path))
    return { ok: true, duplicate: true, playlist: pl };
  pl.songs.push({
    path: song.path,
    title: typeof song.title === 'string' ? song.title : '',
    artist: typeof song.artist === 'string' ? song.artist : '',
    url: typeof song.url === 'string' ? song.url : '',
  });
  savePlaylists(playlists);
  return { ok: true, duplicate: false, playlist: pl };
}

function removeSongFromPlaylist(id, path) {
  const playlists = loadPlaylists();
  const pl = playlists.find((p) => p.id === id);
  if (!pl) return { ok: false, playlist: null };
  pl.songs = pl.songs.filter((s) => s.path !== path);
  savePlaylists(playlists);
  return { ok: true, playlist: pl };
}

function reorderPlaylist(id, from, to) {
  const playlists = loadPlaylists();
  const pl = playlists.find((p) => p.id === id);
  if (!pl || from < 0 || from >= pl.songs.length || to < 0 || to >= pl.songs.length)
    return { ok: false, playlist: null };
  const [moved] = pl.songs.splice(from, 1);
  pl.songs.splice(to, 0, moved);
  savePlaylists(playlists);
  return { ok: true, playlist: pl };
}

function prunePlaylists(validPaths) {
  const valid = new Set(Array.isArray(validPaths) ? validPaths : []);
  const playlists = loadPlaylists();
  let pruned = 0;
  for (const pl of playlists) {
    const before = pl.songs.length;
    pl.songs = pl.songs.filter((s) => valid.has(s.path));
    pruned += before - pl.songs.length;
  }
  if (pruned > 0) savePlaylists(playlists);
  return { pruned };
}

export function registerPlaylistsIpc() {
  ipcMain.handle('playlists:list', () => loadPlaylists());
  ipcMain.handle('playlists:create', (event, name) => ({ playlist: createPlaylist(name) }));
  ipcMain.handle('playlists:rename', (event, id, name) => renamePlaylist(id, name));
  ipcMain.handle('playlists:delete', (event, id) => deletePlaylist(id));
  ipcMain.handle('playlists:addSong', (event, id, song) => addSongToPlaylist(id, song));
  ipcMain.handle('playlists:removeSong', (event, id, path) => removeSongFromPlaylist(id, path));
  ipcMain.handle('playlists:reorder', (event, id, from, to) => reorderPlaylist(id, from, to));
  ipcMain.handle('playlists:prune', (event, validPaths) => prunePlaylists(validPaths));
}
