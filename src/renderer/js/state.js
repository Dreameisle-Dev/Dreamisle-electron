// 渲染进程共享状态：feature 模块通过 `import { state } from './state.js'` 直接读写。
// 所有权约定：
// - songs / originalSongs / currentIndex / playMode 由 playlist 与 playback 协作维护
// - 歌词状态（currentLyrics 等）仅 lyrics.js 写入
// - currentLyricsStyle / systemFonts 仅 settings.js 写入
export const state = {
  // 播放列表
  originalSongs: [], // 保存最原始物理读取顺序的备份
  songs: [],
  currentIndex: -1,
  playMode: 0,

  // 自定义歌单
  activeQueue: { type: 'library' }, // { type: 'library' } | { type: 'playlist', id };会话级,不持久化
  librarySongs: [], // 曲库缓存:activeQueue 为歌单时与播放队列解耦
  playlists: [], // 歌单缓存副本(主进程为唯一数据源)
  playlistsView: 'list', // 'list' | 'detail'
  detailPlaylistId: null,
  dragSong: null, // 从右侧列表拖出的歌曲
  dragAutoOpenedDrawer: false, // 拖拽时自动展开的左抽屉需在 dragend 恢复原状

  // 播放进度
  isDragging: false,
  volumeTimeout: null,

  // 歌词
  currentLyrics: [],
  currentLineIndex: -1,
  lyricDoms: [],
  lastDesktopText: null, // 去重：仅在实际变化时向主进程推送桌面歌词
  isUserScrolling: false,
  userScrollTimeout: null,

  // 封面
  currentCoverBlobUrl: null,

  // 环境光鼠标跟随
  mouseX: 50,
  mouseY: 50,
  targetMouseX: 50,
  targetMouseY: 50,
  isAnimating: false,

  // 虚拟列表
  filteredSongs: [],
  vsStartIndex: 0,
  vsEndIndex: 0,

  // 窗口模式追踪
  isMiniMode: false,

  // 设置
  currentLyricsStyle: { bgOpacity: 45, textOpacity: 100, textColor: '#ffffff', fontFamily: '' },
  systemFonts: null,
  fontsLoadFailed: false,

  // 同步提示 toast
  syncToastTimer: null,
};

export const DEFAULT_LYRICS_STYLE = {
  bgOpacity: 45,
  textOpacity: 100,
  textColor: '#ffffff',
  fontFamily: '',
};
export const ITEM_HEIGHT = 62;
