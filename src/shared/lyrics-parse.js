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

// 明确分离的「原文 LRC + 译文 tlyric」（常见于在线插件返回的独立轨道）：
// 分别解析后再按时间戳精确优先、容差次之（±350ms）一对一挂载译文，
// 避免合并成单文本时因原文以冒号结尾（如 `adventure：`）或译文时间戳微偏被误拆成独立主行。
export function parseBilingualLyrics(lrcText, tlyricText) {
  const primary = parseLyricsText(lrcText);
  if (!tlyricText || typeof tlyricText !== 'string' || !tlyricText.trim()) {
    return primary;
  }
  if (primary.lines.length === 0 || primary.lines[0]?.isStatic) {
    return primary;
  }

  const transParsed = parseLyricsText(tlyricText);
  const transEntries = transParsed.lines.filter(
    (item) => !item.isStatic && item.text && item.text.trim() && item.text.trim() !== '//'
  );
  if (transEntries.length === 0) return primary;

  const lines = primary.lines.map((line) => ({ ...line }));
  const usedTrans = new Uint8Array(transEntries.length);

  // 第一轮：精确时间戳匹配
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].translation) continue;
    const tIdx = transEntries.findIndex((tr, idx) => !usedTrans[idx] && tr.time === lines[i].time);
    if (tIdx >= 0) {
      usedTrans[tIdx] = 1;
      if (transEntries[tIdx].text !== lines[i].text) {
        lines[i].translation = transEntries[tIdx].text;
      }
    }
  }

  // 第二轮：±350ms 容差内最近未配对译文匹配
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].translation) continue;
    let bestIdx = -1;
    let bestDiff = 351;
    for (let j = 0; j < transEntries.length; j++) {
      if (usedTrans[j]) continue;
      const diff = Math.abs(transEntries[j].time - lines[i].time);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      usedTrans[bestIdx] = 1;
      if (transEntries[bestIdx].text !== lines[i].text) {
        lines[i].translation = transEntries[bestIdx].text;
      }
    }
  }

  return { metadata: primary.metadata, lines };
}
