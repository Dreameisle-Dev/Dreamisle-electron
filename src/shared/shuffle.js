// 随机播放引擎：无重复洗牌袋（Fisher–Yates）+ 同歌手防扎堆 + 可回溯播放历史 + 队列编辑同步。
// 纯函数/状态机模块，零 DOM/Electron 依赖，供 playback.js 与 playlist.js 共用。

const DEFAULT_MAX_HISTORY = 200;

function normalizeArtist(artist) {
  if (typeof artist !== 'string') return '';
  const trimmed = artist.trim().toLowerCase();
  return !trimmed || trimmed === 'unknown' ? '' : trimmed;
}

function getSongKey(song) {
  return song && typeof song.path === 'string' ? song.path : '';
}

function conflictsWith(song, prevPath, prevArtist) {
  if (!song) return false;
  const path = getSongKey(song);
  if (prevPath && path && path === prevPath) return true;
  const artist = normalizeArtist(song.artist);
  if (prevArtist && artist && artist === prevArtist) return true;
  return false;
}

function conflictsPair(a, b) {
  if (!a || !b) return false;
  const pa = getSongKey(a);
  const pb = getSongKey(b);
  if (pa && pb && pa === pb) return true;
  const aa = normalizeArtist(a.artist);
  const ab = normalizeArtist(b.artist);
  return Boolean(aa && ab && aa === ab);
}

// 构造一轮洗牌后的下标序列：
// 1) Fisher–Yates 均匀打乱；
// 2) 单遍 O(N) 防扎堆微调：尽量避免相邻两首同曲或同歌手（跨轮衔接处同样避让上一轮末首）。
export function buildShuffledCycle(
  songs,
  { excludeIndex = -1, avoidPath = '', avoidArtist = '', rng = Math.random } = {}
) {
  const n = Array.isArray(songs) ? songs.length : 0;
  if (n === 0) return [];

  const bag = [];
  for (let i = 0; i < n; i++) {
    if (i !== excludeIndex) bag.push(i);
  }
  if (bag.length <= 1) return bag;

  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }

  const initialAvoidPath = typeof avoidPath === 'string' ? avoidPath : '';
  const initialAvoidArtist = normalizeArtist(avoidArtist);
  let prevPath = initialAvoidPath;
  let prevArtist = initialAvoidArtist;

  for (let i = 0; i < bag.length; i++) {
    if (conflictsWith(songs[bag[i]], prevPath, prevArtist)) {
      let pick = -1;
      for (let j = i + 1; j < bag.length; j++) {
        const cand = songs[bag[j]];
        if (conflictsWith(cand, prevPath, prevArtist)) continue;
        // 优先挑一个放回 j 处也不会与 j 邻居撞车的候选，退而求其次挑首个不冲突的
        const swapCreatesConflict =
          (j > i + 1 && conflictsPair(songs[bag[i]], songs[bag[j - 1]])) ||
          (j + 1 < bag.length && conflictsPair(songs[bag[i]], songs[bag[j + 1]]));
        if (!swapCreatesConflict) {
          pick = j;
          break;
        }
        if (pick === -1) pick = j;
      }

      if (pick !== -1) {
        [bag[i], bag[pick]] = [bag[pick], bag[i]];
      } else {
        // 尾部残留同歌手（后方已无其他歌手可换）：回插到前方不与左右邻居冲突的空隙
        const itemSong = songs[bag[i]];
        const removalSafe =
          i === bag.length - 1 || !conflictsPair(songs[bag[i - 1]], songs[bag[i + 1]]);
        let relocated = false;
        if (removalSafe) {
          for (let k = 0; k < i; k++) {
            const leftConflict =
              k === 0
                ? conflictsWith(itemSong, initialAvoidPath, initialAvoidArtist)
                : conflictsPair(songs[bag[k - 1]], itemSong);
            if (leftConflict || conflictsPair(itemSong, songs[bag[k]])) continue;
            const [item] = bag.splice(i, 1);
            bag.splice(k, 0, item);
            relocated = true;
            break;
          }
        }

        // 若单歌手占比过高无法避开同歌手，至少保证跨轮/相邻不连播同一首
        if (!relocated && prevPath) {
          for (let j = i + 1; j < bag.length; j++) {
            if (getSongKey(songs[bag[j]]) !== prevPath) {
              [bag[i], bag[j]] = [bag[j], bag[i]];
              break;
            }
          }
        }
      }
    }

    const chosen = songs[bag[i]];
    prevPath = getSongKey(chosen);
    prevArtist = normalizeArtist(chosen?.artist);
  }

  return bag;
}

// 列表「随机排序」按钮使用：返回新的歌曲数组（防同歌手扎堆，且 >=2 首时尽量避免与原序完全重合）
export function buildShuffledSongs(songs, { rng = Math.random } = {}) {
  if (!Array.isArray(songs) || songs.length <= 1) return Array.isArray(songs) ? [...songs] : [];
  let indices = buildShuffledCycle(songs, { rng });
  if (songs.length >= 2 && indices.every((idx, pos) => idx === pos)) {
    // 极小列表（如 2 首）偶然抽到原序时轮转一位，保证点击「随机」必有可见变化
    indices = [...indices.slice(1), indices[0]];
  }
  return indices.map((i) => songs[i]);
}

