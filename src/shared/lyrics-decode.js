// 歌词多编码自动识别与解码：支持 UTF-8（含/不含 BOM）、UTF-16LE/BE（含/不含 BOM）、
// GB18030/GBK/GB2312、Big5、Shift_JIS、EUC-JP、EUC-KR 与 Windows-1252，
// 同时修复老旧 MP3 ID3v2 标签把 UTF-8/CJK 误标为 ISO-8859-1 导致的乱码。
// 纯 JS（无 Electron 依赖），供主进程读取 .lrc/内嵌歌词与渲染进程共用。

const CANDIDATE_ENCODINGS = ['gb18030', 'big5', 'shift_jis', 'euc-jp', 'euc-kr', 'windows-1252'];
const LRC_TIMESTAMP_RE = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g;

// 简体/繁体高频歌词常用字，用于区分真实中文歌词与跨编码碰撞出的生僻字乱码
const COMMON_CJK_CHARS = new Set(
  Array.from(
    '的一是不了人在有我他她它这這为為着著们們会會说說到要和也就能过過没沒看爱愛想心天你时光年风風雨花月夜梦夢世界歌情感记忆記億手眼泪淚笑哭听聽走来來去回给給让讓把被从從对對里裡中大小多少上下前后前後左右长長好真只都还還又再很最更可已无無生与與个個点點实實谁誰么麼开開关關那什么麼如果因为為所以但还是還是知道觉得覺得以向问問话話声聲海山星云雲雪春秋冬夏花落白黑红紅蓝藍黄黃明暗深浅淺远遠近高低温溫冷热熱痛伤傷孤单單寂寞幸福快乐樂自由永远遠曾经經以后後现在现見见忘离離别別等怕错錯懂念写寫唱'
  )
);

const WIN1252_PUNCT_OK = new Set([0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026]);
const WIN1252_EXTRA_LETTERS = new Set([0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e]);
// WHATWG Windows-1252 0x80..0x9F 映射：Node 内置 TextDecoder('windows-1252') 会按 ISO-8859-1 直通，
// 查表解码可保证 € / ‘’“” / –— / œ 等字符在主进程和渲染进程一致。
const WIN1252_80_9F = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];
const decoderCache = new Map();

function decodeWindows1252(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? WIN1252_80_9F[b - 0x80] : b);
  }
  return out;
}

function getDecoder(encoding, fatal = false) {
  const key = `${encoding}:${fatal ? 1 : 0}`;
  let decoder = decoderCache.get(key);
  if (!decoder) {
    try {
      decoder = new TextDecoder(encoding, { fatal });
      decoderCache.set(key, decoder);
    } catch {
      return null;
    }
  }
  return decoder;
}

function stripLeadingBom(text) {
  if (!text) return '';
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function toUint8Array(input) {
  if (!input) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) return Uint8Array.from(input);
  return new Uint8Array(0);
}

// 检测无 BOM 的 UTF-16LE / UTF-16BE（LRC 含大量 ASCII 时间戳，奇偶位 NUL 字节分布极不对称）
function detectUtf16WithoutBom(bytes) {
  if (bytes.length < 4) return null;
  const sampleLen = Math.min(bytes.length, 4096) & ~1;
  let evenZero = 0;
  let oddZero = 0;
  let evenAscii = 0;
  let oddAscii = 0;

  for (let i = 0; i < sampleLen; i += 2) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    if (b0 === 0) evenZero++;
    else if (b0 >= 0x09 && b0 <= 0x7e) evenAscii++;
    if (b1 === 0) oddZero++;
    else if (b1 >= 0x09 && b1 <= 0x7e) oddAscii++;
  }

  const totalZero = evenZero + oddZero;
  if (totalZero / sampleLen < 0.2) return null;
  if (oddZero >= evenZero * 4 && evenAscii >= oddZero * 0.5) return 'utf-16le';
  if (evenZero >= oddZero * 4 && oddAscii >= evenZero * 0.5) return 'utf-16be';
  return null;
}

function scoreGb18030Bytes(bytes) {
  let score = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b0 = bytes[i];
    if (b0 < 0x80) continue;
    if (i + 1 >= bytes.length) {
      score -= 10;
      break;
    }
    const b1 = bytes[i + 1];
    if (b0 >= 0x81 && b0 <= 0xfe && b1 >= 0x30 && b1 <= 0x39 && i + 3 < bytes.length) {
      // 4 字节 GB18030（常见于生僻扩展区，极少在常规歌词出现）
      score -= 1.5;
      i += 3;
      continue;
    }
    if (b0 >= 0xb0 && b0 <= 0xd7 && b1 >= 0xa1 && b1 <= 0xfe) {
      // GB2312 一级常用汉字（覆盖 99%+ 简体歌词）
      score += 1.8;
    } else if (b0 >= 0xa1 && b0 <= 0xa3 && b1 >= 0xa1 && b1 <= 0xfe) {
      // GB2312 全角标点与符号
      score += 1.2;
    } else if (b0 >= 0xd8 && b0 <= 0xf7 && b1 >= 0xa1 && b1 <= 0xfe) {
      // GB2312 二级次常用字
      score += 0.3;
    } else if (b0 >= 0x81 && b0 <= 0xfe && b1 >= 0x40 && b1 <= 0xfe && b1 !== 0x7f) {
      // GBK 扩展区：略降权以免误吃 Big5 的 0x40..0x7E 尾字节
      score -= 0.4;
    } else {
      score -= 6;
    }
    i += 1;
  }
  return score;
}

