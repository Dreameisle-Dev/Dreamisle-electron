// 歌曲元数据补全:歌单快照与曲库缓存之间的按 path 回填/回查

// 按 path 用曲库新数据整对象替换歌单旧快照;曲库中已不存在的歌曲保持原样
export function mergeSongsByPath(playlistSongs, freshSongs) {
  const byPath = new Map(freshSongs.map((s) => [s.path, s]));
  return (playlistSongs || []).map((s) => byPath.get(s.path) || s);
}

// 歌曲对象缺新字段(album 为 undefined,旧缓存快照)时按 path 回查曲库补全
export function resolveSongMeta(song, metaByPath) {
  if (!song || song.album !== undefined) return song;
  return metaByPath.get(song.path) || song;
}
