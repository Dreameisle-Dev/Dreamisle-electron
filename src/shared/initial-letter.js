// 歌曲首字母归位：中英混排字母索引的基础。纯函数，无 Electron / DOM 依赖。
// 汉字没有「首字母」属性，这里借 Intl.Collator 的拼音排序反推：取一组已知声母的
// 锚点字，答案是「最后一个 ≤ 该字的锚点」，得到的字母沿排序结果必然单调不减。

const collator = new Intl.Collator('zh-CN');

// 锚点字必须取该声母下**排序最靠前**的字：取高了会把排它前面的同声母字算给上一个
// 声母（「期」当锚点曾把「七」归进 P）。没有 I / U / V —— 普通话里不作声母。
const ANCHORS = [
  ['A', '阿'],
  ['B', '八'],
  ['C', '擦'],
  ['D', '搭'],
  ['E', '蛾'],
  ['F', '发'],
  ['G', '噶'],
  ['H', '哈'],
  ['J', '击'],
  ['K', '喀'],
  ['L', '垃'],
  ['M', '妈'],
  ['N', '拿'],
  ['O', '哦'],
  ['P', '啪'],
  ['Q', '七'],
  ['R', '然'],
  ['S', '撒'],
  ['T', '他'],
  ['W', '挖'],
  ['X', '西'],
  ['Y', '压'],
  ['Z', '匝'],
];

// CJK 扩展 A + 基本区
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
// 只跳过开头的成对引号 / 括号与空白，不剥离任意符号 ——
// 「°C」「_underscore」这类应当以符号本身归入 #，剥掉会误判成 C / U。
const LEADING = /^[\s\u3000「」『』“”‘’《》〈〉（）()\[\]【】{}]+/u;
const COMBINING = /[\u0300-\u036f]/g;

export const HASH = '#';

function firstMeaningfulChar(text) {
  return String(text ?? '').replace(LEADING, '')[0] || '';
}

// 返回 'A'..'Z' 或 '#'
export function initialOf(text) {
  const ch = firstMeaningfulChar(text);
  if (!ch) return HASH;

  if (HAN.test(ch)) {
    let letter = HASH;
    for (const [candidate, anchor] of ANCHORS) {
      if (collator.compare(anchor, ch) <= 0) letter = candidate;
    }
    return letter;
  }

  // 带变音符的拉丁字母（Édith）先去音符再取首字母
  const base = ch.normalize('NFD').replace(COMBINING, '').toUpperCase();
  return base >= 'A' && base <= 'Z' ? base : HASH;
}

// '#' 要排在 Z 之后；按 ASCII 码位比较的话 #(0x23) 会跑到 A 前面
function rank(letter) {
  return letter === HASH ? 26 : letter.charCodeAt(0) - 65;
}

export function compareByInitial(a, b) {
  const diff = rank(initialOf(a)) - rank(initialOf(b));
  if (diff !== 0) return diff;
  return collator.compare(String(a ?? ''), String(b ?? ''));
}

// 排序结果中每个字母的首个下标，按字母顺序返回：[{ letter, index }]
export function buildLetterIndex(sortedItems, keyOf = (item) => item) {
  const index = [];
  let last = null;
  sortedItems.forEach((item, i) => {
    const letter = initialOf(keyOf(item));
    if (letter !== last) {
      index.push({ letter, index: i });
      last = letter;
    }
  });
  return index;
}
