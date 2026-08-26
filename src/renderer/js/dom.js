// 全部 DOM 元素引用集中于此，feature 模块不再各自 getElementById。
// script type=module 延迟执行，模块求值时 DOM 已就绪。
export const audio = document.getElementById('audioPlayer');
export const playlistDrawer = document.getElementById('playlistDrawer');
export const playlistEl = document.getElementById('playlist');
export const playlistCountEl = document.getElementById('playlistCount');
export const searchInput = document.getElementById('searchInput');

export const coverContainer = document.getElementById('coverContainer');
export const coverImg = document.getElementById('coverImg');
export const defaultCover = document.getElementById('defaultCover');
export const lyricsContainer = document.getElementById('lyricsContainer');
export const lyricsScroll = document.getElementById('lyricsScroll');
export const volumeHud = document.getElementById('volumeHud');

export const titleEl = document.getElementById('songTitle');
export const artistEl = document.getElementById('artistName');
export const progressBar = document.getElementById('progressBar');
export const currentTimeEl = document.getElementById('currentTime');
export const totalTimeEl = document.getElementById('totalTime');
export const canvas = document.getElementById('colorCanvas');

export const btnPlay = document.getElementById('btnPlay');
export const btnMode = document.getElementById('btnMode');
export const btnPlaylist = document.getElementById('btnPlaylist');

export const iconLoop = document.getElementById('iconLoop');
export const iconOne = document.getElementById('iconOne');
export const iconShuffle = document.getElementById('iconShuffle');

// 排序交互节点
export const btnSortDefault = document.getElementById('sortDefault');
export const btnSortTitle = document.getElementById('sortTitle');
export const btnSortArtist = document.getElementById('sortArtist');
export const btnSortRandom = document.getElementById('sortRandom');

// 设置浮层元素
export const settingsOverlay = document.getElementById('settingsOverlay');
export const btnSettingsClose = document.getElementById('btnSettingsClose');
export const folderListEl = document.getElementById('folderList');
export const btnAddFolder = document.getElementById('btnAddFolder');
export const langSelectWrap = document.getElementById('langSelectWrap');
export const langSelectBtn = document.getElementById('langSelectBtn');
export const langSelectValue = document.getElementById('langSelectValue');
export const langSelectList = document.getElementById('langSelectList');
export const bgOpacityInput = document.getElementById('bgOpacity');
export const textOpacityInput = document.getElementById('textOpacity');
export const textColorInput = document.getElementById('textColor');
export const bgOpacityVal = document.getElementById('bgOpacityVal');
export const textOpacityVal = document.getElementById('textOpacityVal');
export const btnResetStyle = document.getElementById('btnResetStyle');
export const fontSelectWrap = document.getElementById('fontSelectWrap');
export const fontSelectBtn = document.getElementById('fontSelectBtn');
export const fontSelectValue = document.getElementById('fontSelectValue');
export const fontSearchInput = document.getElementById('fontSearch');
export const fontOptions = document.getElementById('fontOptions');

// 小窗单行歌词元素
export const miniLyricsEl = document.getElementById('miniLyrics');

// 帮助浮层元素
export const helpOverlayEl = document.getElementById('helpOverlay');
export const btnHelpClose = document.getElementById('btnHelpClose');
export const helpVersionEl = document.getElementById('helpVersion');

// 同步提示 toast
export const syncToastEl = document.getElementById('syncToast');
