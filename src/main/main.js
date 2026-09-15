import { app, session, nativeTheme } from 'electron';
import { migrateLegacyMusicFolder, getLanguage, getLyricsStyle, getThemeMode } from './store.js';
import { createWindow, getMainWindow } from './window.js';
import { createTray } from './tray.js';
import { registerIpcHandlers } from './ipc.js';
import { registerPlaylistsIpc } from './playlists.js';
import {
  registerLyricsHotkey,
  disposeLyrics,
  setLyricsStyle,
  setLyricsLang,
} from '../lyrics/lyrics-window.js';

app.isQuitting = false;

// 开启显卡栅格化和零拷贝以提升渲染性能
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

// 设置页"自定义字体"下拉需要读取系统字体列表（Local Font Access API）；
// 只放行 local-fonts 权限，其余权限维持 Electron 默认拒绝
function setupPermissions() {
  const isLocalFonts = (permission) => permission === 'local-fonts';
  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    isLocalFonts(permission)
  );
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) =>
    callback(isLocalFonts(permission))
  );
}

app.whenReady().then(() => {
  migrateLegacyMusicFolder();
  getLanguage(); // 初始化语言（createTray 依赖 t()）
  // 建窗口前先定下主题来源，否则会先以系统色绘制一帧再翻转
  nativeTheme.themeSource = getThemeMode();
  setupPermissions();
  registerIpcHandlers();
  registerPlaylistsIpc();
  createWindow();
  createTray();
  setLyricsStyle(getLyricsStyle()); // 同步已存歌词样式
  setLyricsLang(getLanguage()); // 同步已存语言
  registerLyricsHotkey();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
  }
});
app.on('activate', () => {
  if (getMainWindow() === null) createWindow();
  else getMainWindow().show();
});
app.on('before-quit', () => {
  app.isQuitting = true;
  disposeLyrics();
});
