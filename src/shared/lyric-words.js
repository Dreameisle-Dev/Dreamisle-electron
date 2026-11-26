// 增强型 LRC 逐字时间戳工具统一由独立开源子模块 `packages/universal-lyric-parser` 提供，
// 保留此入口供 `lyric-word-dom.js` 等共享模块引用。
export {
  hasWordTimestamps,
  stripWordTimestamps,
  parseEnhancedWords,
  shiftWords,
  sliceWordsByLength,
  finalizeWordsTimeline,
  computeWordProgress,
} from '../../packages/universal-lyric-parser/src/words.js';
