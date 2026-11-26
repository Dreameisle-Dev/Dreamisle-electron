// 通用 LRC 双语与逐字歌词解析器由独立开源子模块 `packages/universal-lyric-parser` 提供，
// 保留此入口供主进程/渲染进程共享引用。
export {
  default,
  UniversalLyricParser,
  parse,
  parseSyncLyrics,
  formatSyncLyricsToLrc,
  getCurrentIndex,
  hasWordTimestamps,
  stripWordTimestamps,
  parseEnhancedWords,
  shiftWords,
  sliceWordsByLength,
  finalizeWordsTimeline,
  computeWordProgress,
} from '../../packages/universal-lyric-parser/src/index.js';
