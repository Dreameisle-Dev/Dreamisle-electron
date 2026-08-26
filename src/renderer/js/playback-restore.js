// 解析重启后应恢复的播放索引。
// 列表排序/随机重排会改变歌曲顺序，保存时的索引会漂移，
// 因此优先按歌曲路径定位，找不到时回退到保存的索引。
export function resolveRestoredIndex(songs, savedState) {
  if (!savedState) return -1;

  let index = -1;
  if (savedState.currentSongPath) {
    index = songs.findIndex((s) => s.path === savedState.currentSongPath);
  }
  if (index === -1 && savedState.currentIndex >= 0 && savedState.currentIndex < songs.length) {
    index = savedState.currentIndex;
  }
  return index;
}
