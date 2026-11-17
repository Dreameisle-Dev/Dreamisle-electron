// 增强型 LRC 逐字时间戳解析与进度计算（纯函数，无 Electron / DOM 依赖）。

const WORD_TIME_GLOBAL_RE = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;
const WORD_TIME_TEST_RE = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/;
const DEFAULT_LAST_WORD_MIN_MS = 400;
const DEFAULT_LAST_WORD_CHAR_MS = 240;
const DEFAULT_LAST_WORD_MAX_MS = 2200;

export function hasWordTimestamps(rawText) {
  return typeof rawText === 'string' && WORD_TIME_TEST_RE.test(rawText);
}

export function stripWordTimestamps(rawText) {
  if (typeof rawText !== 'string') return '';
  return rawText.replace(WORD_TIME_GLOBAL_RE, '');
}

function parseTagMs(match) {
  const min = parseInt(match[1], 10);
  const sec = parseInt(match[2], 10);
  const ms = parseInt((match[3] || '0').padEnd(3, '0').slice(0, 3), 10);
  return min * 60 * 1000 + sec * 1000 + ms;
}

/**
 * 从包含 <mm:ss.xxx> 标记的单行原文提取逐字时间片段。
 * 保留词间空格以维持原始拼接文本（words.map(w => w.text).join('') === text）。
 */
export function parseEnhancedWords(rawText, lineStartTimeMs) {
  if (typeof rawText !== 'string' || !hasWordTimestamps(rawText)) {
    return { text: typeof rawText === 'string' ? rawText.trim() : '', words: undefined };
  }

  const baseTime = Number.isFinite(lineStartTimeMs) ? Math.max(0, lineStartTimeMs) : 0;
  const regex = new RegExp(WORD_TIME_GLOBAL_RE.source, 'g');
  const rawTokens = [];
  let lastIndex = 0;
  let currentTime = baseTime;
  let trailingEndTime = null;
  let match;

  while ((match = regex.exec(rawText)) !== null) {
    const chunk = rawText.slice(lastIndex, match.index);
    const tagTime = Math.max(currentTime, parseTagMs(match));
    if (chunk.length > 0) {
      rawTokens.push({
        time: currentTime,
        endTime: tagTime,
        text: chunk,
      });
    } else if (rawTokens.length > 0 && rawTokens[rawTokens.length - 1].endTime === null) {
      rawTokens[rawTokens.length - 1].endTime = tagTime;
    }
    currentTime = tagTime;
    lastIndex = match.index + match[0].length;
  }

  const tail = rawText.slice(lastIndex);
  if (tail.length > 0) {
    rawTokens.push({
      time: currentTime,
      endTime: null,
      text: tail,
    });
  } else if (rawTokens.length > 0) {
    trailingEndTime = currentTime;
  }

  // 去掉整行首尾多余空白，把纯空白中间片段合并到前一词，再丢弃残余空片段
  if (rawTokens.length > 0) {
    rawTokens[0].text = rawTokens[0].text.replace(/^\s+/, '');
    rawTokens[rawTokens.length - 1].text = rawTokens[rawTokens.length - 1].text.replace(/\s+$/, '');
  }
  const words = [];
  for (const token of rawTokens) {
    if (token.text.length === 0) continue;
    if (/^\s+$/.test(token.text) && words.length > 0) {
      const prev = words[words.length - 1];
      prev.text += token.text;
      if (token.endTime !== null) prev.endTime = token.endTime;
      continue;
    }
    words.push(token);
  }
  if (words.length === 0) {
    return { text: '', words: undefined };
  }

  if (trailingEndTime !== null && words[words.length - 1].endTime === null) {
    words[words.length - 1].endTime = Math.max(words[words.length - 1].time, trailingEndTime);
  }

  // 相邻片段补全 endTime，保证单调不减
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].endTime === null) {
      words[i].endTime = Math.max(words[i].time, words[i + 1].time);
    } else {
      words[i].endTime = Math.max(words[i].time, words[i].endTime);
    }
  }

  const plainText = words
    .map((w) => w.text)
    .join('')
    .trim();
  return { text: plainText, words };
}

export function shiftWords(words, deltaMs) {
  if (!Array.isArray(words) || words.length === 0) return undefined;
  const delta = Number(deltaMs) || 0;
  return words.map((w) => ({
    time: Math.max(0, w.time + delta),
    endTime: w.endTime === null || w.endTime === undefined ? null : Math.max(0, w.endTime + delta),
    text: w.text,
  }));
}

/**
 * 行内双语拆分后按原文长度截断词片段，保证拼接后与 original 完全一致。
 */
export function sliceWordsByLength(words, targetLength) {
  if (!Array.isArray(words) || words.length === 0 || targetLength <= 0) return undefined;
  const out = [];
  let remaining = targetLength;
  for (const word of words) {
    if (remaining <= 0) break;
    if (word.text.length <= remaining) {
      out.push({ ...word });
      remaining -= word.text.length;
    } else {
      const clipped = word.text.slice(0, remaining).replace(/\s+$/, '');
      if (clipped.length > 0) {
        out.push({ ...word, text: clipped });
      }
      remaining = 0;
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 排序与双语合并完成后，为缺少行尾结束时间戳的最后一个词补齐合理的 endTime。
 */
export function finalizeWordsTimeline(lines) {
  if (!Array.isArray(lines)) return lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!Array.isArray(line.words) || line.words.length === 0) continue;

    const last = line.words[line.words.length - 1];
    if (last.endTime === null || last.endTime === undefined || last.endTime < last.time) {
      const nextLine = lines[i + 1];
      const estimatedDuration = Math.min(
        DEFAULT_LAST_WORD_MAX_MS,
        Math.max(DEFAULT_LAST_WORD_MIN_MS, last.text.trim().length * DEFAULT_LAST_WORD_CHAR_MS)
      );
      if (nextLine && Number.isFinite(nextLine.time) && nextLine.time > last.time) {
        last.endTime = Math.min(nextLine.time, last.time + estimatedDuration);
      } else {
        last.endTime = last.time + estimatedDuration;
      }
    }

    // 规范化所有词时间，确保输出全部为有限整数毫秒
    for (const word of line.words) {
      word.time = Math.max(0, Math.round(word.time));
      word.endTime = Math.max(word.time, Math.round(word.endTime));
    }
  }
  return lines;
}

export function computeWordProgress(word, timeMs) {
  if (!word) return 0;
  if (timeMs <= word.time) return 0;
  if (timeMs >= word.endTime) return 1;
  const span = word.endTime - word.time;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (timeMs - word.time) / span));
}
