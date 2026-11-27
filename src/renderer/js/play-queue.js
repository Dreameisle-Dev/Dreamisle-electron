// 播放队列快照：把当前播放队列写入配置，重启后恢复。
// 队列本身由 state.songs 持有；本模块只负责持久化与启动恢复时的校验。

import { state } from './state.js';
import { compareByInitial } from '../../shared/initial-letter.js';

const MAX_QUEUE_LENGTH = 1000;

// 只保存展示/播放所需的最小字段；本地曲恢复时按 path 回曲库取最新元数据，插件曲目保留必要快照
function toQueueEntry(song) {
  if (!song || typeof song.path !== 'string' || song.path.length === 0) return null;
  const entry = {
    path: song.path,
    title: typeof song.title === 'string' ? song.title : '',
    artist: typeof song.artist === 'string' ? song.artist : '',
    url: typeof song.url === 'string' ? song.url : '',
  };
  if (song.path.startsWith('dream-track://')) {
    entry.source = 'plugin';
    if (typeof song.pluginId === 'string') entry.pluginId = song.pluginId;
    if (typeof song.trackId === 'string') entry.trackId = song.trackId;
    if (typeof song.album === 'string') entry.album = song.album;
    if (Number.isFinite(song.duration)) entry.duration = song.duration;
    if (typeof song.artworkUrl === 'string') entry.artworkUrl = song.artworkUrl;
    if (song.pluginMeta && typeof song.pluginMeta === 'object' && !Array.isArray(song.pluginMeta)) {
      entry.pluginMeta = song.pluginMeta;
    }
  }
  return entry;
}

function isSortedByField(songs, field) {
  for (let i = 1; i < songs.length; i++) {
    if (compareByInitial(songs[i - 1][field], songs[i][field]) > 0) return false;
  }
  return true;
}

export function saveQueueSnapshot(
  songs,
  activeQueue = state.activeQueue,
  sortMode = state.sortMode
) {
  const entries = (Array.isArray(songs) ? songs : [])
    .map(toQueueEntry)
    .filter(Boolean)
    .slice(0, MAX_QUEUE_LENGTH);
  try {
    window.dreamApi.savePlayQueue({
      songs: entries,
      activeQueue,
      sortMode,
    });
  } catch (error) {
    // 持久化失败不影响本次播放
  }
}

// 将主进程返回的原始队列快照按当前曲库元数据校验归一，曲库里已不存在的歌直接丢弃。
// 曲库为空（尚未配置文件夹）时无法校验，返回空快照走默认曲库队列。
export function resolveQueueSnapshot(saved) {
  const rawSongs = Array.isArray(saved)
    ? saved
    : saved && Array.isArray(saved.songs)
      ? saved.songs
      : [];
  const hasPluginSongs = rawSongs.some(
    (item) => item && typeof item.path === 'string' && item.path.startsWith('dream-track://')
  );
  if (rawSongs.length === 0 || (state.librarySongs.length === 0 && !hasPluginSongs)) {
    return { songs: [], activeQueue: null, sortMode: null };
  }

  const byPath = new Map(state.librarySongs.map((song) => [song.path, song]));
  const pluginRestored = [];
  const songs = rawSongs
    .map((item) => {
      if (!item || typeof item.path !== 'string') return null;
      if (item.path.startsWith('dream-track://')) {
        pluginRestored.push(item);
        return item;
      }
      return byPath.get(item.path) || null;
    })
    .filter(Boolean);
  if (pluginRestored.length > 0) {
    window.dreamApi.plugins?.registerTracks(pluginRestored);
  }
  let activeQueue = !Array.isArray(saved) && saved ? saved.activeQueue || null : null;
  let sortMode = !Array.isArray(saved) && saved ? saved.sortMode || null : null;

  // 兼容旧版只存过歌单数组、未写 playQueueMeta 的配置文件：
  // 若恢复出的歌曲与完整曲库（受 1000 首快照上限截断前）一致且符合歌名/歌手排序，还原回 library + 对应排序，恢复右侧 A-Z# 索引
  if (
    !activeQueue &&
    songs.length > 0 &&
    songs.length === Math.min(state.librarySongs.length, MAX_QUEUE_LENGTH)
  ) {
    const uniquePaths = new Set(songs.map((s) => s.path));
    if (uniquePaths.size === songs.length) {
      if (isSortedByField(songs, 'title')) {
        activeQueue = { type: 'library' };
        sortMode = 'title';
      } else if (isSortedByField(songs, 'artist')) {
        activeQueue = { type: 'library' };
        sortMode = 'artist';
      }
    }
  }

  return { songs, activeQueue, sortMode };
}

export async function loadQueueSnapshot() {
  let saved = null;
  try {
    saved = await window.dreamApi.getPlayQueue();
  } catch (error) {
    saved = null;
  }
  return resolveQueueSnapshot(saved);
}
