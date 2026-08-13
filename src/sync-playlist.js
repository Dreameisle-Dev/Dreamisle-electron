// 对比缓存路径与磁盘路径，得到新增与消失的文件
export function diffPlaylistPaths(cachedPaths, diskPaths) {
  const cachedSet = new Set(cachedPaths);
  const diskSet = new Set(diskPaths);
  return {
    added: diskPaths.filter((p) => !cachedSet.has(p)),
    removed: cachedPaths.filter((p) => !diskSet.has(p)),
  };
}

// 将同步结果应用到缓存列表：移除消失的歌曲，末尾追加新歌曲
export function applySyncToPlaylist(cachedPlaylist, addedEntries, removedPaths) {
  const removed = new Set(removedPaths);
  return cachedPlaylist.filter((s) => !removed.has(s.path)).concat(addedEntries);
}
