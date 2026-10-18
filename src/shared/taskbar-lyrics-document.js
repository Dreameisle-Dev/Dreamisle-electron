// 任务栏歌词文档：主窗口渲染进程 → 主进程 → 任务栏窗的稳定数据形状。
// 纯数据转换，无 Electron/DOM 依赖，可用 node --test 直接测试。

/**
 * Build the lyric document forwarded to the taskbar strip.
 * `isStatic` describes the whole document: the first parsed line marks
 * untimed plain-text lyrics, which have no current-line tracking.
 */
export function buildLyricDocument(song, lines) {
  const list = Array.isArray(lines) ? lines : [];
  return {
    songPath: song?.path ?? null,
    title: song?.title || '',
    artist: song?.artist || '',
    isStatic: !!list[0]?.isStatic,
    lines: list.map((line) => ({
      time: Number(line.time) || 0,
      text: line.text || '',
      translation: line.translation || '',
    })),
  };
}

/**
 * Build the playback snapshot forwarded to the taskbar strip.
 * Times are integer milliseconds; `rate` defaults to normal speed so the
 * strip's local clock has a usable value even before the audio element reports.
 */
export function buildPlaybackState(song, { currentTimeSec = 0, playing = false, rate = 1 } = {}) {
  return {
    songPath: song?.path ?? null,
    currentTimeMs: Math.round((Number(currentTimeSec) || 0) * 1000),
    playing: !!playing,
    rate: Number(rate) || 1,
  };
}