function scoreBig5Bytes(bytes) {
  let score = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b0 = bytes[i];
    if (b0 < 0x80) continue;
    if (i + 1 >= bytes.length) {
      score -= 10;
      break;
    }
    const b1 = bytes[i + 1];
    const validTrail = (b1 >= 0x40 && b1 <= 0x7e) || (b1 >= 0xa1 && b1 <= 0xfe);
    if (!validTrail) {
      score -= 6;
      continue;
    }
    if ((b0 >= 0xa4 && b0 <= 0xc5) || (b0 === 0xc6 && b1 <= 0x7e)) {
      // Big5 一级常用繁体字
      score += 1.8;
    } else if (b0 >= 0xa1 && b0 <= 0xa3) {
      score += 1.2;
    } else if (b0 >= 0xc9 && b0 <= 0xf9) {
      // Big5 二级生僻字
      score -= 0.5;
    } else {
      score -= 6;
    }
    i += 1;
  }
  return score;
}

function isAsciiLetter(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isLatin1Letter(code) {
  return (
    (code >= 0xc0 && code <= 0xff && code !== 0xd7 && code !== 0xf7) ||
    WIN1252_EXTRA_LETTERS.has(code)
  );
}

function scoreWindows1252(text, bytes) {
  let score = 0;
  let highRun = 0;

  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0x80) {
      highRun++;
    } else {
      if (highRun >= 4) score -= highRun * 4.5;
      else if (highRun === 3) score -= 5;
      highRun = 0;
    }
  }
  if (highRun >= 4) score -= highRun * 4.5;
  else if (highRun === 3) score -= 5;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) continue;
    const prev = i > 0 ? text.charCodeAt(i - 1) : 0x20;
    const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0x20;
    const nearAsciiWord = isAsciiLetter(prev) || isAsciiLetter(next);

    if (WIN1252_PUNCT_OK.has(code)) {
      score += 2.2;
    } else if (isLatin1Letter(code)) {
      // 西欧重音字母通常嵌在 ASCII 单词中；孤立或成片出现则高度疑似 CJK 字节误解
      if (nearAsciiWord && !isLatin1Letter(prev) && !isLatin1Letter(next)) score += 2.8;
      else if (nearAsciiWord) score += 0.8;
      else score -= 2.2;
    } else if (code >= 0x80 && code <= 0x9f) {
      score -= 12;
    } else {
      // £¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿×÷€ƒ… 等在正常歌词里很少连续出现
      score -= 2.8;
    }
  }
  return score;
}

function scoreCandidate(encoding, text, bytes, strictValid) {
  let score = strictValid ? 12 : 0;

  // 保留完整 LRC 时间戳结构的编码加分（避免错误双字节吞掉 '[' 或 ']'）
  const timestamps = text.match(LRC_TIMESTAMP_RE);
  if (timestamps) score += Math.min(timestamps.length, 40) * 1.5;

  if (encoding === 'windows-1252') {
    return score + scoreWindows1252(text, bytes);
  }

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
        score -= 15;
      }
      continue;
    }
    if (code === 0xfffd) {
      score -= 30;
    } else if (code >= 0x80 && code <= 0x9f) {
      score -= 15;
    } else if (code >= 0x3040 && code <= 0x309f) {
      // 日文平假名
      score += encoding === 'shift_jis' || encoding === 'euc-jp' ? 5.5 : 1.0;
    } else if (code >= 0x30a0 && code <= 0x30ff) {
      // 日文片假名
      score += encoding === 'shift_jis' || encoding === 'euc-jp' ? 4.5 : 0.8;
    } else if (code >= 0xac00 && code <= 0xd7a3) {
      // 韩文音节
      score += encoding === 'euc-kr' ? 5.5 : 0.5;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      score += COMMON_CJK_CHARS.has(text[i]) ? 4.5 : 1.3;
    } else if ((code >= 0x3000 && code <= 0x303f) || (code >= 0xff01 && code <= 0xff5e)) {
      score += 2.0;
    } else if (code >= 0xff61 && code <= 0xff9f) {
      // 半角片假名：GBK/Big5 误按 Shift_JIS 解码的高频乱码产物
      score -= 3.5;
    } else if (code >= 0xe000 && code <= 0xf8ff) {
      score -= 5.0;
    } else if (code >= 0x3400 && code <= 0x4dbf) {
      // 罕见 CJK 扩展 A
      score -= 0.8;
    } else {
      score -= 0.6;
    }
  }

  if (encoding === 'gb18030') score += scoreGb18030Bytes(bytes);
  else if (encoding === 'big5') score += scoreBig5Bytes(bytes);

  return score;
}

