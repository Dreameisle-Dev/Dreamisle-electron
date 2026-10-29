import { app, globalShortcut, session, nativeTheme } from 'electron';
import {
  migrateLegacyMusicFolder,
  getLanguage,
  getLyricsStyle,
  getTaskbarLyricsSetting,
  getThemeMode,
  notifyStoreRecovery,
} from './store.js';
import { createWindow, getMainWindow } from './window.js';
import { createTray, rebuildTrayMenu } from './tray.js';
import { registerIpcHandlers } from './ipc.js';
import { registerPlaylistsIpc } from './playlists.js';
import {
  registerLyricsHotkey,
  disposeLyrics,
  setLyricsStyle,
  setLyricsLang,
} from '../lyrics/lyrics-window.js';
import {
  initTaskbarLyrics,
  disposeTaskbarLyrics,
  setTaskbarLyricsEnabled,
} from '../taskbar/taskbar-lyrics.js';
import { isRightAltOrCtrlDown } from '../taskbar/taskbar-win32.js';
import { logTaskbar } from '../taskbar/taskbar-log.js';

// 全局开关任务栏歌词。注意 Electron 的 globalShortcut 不能区分左右 Ctrl/Alt：
// 在把 AltGr 映射成 Ctrl+Alt 的键盘布局上，AltGr+T 也可能触发这个组合。
// 注册失败（被其他程序占用）只能记日志，设置页开关和托盘菜单仍然可用。
const TASKBAR_LYRICS_HOTKEY = 'Control+Alt+T';

function registerTaskbarLyricsHotkey() {
  const ok = globalShortcut.register(TASKBAR_LYRICS_HOTKEY, () => {
    // AltGr 在多数布局上等价于右侧 Ctrl+Alt；右侧修饰键按下时不响应，
    // 只让真正的左 Ctrl+左 Alt+T 生效（Electron 本身不区分左右）。
    if (isRightAltOrCtrlDown()) return;
    const next = !getTaskbarLyricsSetting();
    logTaskbar('taskbar lyrics hotkey fired', { enabled: next });
    setTaskbarLyricsEnabled(next);
    // 设置页开关由主进程的 taskbar-lyrics:changed 事件同步；
    // 托盘勾选状态在菜单构建时读取，必须重建一次。
    rebuildTrayMenu();
  });
  if (!ok) {
    console.warn(
      `[Dreamisle] 全局快捷键 ${TASKBAR_LYRICS_HOTKEY} 注册失败，可能已被其他程序占用；设置页/托盘仍可切换`
    );
    // 打包后看不到 console；热键被占用时用户会以为“开了没反应”，
    // 日志里必须留下这个原因，托盘菜单仍然可以开关。
    logTaskbar('taskbar lyrics hotkey registration failed', {
      accelerator: TASKBAR_LYRICS_HOTKEY,
    });
  }
}

app.isQuitting = false;
app.setAppUserModelId('org.dreamisle-dev.dreamisle');

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
  initTaskbarLyrics();
  notifyStoreRecovery(getMainWindow()); // 配置被重置过就告知用户备份位置
  createTray();
  setLyricsStyle(getLyricsStyle()); // 同步已存歌词样式
  setLyricsLang(getLanguage()); // 同步已存语言
  registerLyricsHotkey();
  registerTaskbarLyricsHotkey();
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
  globalShortcut.unregister(TASKBAR_LYRICS_HOTKEY);
  disposeLyrics();
  disposeTaskbarLyrics();
});
