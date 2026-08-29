// 歌词解析入口:通用解析器 + 无时间戳纯文本歌词的静态降级。
// 无 Electron 依赖,可被 node --test 直接测试。
import universalLyricParser from './universal-lyric-parser.js';

export function parseLyricsText(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') {
    return { metadata: {}, lines: [] };
  }

  const parsed = universalLyricParser.parse(lrcText);
  if (parsed.lines.length > 0) return parsed;

  // 无时间戳的纯文本歌词:降级为静态行(渲染时不可点击跳转)
  const staticLines = lrcText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[.*?\]$/.test(line))
    .map((text) => ({ time: 0, text, isStatic: true }));

  return { metadata: parsed.metadata, lines: staticLines };
}

// 同步歌词(music-metadata 的 syncText:毫秒时间戳数组)转为 LRC 文本后统一走解析器,
// 使内嵌同步歌词同样支持行内双语拆分与容差合并
export function parseSyncLyrics(syncText) {
  if (!Array.isArray(syncText) || syncText.length === 0) {
    return { metadata: {}, lines: [] };
  }

  const lrcText = syncText
    .map((item) => {
      const ms = Math.max(0, Number(item.timestamp) || 0);
      const min = Math.floor(ms / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      const rest = Math.round(ms % 1000);
      return `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(rest).padStart(3, '0')}]${item.text || ''}`;
    })
    .join('\n');

  return parseLyricsText(lrcText);
}
