import { store, getMusicFolders } from './store.js';
import { t } from '../shared/i18n.js';
import { handleMainIpc, isAllowedAudioPathSync, sanitizeAudioUrl } from './security.js';

const KEY = 'playlists';
const MAX_PLAYLISTS = 500;
const MAX_SONGS_PER_PLAYLIST = 10000;

// 读取全部歌单(存储损坏时按空列表处理)
export function loadPlaylists() {
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
  if (playlists.length >= MAX_PLAYLISTS) {
    throw new Error('Playlist limit reached');
  }
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
  if (typeof id !== 'string') return { ok: false };
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
  if (typeof id !== 'string') return { ok: false };
  savePlaylists(loadPlaylists().filter((p) => p.id !== id));
  return { ok: true };
}

function sanitizePlaylistSong(song) {
  if (!song || typeof song !== 'object' || Array.isArray(song)) return null;
  if (!isAllowedAudioPathSync(song.path, getMusicFolders())) return null;
  const entry = {
    path: song.path,
    title: typeof song.title === 'string' ? song.title.slice(0, 500) : '',
    artist: typeof song.artist === 'string' ? song.artist.slice(0, 500) : '',
    url: sanitizeAudioUrl(song.path),
  };
  if (typeof song.album === 'string') entry.album = song.album.slice(0, 500);
  if (Number.isFinite(song.bitrate)) entry.bitrate = song.bitrate;
  if (Number.isFinite(song.sampleRate)) entry.sampleRate = song.sampleRate;
  if (Number.isFinite(song.bitsPerSample)) entry.bitsPerSample = song.bitsPerSample;
  if (typeof song.codec === 'string') entry.codec = song.codec.slice(0, 64);
  return entry;
}

function addSongToPlaylist(id, song) {
  if (typeof id !== 'string') return { ok: false, duplicate: false, playlist: null };
  const playlists = loadPlaylists();
  const pl = playlists.find((p) => p.id === id);
  const entry = sanitizePlaylistSong(song);
  if (!pl || !entry) return { ok: false, duplicate: false, playlist: pl || null };
  if (pl.songs.some((s) => s.path === entry.path)) {
    return { ok: true, duplicate: true, playlist: pl };
  }
  if (pl.songs.length >= MAX_SONGS_PER_PLAYLIST) {
    return { ok: false, duplicate: false, playlist: pl };
  }
  pl.songs.push(entry);
  savePlaylists(playlists);
  return { ok: true, duplicate: false, playlist: pl };
}

function removeSongFromPlaylist(id, songPath) {
  if (typeof id !== 'string' || typeof songPath !== 'string') {
    return { ok: false, playlist: null };
  }
  const playlists = loadPlaylists();
  const pl = playlists.find((p) => p.id === id);
  if (!pl) return { ok: false, playlist: null };
  pl.songs = pl.songs.filter((s) => s.path !== songPath);
  savePlaylists(playlists);
  return { ok: true, playlist: pl };
}

function reorderPlaylist(id, from, to) {
  if (typeof id !== 'string' || !Number.isInteger(from) || !Number.isInteger(to)) {
    return { ok: false, playlist: null };
  }
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
  const valid = new Set(
    Array.isArray(validPaths) ? validPaths.filter((p) => typeof p === 'string') : []
  );
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

function sameSongSnapshot(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.path === b.path &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.url === b.url &&
    a.album === b.album &&
    a.trackNo === b.trackNo &&
    a.discNo === b.discNo &&
    a.year === b.year &&
    a.duration === b.duration &&
    a.bitrate === b.bitrate &&
    a.sampleRate === b.sampleRate &&
    a.bitsPerSample === b.bitsPerSample &&
    a.codec === b.codec
  );
}

// 曲库元数据迁移后回填歌单快照:按 path 用曲库新数据替换旧歌曲对象
export function refreshPlaylistsMetadata() {
  const playlists = loadPlaylists();
  if (playlists.length === 0) return { updated: 0 };
  const freshSongs = store.get('cachedPlaylist') || [];
  if (freshSongs.length === 0) return { updated: 0 };
  const byPath = new Map(freshSongs.map((s) => [s.path, s]));
  let updated = 0;
  for (const pl of playlists) {
    const prevSongs = Array.isArray(pl.songs) ? pl.songs : [];
    let changed = false;
    const nextSongs = prevSongs.map((s) => {
      const fresh = s ? byPath.get(s.path) : null;
      if (!fresh) return s;
      if (!sameSongSnapshot(s, fresh)) changed = true;
      return fresh;
    });
    if (changed) {
      pl.songs = nextSongs;
      updated++;
    }
  }
  if (updated > 0) savePlaylists(playlists);
  return { updated };
}

export function registerPlaylistsIpc() {
  handleMainIpc('playlists:list', () => loadPlaylists());
  handleMainIpc('playlists:create', (event, name) => ({ playlist: createPlaylist(name) }));
  handleMainIpc('playlists:rename', (event, id, name) => renamePlaylist(id, name));
  handleMainIpc('playlists:delete', (event, id) => deletePlaylist(id));
  handleMainIpc('playlists:addSong', (event, id, song) => addSongToPlaylist(id, song));
  handleMainIpc('playlists:removeSong', (event, id, path) => removeSongFromPlaylist(id, path));
  handleMainIpc('playlists:reorder', (event, id, from, to) => reorderPlaylist(id, from, to));
  handleMainIpc('playlists:prune', (event, validPaths) => prunePlaylists(validPaths));
}
