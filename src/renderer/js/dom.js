// 全部 DOM 元素引用集中于此，feature 模块不再各自 getElementById。
// script type=module 延迟执行，模块求值时 DOM 已就绪。
export const audio = document.getElementById('audioPlayer');
export const playlistDrawer = document.getElementById('playlistDrawer');
export const playlistEl = document.getElementById('playlist');
export const playlistCountEl = document.getElementById('playlistCount');
export const searchInput = document.getElementById('searchInput');
export const letterIndexEl = document.getElementById('letterIndex');

export const coverContainer = document.getElementById('coverContainer');
export const coverImg = document.getElementById('coverImg');
export const defaultCover = document.getElementById('defaultCover');
export const lyricsContainer = document.getElementById('lyricsContainer');
export const lyricsScroll = document.getElementById('lyricsScroll');
export const btnLyricTranslation = document.getElementById('btnLyricTranslation');
export const volumeHud = document.getElementById('volumeHud');

// 歌名/歌手现在在底部传输条里。playback.js 用的是这些变量名而不是元素 id，
// 所以改名只需要动这里。
export const titleEl = document.getElementById('barTitle');
export const artistEl = document.getElementById('barArtist');
export const albumEl = document.getElementById('barAlbum');
export const barThumb = document.getElementById('barThumb');
export const currentTimeEl = document.getElementById('currentTime');
export const totalTimeEl = document.getElementById('totalTime');
export const canvas = document.getElementById('colorCanvas');
// progressBar 已移除：进度不再是 <input type=range>，
// 改由 .viz-bars 的宽度 + .viz-head 的位置表达，驱动逻辑在 theme.js 的 updateProgressStyle。

export const btnPlay = document.getElementById('btnPlay');
export const btnMode = document.getElementById('btnMode');
export const btnPlaylist = document.getElementById('btnPlaylist');

export const iconLoop = document.getElementById('iconLoop');
export const iconOne = document.getElementById('iconOne');
export const iconShuffle = document.getElementById('iconShuffle');

// 排序交互节点
export const btnSortTitle = document.getElementById('sortTitle');
export const btnSortArtist = document.getElementById('sortArtist');
export const btnSortRandom = document.getElementById('sortRandom');

// 设置浮层元素
export const settingsOverlay = document.getElementById('settingsOverlay');
export const btnSettingsClose = document.getElementById('btnSettingsClose');
export const folderListEl = document.getElementById('folderList');
export const btnAddFolder = document.getElementById('btnAddFolder');
export const btnRescanLibrary = document.getElementById('btnRescanLibrary');
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
export const desktopLyricsClickThroughSwitch = document.getElementById(
  'desktopLyricsClickThroughSwitch'
);
export const fontSelectWrap = document.getElementById('fontSelectWrap');
export const fontSelectBtn = document.getElementById('fontSelectBtn');
export const fontSelectValue = document.getElementById('fontSelectValue');
export const fontSearchInput = document.getElementById('fontSearch');
export const fontOptions = document.getElementById('fontOptions');
export const taskbarFontSelectWrap = document.getElementById('taskbarFontSelectWrap');
export const taskbarFontSelectBtn = document.getElementById('taskbarFontSelectBtn');
export const taskbarFontSelectValue = document.getElementById('taskbarFontSelectValue');
export const taskbarFontSearchInput = document.getElementById('taskbarFontSearch');
export const taskbarFontOptions = document.getElementById('taskbarFontOptions');
export const taskbarWeightSeg = document.getElementById('taskbarWeightSeg');
export const taskbarAutoColor = document.getElementById('taskbarAutoColor');
export const taskbarTextColor = document.getElementById('taskbarTextColor');

// 均衡器面板元素（推子与预设胶囊由 equalizer.js 动态生成）
export const eqEnableSwitch = document.getElementById('eqEnable');
export const eqPresetsEl = document.getElementById('eqPresets');
export const eqFadersEl = document.getElementById('eqFaders');
export const eqStatusEl = document.getElementById('eqStatus');
export const eqPreampEl = document.getElementById('eqPreamp');
export const eqResetBtn = document.getElementById('eqReset');

// 小窗单行歌词元素
// 小窗四行歌词，按显示顺序：上一句 / 当前句 / 下一句 / 再下一句。
// 当前句固定占第 2 行（见 lyrics.js 的 MINI_NOW_SLOT 与 CSS 的 .mini-lyric.now）。
export const miniLyricsBoxEl = document.getElementById('miniLyricsBox'); // 四行的容器，做整体淡入淡出
export const miniLyricPrevEl = document.getElementById('miniLyricPrev');
export const miniLyricNowEl = document.getElementById('miniLyricNow');
export const miniLyricNextEl = document.getElementById('miniLyricNext');
export const miniLyricNext2El = document.getElementById('miniLyricNext2');

// 帮助浮层元素
export const helpOverlayEl = document.getElementById('helpOverlay');
export const btnHelpClose = document.getElementById('btnHelpClose');
export const helpVersionEl = document.getElementById('helpVersion');

// 同步提示 toast
export const syncToastEl = document.getElementById('syncToast');

// 自定义歌单抽屉元素
export const playlistsDrawer = document.getElementById('playlistsDrawer');
export const playlistsListView = document.getElementById('playlistsListView');
export const playlistsDetailView = document.getElementById('playlistsDetailView');
export const playlistsListEl = document.getElementById('playlistsList');
export const playlistsCountEl = document.getElementById('playlistsCount');
export const btnNewPlaylist = document.getElementById('btnNewPlaylist');
export const playlistsDetailName = document.getElementById('playlistsDetailName');
export const playlistsRenameInput = document.getElementById('playlistsRenameInput');
export const btnPlaylistsBack = document.getElementById('btnPlaylistsBack');
export const btnRenamePlaylist = document.getElementById('btnRenamePlaylist');
export const btnDeletePlaylist = document.getElementById('btnDeletePlaylist');
export const playlistsSongListEl = document.getElementById('playlistsSongList');

// 歌曲右键菜单元素
export const contextMenu = document.getElementById('contextMenu');
export const ctxAddToPlaylist = document.getElementById('ctxAddToPlaylist');
export const ctxPlaylistOptions = document.getElementById('ctxPlaylistOptions');

// 外观 · 主题选择
export const themeSeg = document.getElementById('themeSeg');

// 播放统计浮层元素
export const statsOverlay = document.getElementById('statsOverlay');
export const btnStatsClose = document.getElementById('btnStatsClose');
export const statsVinyl = document.getElementById('statsVinyl');
export const statsVinylCover = document.getElementById('statsVinylCover');
export const statsVinylFallback = document.getElementById('statsVinylFallback');
export const statsSongTitle = document.getElementById('statsSongTitle');
export const statsSongArtist = document.getElementById('statsSongArtist');
export const statsTier = document.getElementById('statsTier');
export const statsAlbum = document.getElementById('statsAlbum');
export const statsBitrate = document.getElementById('statsBitrate');
export const statsSampleRate = document.getElementById('statsSampleRate');
export const statsBits = document.getElementById('statsBits');
export const statsFullPlays = document.getElementById('statsFullPlays');
export const statsLoopPlays = document.getElementById('statsLoopPlays');
export const statsTotalPlays = document.getElementById('statsTotalPlays');
export const statsRankedCount = document.getElementById('statsRankedCount');
export const statsDailyAvg = document.getElementById('statsDailyAvg');
export const statsChartList = document.getElementById('statsChartList');
export const statsEmptyEl = document.getElementById('statsEmpty');