function remapIndexOnMove(idx, from, to) {
  if (idx === from) return to;
  let next = idx;
  if (from < next) next -= 1;
  if (to <= next) next += 1;
  return next;
}

export function createShuffleSession({ rng = Math.random, maxHistory = DEFAULT_MAX_HISTORY } = {}) {
  // order[0..cursor] = 已播历史（含当前在播 order[cursor]）；order[cursor+1..] = 本轮待播洗牌袋
  let order = [];
  let cursor = -1;
  let queueLength = 0;

  function reset() {
    order = [];
    cursor = -1;
    queueLength = 0;
  }

  function trimHistory() {
    if (cursor > maxHistory) {
      const excess = cursor - maxHistory;
      order.splice(0, excess);
      cursor -= excess;
    }
  }

  function isValidFor(songs) {
    if (!Array.isArray(songs) || songs.length === 0) return false;
    if (order.length === 0 || cursor < 0 || cursor >= order.length) return false;
    if (queueLength !== songs.length) return false;
    return true;
  }

  function initAnchored(songs, anchorIndex) {
    const n = songs.length;
    queueLength = n;
    if (n === 0) {
      reset();
      return;
    }

    if (anchorIndex >= 0 && anchorIndex < n) {
      const currentSong = songs[anchorIndex];
      const rest = buildShuffledCycle(songs, {
        excludeIndex: anchorIndex,
        avoidPath: getSongKey(currentSong),
        avoidArtist: currentSong?.artist,
        rng,
      });
      order = [anchorIndex, ...rest];
      cursor = 0;
    } else {
      order = buildShuffledCycle(songs, { rng });
      cursor = -1;
    }
  }

  // 同步当前播放下标：手动点歌或切歌时保留历史、把所选曲置为当前并从本轮待播中移除，避免短时重复
  function syncCurrent(songs, currentIndex) {
    if (!Array.isArray(songs) || songs.length === 0) {
      reset();
      return;
    }
    if (!isValidFor(songs)) {
      initAnchored(songs, currentIndex);
      return;
    }
    if (currentIndex < 0 || currentIndex >= songs.length) return;
    if (order[cursor] === currentIndex) return;

    const history = order.slice(0, cursor + 1);
    const upcoming = order.slice(cursor + 1).filter((idx) => idx !== currentIndex);
    order = [...history, currentIndex, ...upcoming];
    cursor = history.length;
    trimHistory();
  }

  function next(songs, currentIndex) {
    if (!Array.isArray(songs) || songs.length === 0) {
      reset();
      return -1;
    }
    if (songs.length === 1) {
      order = [0];
      cursor = 0;
      queueLength = 1;
      return 0;
    }

    if (!isValidFor(songs)) {
      initAnchored(songs, currentIndex);
    } else if (currentIndex >= 0 && currentIndex < songs.length && order[cursor] !== currentIndex) {
      syncCurrent(songs, currentIndex);
    }

    if (cursor + 1 < order.length) {
      cursor += 1;
      trimHistory();
      return order[cursor];
    }

    // 当前洗牌袋全部播完：开启全新一轮（避让刚播完的最后一首与同歌手），同时保留历史供「上一首」回退
    const lastIdx = cursor >= 0 ? order[cursor] : currentIndex;
    const lastSong = lastIdx >= 0 && lastIdx < songs.length ? songs[lastIdx] : null;
    const nextCycle = buildShuffledCycle(songs, {
      avoidPath: getSongKey(lastSong),
      avoidArtist: lastSong?.artist,
      rng,
    });
    // 2 首队列的极端兜底：避免同路径或同下标紧挨重复
    if (nextCycle.length >= 2 && nextCycle[0] === lastIdx) {
      [nextCycle[0], nextCycle[1]] = [nextCycle[1], nextCycle[0]];
    }

    const keepFrom = Math.max(0, order.length - maxHistory);
    order = [...order.slice(keepFrom), ...nextCycle];
    cursor = order.length - nextCycle.length;
    trimHistory();
    return order[cursor];
  }

  function prev(songs, currentIndex) {
    if (!Array.isArray(songs) || songs.length === 0) {
      reset();
      return -1;
    }
    if (songs.length === 1) {
      order = [0];
      cursor = 0;
      queueLength = 1;
      return 0;
    }

    if (!isValidFor(songs)) {
      initAnchored(songs, currentIndex);
    } else if (currentIndex >= 0 && currentIndex < songs.length && order[cursor] !== currentIndex) {
      syncCurrent(songs, currentIndex);
    }

    if (cursor > 0) {
      cursor -= 1;
      return order[cursor];
    }

    // 处于洗牌起点（尚无历史）按上一首：把本轮尾曲旋到最前，使再按「下一首」可原路回到刚才那首
    if (order.length > 1) {
      const tail = order.pop();
      order.unshift(tail);
      cursor = 0;
      return order[0];
    }

    return order[0] ?? 0;
  }

  function isNext(targetIndex) {
    return (
      order.length > 0 &&
      cursor >= 0 &&
      cursor + 1 < order.length &&
      order[cursor + 1] === targetIndex
    );
  }

  function pinNext(songs, currentIndex, targetIndex) {
    if (!Array.isArray(songs) || targetIndex < 0 || targetIndex >= songs.length) return;
    if (!isValidFor(songs)) {
      initAnchored(songs, currentIndex);
    } else if (currentIndex >= 0 && currentIndex < songs.length && order[cursor] !== currentIndex) {
      syncCurrent(songs, currentIndex);
    }
    if (cursor < 0) return;

    const history = order.slice(0, cursor + 1);
    const upcoming = order.slice(cursor + 1).filter((idx) => idx !== targetIndex);
    order = [...history, targetIndex, ...upcoming];
  }

  function onQueueReorder(from, to) {
    if (order.length === 0) return;
    for (let i = 0; i < order.length; i++) {
      order[i] = remapIndexOnMove(order[i], from, to);
    }
  }

  function onQueueMoveToNext(songs, currentIndex, from, to) {
    if (order.length > 0 && queueLength === songs.length) {
      for (let i = 0; i < order.length; i++) {
        order[i] = remapIndexOnMove(order[i], from, to);
      }
      pinNext(songs, currentIndex, to);
    } else {
      initAnchored(songs, currentIndex);
      pinNext(songs, currentIndex, to);
    }
  }

  function onQueueInsert(songs, currentIndex, insertAt, { playNext = false } = {}) {
    if (order.length === 0 || queueLength !== songs.length - 1) {
      initAnchored(songs, currentIndex);
      if (playNext) pinNext(songs, currentIndex, insertAt);
      return;
    }

    for (let i = 0; i < order.length; i++) {
      if (order[i] >= insertAt) order[i] += 1;
    }
    queueLength = songs.length;

    if (playNext && cursor >= 0) {
      order.splice(cursor + 1, 0, insertAt);
    } else if (cursor >= 0) {
      // 「添加到队列末尾」：随机插进待播洗牌袋，让新歌在本轮也有机会播到
      const upcomingLen = order.length - (cursor + 1);
      const offset = Math.floor(rng() * (upcomingLen + 1));
      order.splice(cursor + 1 + offset, 0, insertAt);
    } else {
      order.push(insertAt);
    }
  }

  function onQueueRemove(removedIndex) {
    if (order.length === 0) return;
    for (let i = order.length - 1; i >= 0; i--) {
      if (order[i] === removedIndex) {
        order.splice(i, 1);
        if (i <= cursor) cursor = Math.max(0, cursor - 1);
      } else if (order[i] > removedIndex) {
        order[i] -= 1;
      }
    }
    queueLength = Math.max(0, queueLength - 1);

    // 移除中间历史项后若产生连续重复，合并相邻重复避免「上一首」连播同一曲
    for (let i = order.length - 1; i > 0; i--) {
      if (order[i] === order[i - 1]) {
        order.splice(i, 1);
        if (i <= cursor) cursor = Math.max(0, cursor - 1);
      }
    }
    if (order.length === 0) cursor = -1;
  }

  // 只读预览随机模式下的相邻待播与上一首下标（供封面预加载使用，不推进 cursor）
  function peekNeighbors(songs, currentIndex, { nextCount = 2, prevCount = 1 } = {}) {
    if (!Array.isArray(songs) || songs.length <= 1) return [];
    if (!isValidFor(songs)) {
      initAnchored(songs, currentIndex);
    } else if (currentIndex >= 0 && currentIndex < songs.length && order[cursor] !== currentIndex) {
      syncCurrent(songs, currentIndex);
    }
    if (cursor < 0 || order.length === 0) return [];

    const result = [];
    const seen = new Set([order[cursor]]);
    const pushIfNew = (idx) => {
      if (idx >= 0 && idx < songs.length && !seen.has(idx)) {
        seen.add(idx);
        result.push(idx);
      }
    };

    for (let step = 1; step <= nextCount; step++) {
      if (cursor + step < order.length) pushIfNew(order[cursor + step]);
    }
    for (let step = 1; step <= prevCount; step++) {
      if (cursor - step >= 0) pushIfNew(order[cursor - step]);
      else if (step === 1 && order.length > 1) pushIfNew(order[order.length - 1]);
    }
    return result;
  }

  function getSnapshot() {
    return { order: [...order], cursor, queueLength };
  }

  return {
    reset,
    syncCurrent,
    next,
    prev,
    isNext,
    pinNext,
    peekNeighbors,
    onQueueReorder,
    onQueueMoveToNext,
    onQueueInsert,
    onQueueRemove,
    getSnapshot,
  };
}
