// 播放队列快照：把当前播放队列写入配置，重启后恢复。
// 队列本身由 state.songs 持有；本模块只负责持久化与启动恢复时的校验。

import { state } from './state.js';

const MAX_QUEUE_LENGTH = 1000;

// 只保存展示/播放所需的最小字段；恢复时会按 path 回到曲库取最新元数据
function toQueueEntry(song) {
  if (!song || typeof song.path !== 'string' || song.path.length === 0) return null;
  return {
    path: song.path,
    title: typeof song.title === 'string' ? song.title : '',
    artist: typeof song.artist === 'string' ? song.artist : '',
    url: typeof song.url === 'string' ? song.url : '',
  };
}

export function saveQueueSnapshot(songs) {
  const entries = (Array.isArray(songs) ? songs : [])
    .map(toQueueEntry)
    .filter(Boolean)
    .slice(0, MAX_QUEUE_LENGTH);
  try {
    window.dreamApi.savePlayQueue(entries);
  } catch (error) {
    // 持久化失败不影响本次播放
  }
}

// 启动恢复：以曲库元数据为准，曲库里已不存在的歌直接丢弃。
// 曲库为空（尚未配置文件夹）时无法校验，返回空数组走默认曲库队列。
export async function loadQueueSnapshot() {
  let saved = [];
  try {
    saved = await window.dreamApi.getPlayQueue();
  } catch (error) {
    saved = [];
  }
  if (!Array.isArray(saved) || state.librarySongs.length === 0) return [];

  const byPath = new Map(state.librarySongs.map((song) => [song.path, song]));
  return saved.map((item) => byPath.get(item && item.path)).filter(Boolean);
}
