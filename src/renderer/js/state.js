// 渲染进程共享状态：feature 模块 import 后直接读写。
// 所有权约定 —— songs/currentIndex/playMode 归 playlist 与 playback，歌词状态归 lyrics.js，
// currentLyricsStyle/systemFonts 归 settings.js，equalizer 归 equalizer.js。
import { DEFAULT_EQ } from '../../shared/equalizer.js';

export const state = {
  // 播放列表
  originalSongs: [], // 保存最原始物理读取顺序的备份
  songs: [],
  currentIndex: -1,
  playMode: 0,
  sortMode: 'title', // 'title' | 'artist' | 'random'；字母索引只在 title/artist 下有意义
  letterIndex: [], // [{ letter, index }]，按当前排序算出的每组首行下标

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
  showLyricsTranslation: true, // 歌词翻译开关(启动时由设置初始化)

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
  equalizer: { ...DEFAULT_EQ, gains: [...DEFAULT_EQ.gains] }, // 启动时由主进程配置覆盖

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
