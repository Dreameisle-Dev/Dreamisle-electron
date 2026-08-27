// stats 结构:{ plays: { [path]: { full, loop } }, firstPlayDate: timestamp | null }

export function emptyStats() {
  return { plays: {}, firstPlayDate: null };
}

// 记录一次播放:kind 为 'full'(完整播放)或 'loop'(单曲循环重播)。返回新对象,不修改入参。
export function recordPlay(stats, path, kind, now) {
  const prev = stats.plays[path] || { full: 0, loop: 0 };
  const plays = { ...stats.plays, [path]: { ...prev, [kind]: prev[kind] + 1 } };
  return { plays, firstPlayDate: stats.firstPlayDate ?? now };
}

// 清理已不在音乐库中的歌曲记录
export function pruneStats(stats, validPaths) {
  const plays = {};
  for (const [path, entry] of Object.entries(stats.plays)) {
    if (validPaths.has(path)) plays[path] = entry;
  }
  return { plays, firstPlayDate: stats.firstPlayDate };
}

// 按完整播放次数降序的排行,仅包含有计数的歌曲。
// 单曲循环重播同样伴随一次完整播放(full),loop 只是分类信息,不叠加进 total,避免双重计数。
export function buildRanking(stats) {
  return Object.entries(stats.plays)
    .map(([path, { full, loop }]) => ({ path, full, loop, total: full }))
    .sort((a, b) => b.total - a.total);
}

export function totalPlays(stats) {
  return Object.values(stats.plays).reduce((sum, e) => sum + e.full, 0);
}

const DAY_MS = 86_400_000;

// 日均播放:自首次记录起的天数(不足一天按 1 天计),保留 1 位小数
export function dailyAverage(stats, now) {
  if (!stats.firstPlayDate) return 0;
  const days = Math.max(1, Math.ceil((now - stats.firstPlayDate) / DAY_MS));
  return Math.round((totalPlays(stats) / days) * 10) / 10;
}
