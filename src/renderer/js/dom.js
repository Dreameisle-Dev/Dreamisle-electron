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
export const btnLyricTranslation = document.getElementById('btnLyricTranslation');
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