function decodeWithFallback(bytes) {
  let bestText = '';
  let bestEncoding = 'utf-8';
  let bestScore = -Infinity;

  for (const encoding of CANDIDATE_ENCODINGS) {
    let text = null;
    let strictValid = false;

    if (encoding === 'windows-1252') {
      text = decodeWindows1252(bytes);
      strictValid = true;
    } else {
      const strictDecoder = getDecoder(encoding, true);
      if (strictDecoder) {
        try {
          text = strictDecoder.decode(bytes);
          strictValid = true;
        } catch {
          // 含个别坏字节时降级为非严格解码，仍参与评分（每个 U+FFFD 会被重罚）
        }
      }
      if (text === null) {
        const looseDecoder = getDecoder(encoding, false);
        if (!looseDecoder) continue;
        text = looseDecoder.decode(bytes);
      }
    }

    const score = scoreCandidate(encoding, text, bytes, strictValid);
    if (score > bestScore) {
      bestScore = score;
      bestText = text;
      bestEncoding = encoding;
    }
  }

  return { text: stripLeadingBom(bestText), encoding: bestEncoding, score: bestScore };
}

/**
 * 将原始字节数组按最可信的编码解码为歌词文本，并自动剔除 BOM。
 * @param {Buffer|Uint8Array|ArrayBuffer|number[]} input
 * @returns {string}
 */
export function decodeLyricsBuffer(input) {
  const bytes = toUint8Array(input);
  if (bytes.length === 0) return '';

  // 1. 显式 BOM 优先
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const dec = getDecoder('utf-8', false);
    return stripLeadingBom(dec ? dec.decode(bytes.subarray(3)) : '');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const dec = getDecoder('utf-16le', false);
    return stripLeadingBom(dec ? dec.decode(bytes.subarray(2)) : '');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const dec = getDecoder('utf-16be', false);
    return stripLeadingBom(dec ? dec.decode(bytes.subarray(2)) : '');
  }

  // 2. 无 BOM UTF-16 检测
  const utf16 = detectUtf16WithoutBom(bytes);
  if (utf16) {
    const evenBytes = bytes.length % 2 === 0 ? bytes : bytes.subarray(0, bytes.length - 1);
    const dec = getDecoder(utf16, false);
    if (dec) return stripLeadingBom(dec.decode(evenBytes));
  }

  // 3. 严格 UTF-8（合法 UTF-8 与纯 ASCII 直接命中）
  const strictUtf8 = getDecoder('utf-8', true);
  if (strictUtf8) {
    try {
      return stripLeadingBom(strictUtf8.decode(bytes));
    } catch {
      // 非 UTF-8，进入多编码候选评分
    }
  }

  // 4. 多编码自动判别（GB18030/GBK、Big5、Shift_JIS、EUC-JP、EUC-KR、Windows-1252）
  return decodeWithFallback(bytes).text;
}

/**
 * 修复内嵌 ID3v2 歌词因错误声明 ISO-8859-1 编码而产生的拉丁乱码；
 * 对正常 Unicode 文本及法/德/西语等真实拉丁重音文本保持原样不误伤。
 * @param {string} text
 * @returns {string}
 */
export function repairMojibakeText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  let hasHighByte = false;
  let maxHighRun = 0;
  let curHighRun = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return stripLeadingBom(text); // 已含多字节 Unicode，直接保留
    if (code >= 0x80) {
      hasHighByte = true;
      curHighRun++;
      if (curHighRun > maxHighRun) maxHighRun = curHighRun;
    } else {
      curHighRun = 0;
    }
  }
  if (!hasHighByte) return text;

  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);

  // 先判是否为被按 Latin-1 读出的合法 UTF-8（西欧原文几乎不可能偶然组成合法多字节 UTF-8）
  const strictUtf8 = getDecoder('utf-8', true);
  if (strictUtf8) {
    try {
      return stripLeadingBom(strictUtf8.decode(bytes));
    } catch {
      // 不是 UTF-8，继续判断是否为 CJK 误标 Latin-1
    }
  }

  // 仅当存在 ≥4 字节连续高位字节（典型双字节 CJK 词组）且多编码评分明确指向非西欧编码时才修复
  if (maxHighRun < 4) return text;
  const result = decodeWithFallback(bytes);
  if (result.encoding === 'windows-1252' || result.score <= 0) return text;
  return result.text;
}
