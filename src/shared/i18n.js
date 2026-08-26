// 轻量 i18n：主窗口、悬浮窗、主进程共享同一字典。
// 模块顶层保持纯净（不访问 DOM），主进程导入不会崩溃。

const dict = {
  'zh-CN': {
    'app.waitingForMusic': '等待音乐中...',
    'titlebar.minimize': '最小化',
    'titlebar.maximize': '最大化',
    'common.close': '关闭',
    'btn.playMode': '播放模式',
    'btn.playlist': '播放列表',
    'playlist.nowPlaying': '正在播放',
    'playlist.searchPlaceholder': '搜索歌曲...',
    'playlist.sortLabel': '排序:',
    'playlist.sortDefault': '默认',
    'playlist.sortTitle': '歌名',
    'playlist.sortArtist': '歌手',
    'playlist.sortRandom': '随机',
    'playlist.count': '{n}首',
    'hud.volume': 'VOL {n}%',
    'lyrics.loading': '加载歌词中...',
    'lyrics.noLyrics': '暂无歌词信息',
    'lyrics.noLyricsShort': '暂无歌词',
    'sync.foundNew': '发现 {n} 首新歌',
    'folders.duplicate': '该文件夹已在列表中',
    'help.intro': '一款离线音乐播放器',
    'help.shortcuts': '键盘快捷键',
    'help.playPause': '播放 / 暂停',
    'help.prev': '上一曲',
    'help.next': '下一曲',
    'help.playMode': '切换播放模式',
    'help.playlistToggle': '呼出 / 折叠播放列表',
    'help.holdHint': '长按 0.5 秒',
    'help.miniMode': '切换小窗模式',
    'help.desktopLyrics': '桌面歌词',
    'help.settings': '打开设置',
    'help.help': '打开 / 关闭帮助',
    'help.closeHelp': '关闭浮窗',
    'help.mouse': '鼠标操作',
    'help.volume': '调节音量',
    'help.volumeHint': '封面区域滚动滚轮',
    'help.showHide': '显示 / 隐藏窗口',
    'help.showHideHint': '双击托盘图标',
    'tray.playPause': '播放/暂停',
    'tray.next': '下一首',
    'tray.prev': '上一首',
    'tray.showWindow': '显示窗口',
    'tray.quit': '退出',
    'tray.tooltip': 'Dreamisle 音乐播放器',
    'settings.title': '设置',
    'settings.language': '语言',
    'settings.folders': '音乐文件夹',
    'settings.languageDesc': '界面与托盘菜单的显示语言',
    'settings.foldersDesc': '添加多个文件夹，歌曲将合并到播放列表',
    'settings.lyricsStyleDesc': '调整桌面歌词悬浮窗的外观',
    'settings.addFolder': '添加文件夹',
    'settings.noFolders': '尚未添加文件夹',
    'settings.removeFolder': '移除',
    'settings.folderUnavailable': '（不可用）',
    'settings.lyricsStyle': '桌面歌词样式',
    'settings.bgOpacity': '背景不透明度',
    'settings.textOpacity': '字体不透明度',
    'settings.textColor': '字体颜色',
    'settings.fontFamily': '自定义字体',
    'settings.fontDefault': '默认字体',
    'settings.fontSearch': '搜索字体…',
    'settings.fontLoadError': '读取系统字体失败',
    'settings.reset': '重置默认',
  },
  en: {
    'app.waitingForMusic': 'Waiting for music...',
    'titlebar.minimize': 'Minimize',
    'titlebar.maximize': 'Maximize',
    'common.close': 'Close',
    'btn.playMode': 'Play mode',
    'btn.playlist': 'Playlist',
    'playlist.nowPlaying': 'Now playing',
    'playlist.searchPlaceholder': 'Search songs...',
    'playlist.sortLabel': 'Sort:',
    'playlist.sortDefault': 'Default',
    'playlist.sortTitle': 'Title',
    'playlist.sortArtist': 'Artist',
    'playlist.sortRandom': 'Random',
    'playlist.count': '{n} songs',
    'hud.volume': 'VOL {n}%',
    'lyrics.loading': 'Loading lyrics...',
    'lyrics.noLyrics': 'No lyrics available',
    'lyrics.noLyricsShort': 'No lyrics',
    'sync.foundNew': '{n} new songs found',
    'folders.duplicate': 'This folder is already in the list',
    'help.intro': 'An offline music player',
    'help.shortcuts': 'Keyboard shortcuts',
    'help.playPause': 'Play / Pause',
    'help.prev': 'Previous track',
    'help.next': 'Next track',
    'help.playMode': 'Switch play mode',
    'help.playlistToggle': 'Show / hide playlist',
    'help.holdHint': 'hold 0.5s',
    'help.miniMode': 'Toggle mini mode',
    'help.desktopLyrics': 'Desktop lyrics',
    'help.settings': 'Open settings',
    'help.help': 'Open / close help',
    'help.closeHelp': 'Close overlay',
    'help.mouse': 'Mouse',
    'help.volume': 'Adjust volume',
    'help.volumeHint': 'Scroll on album art',
    'help.showHide': 'Show / hide window',
    'help.showHideHint': 'Double-click tray icon',
    'tray.playPause': 'Play/Pause',
    'tray.next': 'Next',
    'tray.prev': 'Previous',
    'tray.showWindow': 'Show window',
    'tray.quit': 'Quit',
    'tray.tooltip': 'Dreamisle Music Player',
    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.folders': 'Music folders',
    'settings.languageDesc': 'Display language for the UI and tray menu',
    'settings.foldersDesc': 'Add multiple folders; songs are merged into the playlist',
    'settings.lyricsStyleDesc': 'Adjust the appearance of the desktop lyrics overlay',
    'settings.addFolder': 'Add folder',
    'settings.noFolders': 'No folders added yet',
    'settings.removeFolder': 'Remove',
    'settings.folderUnavailable': ' (unavailable)',
    'settings.lyricsStyle': 'Desktop lyrics style',
    'settings.bgOpacity': 'Background opacity',
    'settings.textOpacity': 'Text opacity',
    'settings.textColor': 'Text color',
    'settings.fontFamily': 'Custom font',
    'settings.fontDefault': 'Default font',
    'settings.fontSearch': 'Search fonts…',
    'settings.fontLoadError': 'Failed to load system fonts',
    'settings.reset': 'Reset defaults',
  },
};

let currentLang = 'zh-CN';

export function setLang(lang) {
  if (dict[lang]) currentLang = lang;
}

export function getLang() {
  return currentLang;
}

export function t(key, params = {}) {
  let text = (dict[currentLang] && dict[currentLang][key]) ?? dict['zh-CN'][key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

export function applyLang(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}
