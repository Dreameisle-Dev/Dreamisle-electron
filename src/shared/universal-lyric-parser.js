// 通用 LRC 歌词解析器(ESM 化版本,解析逻辑与 universal-lyric-parser.js 一致)
class universalLyricParser {
  static TIME_REGEX = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  // 逐字（增强型）LRC 的词级时间戳 <mm:ss.xxx>。它跟在每个字/词前面，
  // 不属于歌词文本，必须在取文本时剥掉 —— 否则会原样显示在歌词里。
  static WORD_TIME_REGEX = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g;
  static META_TAG_REGEX = /^\[(ti|ar|al|by|offset):(.*)\]$/i;
  static META_TEXT_REGEX =
    /^(作词|作曲|编曲|制作|混音|吉他|贝斯|鼓|键盘|录音|母带|和声|监制|企划|发行|Lyricist|Composer|Arranger|Producer|Vocals|Mixed|Mastered)\s*[:：]/i;
  static BRACKET_REGEX = /^(.+?)\s*[（\(\[\{【]([\p{L}\p{N}\s\p{P}]+?)[）\)\]\}】]$/u;
  // 汉字 / 假名 / 谚文：用来判断括号内外是不是「换了文字体系」
  static HAN_KANA_HANGUL_REGEX = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
  static WEST_TO_EAST_REGEX =
    /^([\p{sc=Latin}\p{sc=Cyrillic}\p{sc=Greek}\p{N}\p{P}\s]+?)\s+([\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}].+)$/u;
  static EAST_TO_WEST_REGEX =
    /^([\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{N}\p{P}\s]+?)\s+([\p{sc=Latin}\p{sc=Cyrillic}].+)$/u;
  static KOREAN_JAPANESE_TO_HAN_REGEX =
    /^([\p{sc=Hangul}\p{sc=Hiragana}\p{sc=Katakana}\p{N}\p{P}\s]+?)\s+([\p{sc=Han}].+)$/u;
  static OTHER_SCRIPTS_REGEX =
    /^([\p{sc=Arabic}\p{sc=Thai}\p{sc=Devanagari}\p{sc=Hebrew}\p{N}\p{P}\s]+?)\s+([\p{sc=Latin}\p{sc=Han}].+)$/u;
  static WEST_TO_OTHER_SCRIPTS_REGEX =
    /^([\p{sc=Latin}\p{sc=Han}\p{N}\p{P}\s]+?)\s+([\p{sc=Arabic}\p{sc=Thai}\p{sc=Devanagari}\p{sc=Hebrew}].+)$/u;

  /** 解析 LRC 文本 → { metadata, lines }。timeToleranceMs 是模糊时间戳容差（毫秒）。 */
  static parse(lrcContent, timeToleranceMs = 50) {
    if (!lrcContent || typeof lrcContent !== 'string') {
      return { metadata: {}, lines: [] };
    }

    const rawLines = lrcContent.split(/\r?\n/);
    const metadata = {};
    const rawTimedEntries = [];

    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const metaMatch = trimmed.match(this.META_TAG_REGEX);
      if (metaMatch) {
        const key = metaMatch[1].toLowerCase();
        const val = metaMatch[2].trim();
        if (key === 'ti') metadata.title = val;
        else if (key === 'ar') metadata.artist = val;
        else if (key === 'al') metadata.album = val;
        else if (key === 'by') metadata.by = val;
        else if (key === 'offset') metadata.offset = parseInt(val, 10) || 0;
        continue;
      }

      const matches = [...trimmed.matchAll(this.TIME_REGEX)];
      if (matches.length === 0) continue;

      const text = trimmed
        .replace(this.TIME_REGEX, '')
        .replace(this.WORD_TIME_REGEX, '')
        .trim();

      for (const match of matches) {
        const min = parseInt(match[1], 10);
        const sec = parseInt(match[2], 10);
        const msRaw = match[3] || '0';
        const ms = parseInt(msRaw.padEnd(3, '0').slice(0, 3), 10);
        const time = min * 60 * 1000 + sec * 1000 + ms;

        rawTimedEntries.push({ time, text });
      }
    }

    if (metadata.offset) {
      for (const entry of rawTimedEntries) {
        entry.time = Math.max(0, entry.time + metadata.offset);
      }
    }

    const enableSpaceSplit = this._checkGlobalInlineSpaceFeature(
      rawTimedEntries.map((e) => e.text)
    );
    rawTimedEntries.sort((a, b) => a.time - b.time);

    const result = [];

    for (const entry of rawTimedEntries) {
      const { time, text } = entry;

      if (text === '//') {
        continue;
      }

      const splitResult = this._splitInline(text, enableSpaceSplit);
      const currentItem = {
        time,
        text: splitResult.original,
        translation: splitResult.translation,
      };

      const existingIndex = result.findIndex((r) => Math.abs(r.time - time) <= timeToleranceMs);

      if (existingIndex !== -1) {
        const existing = result[existingIndex];

        if (!existing.text && currentItem.text) {
          result[existingIndex] = currentItem;
          continue;
        }

        if (existing.text && !currentItem.text) {
          continue;
        }

        // 分段式双语合并
        if (
          existing.text &&
          !existing.translation &&
          currentItem.text &&
          !currentItem.translation
        ) {
          if (existing.text !== currentItem.text) {
            existing.translation = currentItem.text;
          }
          continue;
        }
      }

      result.push(currentItem);
    }

    const finalLines = result.filter(
      (line) => line.text.length > 0 || (line.translation && line.translation.length > 0)
    );

    return {
      metadata,
      lines: finalLines,
    };
  }

  /** 全曲预检：文本是否符合任一已知的语种跳变模型 */
  static _checkGlobalInlineSpaceFeature(texts) {
    let validLines = 0;
    let matchedLines = 0;

    for (const text of texts) {
      if (!text || text === '//' || this.META_TEXT_REGEX.test(text)) continue;
      validLines++;

      if (
        this.BRACKET_REGEX.test(text) ||
        this.WEST_TO_EAST_REGEX.test(text) ||
        this.EAST_TO_WEST_REGEX.test(text) ||
        this.KOREAN_JAPANESE_TO_HAN_REGEX.test(text) ||
        this.OTHER_SCRIPTS_REGEX.test(text) ||
        this.WEST_TO_OTHER_SCRIPTS_REGEX.test(text)
      ) {
        matchedLines++;
      }
    }

    return validLines > 0 && matchedLines / validLines >= 0.3;
  }

  /** 单行拆分调度器 */
  static _splitInline(text, enableSpaceSplit) {
    if (!text) return { original: '' };

    if (this.META_TEXT_REGEX.test(text)) {
      return { original: text };
    }

    if (text.includes(' ')) {
      const parts = text.split(' ');
      return {
        original: parts[0].trim(),
        translation: parts.slice(1).join(' ').trim() || undefined,
      };
    }
    if (text.includes('\t')) {
      const parts = text.split('\t');
      return {
        original: parts[0].trim(),
        translation: parts.slice(1).join(' ').trim() || undefined,
      };
    }

    if (text.includes(' | ')) {
      const parts = text.split(' | ');
      return {
        original: parts[0].trim(),
        translation: parts.slice(1).join(' ').trim() || undefined,
      };
    }

    const bracketMatch = text.match(this.BRACKET_REGEX);
    if (bracketMatch) {
      const main = bracketMatch[1].trim();
      const inner = bracketMatch[2].trim();
      // 括号内容只有「换了文字体系」才算译文（`Believer (信徒)` 是，`爱错 (Leehom Wang)`、
      // `Something (Live)` 不是）。只按「有括号」就配对的话，纯中文歌会被判出假译文。
      if (this.HAN_KANA_HANGUL_REGEX.test(inner) && !this.HAN_KANA_HANGUL_REGEX.test(main)) {
        return { original: main, translation: inner };
      }
      return { original: text };
    }

    if (enableSpaceSplit) {
      let match = text.match(this.WEST_TO_EAST_REGEX);
      if (match) return { original: match[1].trim(), translation: match[2].trim() };

      match = text.match(this.KOREAN_JAPANESE_TO_HAN_REGEX);
      if (match) return { original: match[1].trim(), translation: match[2].trim() };

      match = text.match(this.EAST_TO_WEST_REGEX);
      if (match) return { original: match[1].trim(), translation: match[2].trim() };

      match = text.match(this.OTHER_SCRIPTS_REGEX);
      if (match) return { original: match[1].trim(), translation: match[2].trim() };

      match = text.match(this.WEST_TO_OTHER_SCRIPTS_REGEX);
      if (match) return { original: match[1].trim(), translation: match[2].trim() };
    }

    return { original: text };
  }

  /** 二分查找当前播放行，返回索引（未开始返回 -1） */
  static getCurrentIndex(lines, currentTimeMs) {
    if (!lines || lines.length === 0) return -1;
    if (currentTimeMs < lines[0].time) return -1;

    let low = 0;
    let high = lines.length - 1;
    let resultIndex = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (lines[mid].time <= currentTimeMs) {
        resultIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return resultIndex;
  }
}

export default universalLyricParser;
