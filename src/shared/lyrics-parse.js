// 歌词解析入口:通用解析器 + 无时间戳纯文本歌词的静态降级。
// 无 Electron 依赖,可被 node --test 直接测试。
import universalLyricParser, { formatSyncLyricsToLrc } from './universal-lyric-parser.js';
import { isCreditLine, stripCreditLines } from './lyrics-credits.js';

export function parseLyricsText(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') {
    return { metadata: {}, lines: [] };
  }
  const normalizedText = lrcText.charCodeAt(0) === 0xfeff ? lrcText.slice(1) : lrcText;

  const parsed = universalLyricParser.parse(normalizedText, { isCreditLine });
  // 只要解析出过带时间戳的行，就不再走静态降级：
  // 即使这些行全是 credits，也应该返回空歌词，而不是把带时间戳的 credits 当正文。
  if (parsed.lines.length > 0) {
    return { metadata: parsed.metadata, lines: stripCreditLines(parsed.lines) };
  }

  // 无时间戳的纯文本歌词:降级为静态行(渲染时不可点击跳转)
  const staticLines = normalizedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[.*?\]$/.test(line) && !/^\{"t":\d+,"c":\[/.test(line))
    .filter((line) => !isCreditLine(line))
    .map((text) => ({ time: 0, text, isStatic: true }));

  return { metadata: parsed.metadata, lines: staticLines };
}

// 同步歌词(music-metadata 的 syncText:毫秒时间戳数组)转为 LRC 文本后统一走解析器,
// 使内嵌同步歌词同样支持行内双语拆分与容差合并
export function parseSyncLyrics(syncText) {
  const lrcText = formatSyncLyricsToLrc(syncText);
  if (!lrcText) {
    return { metadata: {}, lines: [] };
  }
  return parseLyricsText(lrcText);
}
