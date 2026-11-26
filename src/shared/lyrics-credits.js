// 歌词制作信息（credits）与「歌名 - 歌手」头部剔除统一由独立开源子模块
// `packages/lyrics-without-credits` 提供，保留此入口供主进程/渲染进程共享引用。
export {
  defaultRules,
  createCreditsFilter,
  isCreditLine,
  explainCreditLine,
  stripCreditLines,
  stripSongHeader,
  stripLyrics,
} from '../../packages/lyrics-without-credits/src/index.js';
