// 专辑分组纯逻辑：主进程与渲染进程均可导入，不依赖 DOM 或 Node API。
// 同一专辑名按不区分大小写合并；无专辑标签的歌曲统一归入末尾的「未知专辑」组。
import { compareByInitial } from './initial-letter.js';

export const UNKNOWN_ALBUM_KEY = '__unknown__';

// 从单曲元数据推导稳定的专辑分组键
export function albumKeyOf(song) {
  const raw = song && typeof song.album === 'string' ? song.album.trim() : '';
  return raw ? raw.toLowerCase() : UNKNOWN_ALBUM_KEY;
}

function fileNameOf(filePath) {
  if (typeof filePath !== 'string') return '';
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

// 专辑内曲目排序：优先按碟号 + 音轨号，缺失时按文件名 / 歌名自然数字序，保留原碟听感
export function compareAlbumTracks(a, b) {
  const discA = Number.isFinite(a?.discNo) && a.discNo > 0 ? a.discNo : 1;
  const discB = Number.isFinite(b?.discNo) && b.discNo > 0 ? b.discNo : 1;
  if (discA !== discB) return discA - discB;

  const hasTrackA = Number.isFinite(a?.trackNo) && a.trackNo > 0;
  const hasTrackB = Number.isFinite(b?.trackNo) && b.trackNo > 0;
  if (hasTrackA && hasTrackB && a.trackNo !== b.trackNo) return a.trackNo - b.trackNo;
  if (hasTrackA !== hasTrackB) return hasTrackA ? -1 : 1;

  const fileCmp = fileNameOf(a?.path).localeCompare(fileNameOf(b?.path), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (fileCmp !== 0) return fileCmp;

  return String(a?.title || '').localeCompare(String(b?.title || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

// 归拢专辑展示歌手：多人合唱轨道（如「A / B」）取主歌手归纳，真正杂锦合辑标记 isVariousArtists
function resolveAlbumArtist(songs) {
  const exactArtists = new Set();
  const primaryCounts = new Map();

  for (const song of songs) {
    const artist = typeof song?.artist === 'string' ? song.artist.trim() : '';
    if (!artist || artist === 'Unknown') continue;
    exactArtists.add(artist);
    const primary = artist.split(/\s*[/,&、]\s*/)[0]?.trim() || artist;
    primaryCounts.set(primary, (primaryCounts.get(primary) || 0) + 1);
  }

  if (exactArtists.size === 0) return { artist: '', isVariousArtists: false };
  if (exactArtists.size === 1) return { artist: [...exactArtists][0], isVariousArtists: false };

  let topArtist = '';
  let topCount = 0;
  for (const [name, count] of primaryCounts) {
    if (count > topCount) {
      topArtist = name;
      topCount = count;
    }
  }

  if (topCount >= Math.ceil(songs.length * 0.55)) {
    return { artist: topArtist, isVariousArtists: false };
  }
  return { artist: '', isVariousArtists: true };
}

function resolveAlbumYear(songs) {
  for (const song of songs) {
    if (Number.isFinite(song?.year) && song.year > 1900 && song.year < 2200) {
      return song.year;
    }
  }
  return null;
}

// 将曲库按专辑分组：常规专辑按首字母（拼音/英文）排序，「未知专辑」固定置底
export function groupSongsByAlbum(songs) {
  const list = Array.isArray(songs) ? songs : [];
  const buckets = new Map();

  for (const song of list) {
    if (!song || typeof song.path !== 'string') continue;
    const key = albumKeyOf(song);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        name: key === UNKNOWN_ALBUM_KEY ? '' : song.album.trim(),
        isUnknown: key === UNKNOWN_ALBUM_KEY,
        songs: [],
      };
      buckets.set(key, bucket);
    }
    bucket.songs.push(song);
  }

  const albums = [];
  for (const bucket of buckets.values()) {
    const orderedSongs = [...bucket.songs].sort(compareAlbumTracks);
    const { artist, isVariousArtists } = resolveAlbumArtist(orderedSongs);
    albums.push({
      key: bucket.key,
      name: bucket.name,
      isUnknown: bucket.isUnknown,
      artist,
      isVariousArtists,
      year: resolveAlbumYear(orderedSongs),
      songs: orderedSongs,
    });
  }

  albums.sort((a, b) => {
    if (a.isUnknown !== b.isUnknown) return a.isUnknown ? 1 : -1;
    return compareByInitial(a.name, b.name);
  });

  return albums;
}

// 获取指定专辑键下的有序曲目列表（用于重启恢复与曲库同步刷新）
export function albumSongsOf(songs, albumKey) {
  if (typeof albumKey !== 'string' || !albumKey) return [];
  const matched = (Array.isArray(songs) ? songs : []).filter(
    (song) => song && albumKeyOf(song) === albumKey
  );
  return matched.sort(compareAlbumTracks);
}
