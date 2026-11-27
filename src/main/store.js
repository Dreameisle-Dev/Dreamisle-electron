import { app, dialog } from 'electron';
import path from 'path';
import { setLang as i18nSetLang, t } from '../shared/i18n.js';
import { normalizeEq } from '../shared/equalizer.js';
import { normalizeTaskbarLyricsStyle } from '../shared/taskbar-style.js';
import {
  DEFAULT_LYRICS_STYLE,
  clampPercent,
  normalizeLyricsStyle,
} from '../shared/lyrics-style.js';
import { openStoreWithRecovery } from './store-recovery.js';
import { JsonStore } from './json-store.js';

// 配置文件默认落盘位置：userData 下的 config.json（与原 electron-store 保持一致）。
// 惰性初始化：避免在 app.requestSingleInstanceLock() 之前就读盘，让二次唤起实例零磁盘开销退出。
let storeRecoveryState = null;
let exitHookBound = false;

function ensureStoreRecovery() {
  if (storeRecoveryState) return storeRecoveryState;
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    storeRecoveryState = openStoreWithRecovery({
      configPath,
      createStore: (options) => new JsonStore({ configPath, ...(options || {}) }),
    });
    if (!exitHookBound) {
      exitHookBound = true;
      process.on('exit', () => {
        storeRecoveryState?.store?.flushSync();
      });
    }
    return storeRecoveryState;
  } catch (error) {
    // 连重建都失败（目录不可写之类）就没法继续了：音乐库、歌单、设置全依赖配置文件。
    // 但也不能像以前那样无声无息地死掉——至少在退出前说清楚为什么。
    // 此时 store 不可用，语言只能按系统区域判断。
    const zh = app.getLocale().startsWith('zh');
    dialog.showErrorBox(
      zh ? '音梦屿无法启动' : 'Dreamisle cannot start',
      zh
        ? `无法读写配置文件：\n${configPath}\n\n${error.message}`
        : `Cannot read or write the settings file:\n${configPath}\n\n${error.message}`
    );
    app.exit(1);
    throw error; // app.exit 会立即结束进程，这行只是让「此后无 store」这件事显式化
  }
}

export const store = {
  get(key, defaultValue) {
    return ensureStoreRecovery().store.get(key, defaultValue);
  },
  has(key) {
    return ensureStoreRecovery().store.has(key);
  },
  set(keyOrObject, value) {
    return ensureStoreRecovery().store.set(keyOrObject, value);
  },
  delete(key) {
    return ensureStoreRecovery().store.delete(key);
  },
  flushSync() {
    storeRecoveryState?.store?.flushSync();
  },
};

export function flushStoreSync() {
  store.flushSync();
}

// 配置被重置过就得让用户知道备份在哪——静默重置等于把他的歌单和统计偷偷丢掉。
// 在主窗口建好之后调用（弹窗挂在窗口上，且此时语言已经初始化）。
export function notifyStoreRecovery(parentWindow) {
  const recovery = ensureStoreRecovery();
  if (!recovery.recovered) return;
  dialog.showMessageBox(parentWindow, {
    type: 'warning',
    title: t('store.corruptTitle'),
    message: t('store.corruptTitle'),
    detail: recovery.backupPath
      ? t('store.corruptDetail', { path: recovery.backupPath })
      : t('store.corruptDetailNoBackup'),
    buttons: [t('common.close')],
    noLink: true,
  });
}

export { DEFAULT_LYRICS_STYLE, clampPercent };

// 语言状态：默认跟随系统，用户可在设置中切换
let currentLanguage = null;

export function getMusicFolders() {
  const raw = store.get('musicFolders');
  return Array.isArray(raw) ? raw.filter((p) => typeof p === 'string' && p.length > 0) : [];
}

export function getLanguage() {
  if (!currentLanguage) {
    const stored = store.get('settings.language');
    currentLanguage = stored || (app.getLocale().startsWith('zh') ? 'zh-CN' : 'en');
    i18nSetLang(currentLanguage);
  }
  return currentLanguage;
}

export function applyLanguage(lang) {
  currentLanguage = lang;
  i18nSetLang(lang);
  store.set('settings.language', lang);
}

// 主题模式：'system' | 'light' | 'dark'。取值非法一律回落到跟随系统。
export function getThemeMode() {
  const stored = store.get('settings.themeMode');
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export function setThemeMode(mode) {
  const next = mode === 'light' || mode === 'dark' ? mode : 'system';
  store.set('settings.themeMode', next);
  return next;
}

// 性能模式：关闭背景模糊、光场/唱片/频谱动画等持续合成开销，默认关闭。
export function getPerformanceMode() {
  return store.get('settings.performanceMode') === true;
}

export function setPerformanceMode(enabled) {
  store.set('settings.performanceMode', !!enabled);
  return !!enabled;
}

export function getLyricsStyle() {
  return normalizeLyricsStyle(store.get('settings.lyricsStyle'));
}

export function setLyricsStyleSetting(raw) {
  const next = normalizeLyricsStyle(raw);
  store.set('settings.lyricsStyle', next);
  return next;
}

export function getLyricsTranslation() {
  return store.get('settings.lyricsTranslation') !== false; // 默认开启
}

// 桌面歌词鼠标穿透：默认开启，点击会穿过悬浮窗；关闭后才能拖动调整位置
export function getDesktopLyricsClickThrough() {
  return store.get('settings.desktopLyricsClickThrough') !== false;
}

export function setDesktopLyricsClickThrough(enabled) {
  store.set('settings.desktopLyricsClickThrough', !!enabled);
  return !!enabled;
}

// 桌面歌词显示行数：1 = 单行，2 = 当前行 + 下一行；默认单行
export function getDesktopLyricsLines() {
  return store.get('settings.desktopLyricsLines') === 2 ? 2 : 1;
}

export function setDesktopLyricsLines(lines) {
  const next = lines === 2 ? 2 : 1;
  store.set('settings.desktopLyricsLines', next);
  return next;
}

// 任务栏歌词：默认关闭，开启后主进程会在任务栏里嵌入歌词条窗口
export function getTaskbarLyricsSetting() {
  return store.get('settings.taskbarLyrics') === true;
}

export function setTaskbarLyricsSetting(enabled) {
  store.set('settings.taskbarLyrics', !!enabled);
  return !!enabled;
}

// 播放队列快照：跨重启恢复当前播放队列。配置可能被手改，
// 读取和写入都归一化，只保留可播放的字段并限制长度。
const MAX_PLAY_QUEUE_LENGTH = 1000;
const VALID_SORT_MODES = new Set(['title', 'artist', 'random', 'custom', 'album']);

function normalizeQueueEntry(song) {
  if (!song || typeof song !== 'object' || typeof song.path !== 'string' || !song.path) return null;
  const entry = {
    path: song.path,
    title: typeof song.title === 'string' ? song.title : '',
    artist: typeof song.artist === 'string' ? song.artist : '',
    url: typeof song.url === 'string' ? song.url : '',
  };
  if (song.path.startsWith('dream-track://')) {
    entry.source = 'plugin';
    if (typeof song.pluginId === 'string') entry.pluginId = song.pluginId;
    if (typeof song.trackId === 'string') entry.trackId = song.trackId;
    if (typeof song.album === 'string') entry.album = song.album;
    if (Number.isFinite(song.duration)) entry.duration = song.duration;
    if (typeof song.artworkUrl === 'string') entry.artworkUrl = song.artworkUrl;
    if (song.pluginMeta && typeof song.pluginMeta === 'object' && !Array.isArray(song.pluginMeta)) {
      entry.pluginMeta = song.pluginMeta;
    }
  }
  return entry;
}

function normalizeActiveQueue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'library' || raw.type === 'custom') {
    return { type: raw.type };
  }
  if (
    raw.type === 'playlist' &&
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    raw.id.length <= 256
  ) {
    return { type: 'playlist', id: raw.id };
  }
  if (
    raw.type === 'folder' &&
    typeof raw.path === 'string' &&
    raw.path.length > 0 &&
    raw.path.length <= 4096
  ) {
    return { type: 'folder', path: raw.path };
  }
  if (
    raw.type === 'album' &&
    typeof raw.key === 'string' &&
    raw.key.length > 0 &&
    raw.key.length <= 512
  ) {
    return { type: 'album', key: raw.key };
  }
  return null;
}

function normalizeQueueMeta(raw) {
  if (!raw || typeof raw !== 'object') return { activeQueue: null, sortMode: null };
  return {
    activeQueue: normalizeActiveQueue(raw.activeQueue),
    sortMode:
      typeof raw.sortMode === 'string' && VALID_SORT_MODES.has(raw.sortMode) ? raw.sortMode : null,
  };
}

export function getPlayQueue() {
  const raw = store.get('playQueue');
  const songs = Array.isArray(raw)
    ? raw.map(normalizeQueueEntry).filter(Boolean).slice(0, MAX_PLAY_QUEUE_LENGTH)
    : [];
  const meta = normalizeQueueMeta(store.get('playQueueMeta'));
  return { songs, activeQueue: meta.activeQueue, sortMode: meta.sortMode };
}

export function setPlayQueue(queue) {
  const isObj = queue && !Array.isArray(queue) && typeof queue === 'object';
  const rawList = isObj ? queue.songs : queue;
  const list = Array.isArray(rawList) ? rawList : [];
  const entries = list.map(normalizeQueueEntry).filter(Boolean).slice(0, MAX_PLAY_QUEUE_LENGTH);
  store.set({
    playQueue: entries,
    playQueueMeta: isObj ? normalizeQueueMeta(queue) : undefined,
  });
}

// 菜单栏歌词：macOS 专属，默认关闭；开启后在托盘图标旁显示当前歌词行。
export function getMenubarLyricsSetting() {
  return store.get('settings.menubarLyrics') === true;
}

export function setMenubarLyricsSetting(enabled) {
  store.set('settings.menubarLyrics', !!enabled);
  return !!enabled;
}

// 任务栏歌词外观：{ fontFamily, fontWeight, textColor }。读写两侧都归一化，
// 防止配置文件被手改后把非法字重/颜色灌进渲染进程。
export function getTaskbarLyricsStyle() {
  return normalizeTaskbarLyricsStyle(store.get('settings.taskbarLyricsStyle'));
}

export function setTaskbarLyricsStyle(raw) {
  const next = normalizeTaskbarLyricsStyle(raw);
  store.set('settings.taskbarLyricsStyle', next);
  return next;
}

export function setLyricsTranslation(visible) {
  store.set('settings.lyricsTranslation', !!visible);
}

// 均衡器配置：{ enabled, gains: number[10] }。
// 读写两侧都过一遍 normalizeEq —— store 是 JSON 文件，可能被手改坏，
// 界面上宁可少一个频段的设置，也不能把 NaN 灌进 BiquadFilter。
export function getEqualizer() {
  return normalizeEq(store.get('settings.equalizer'));
}

export function setEqualizer(raw) {
  const next = normalizeEq(raw);
  store.set('settings.equalizer', next);
  return next;
}

// 旧版单文件夹配置迁移为文件夹列表
export function migrateLegacyMusicFolder() {
  const legacy = store.get('musicFolder');
  if (legacy && !store.has('musicFolders')) {
    store.set('musicFolders', [legacy]);
    store.delete('musicFolder');
  }
}

// ── 插件生态状态与配置（启停状态、各插件自身声明的非敏感配置） ──

export function getPluginEnabledIds() {
  const raw = store.get('plugins.enabled');
  return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && id.length > 0) : [];
}

export function setPluginEnabledId(pluginId, enabled) {
  if (typeof pluginId !== 'string' || !pluginId) return getPluginEnabledIds();
  const set = new Set(getPluginEnabledIds());
  if (enabled) set.add(pluginId);
  else set.delete(pluginId);
  const next = [...set];
  store.set('plugins.enabled', next);
  return next;
}

export function getPluginStoredConfig(pluginId) {
  if (typeof pluginId !== 'string' || !pluginId) return {};
  const all = store.get('plugins.configs');
  if (!all || typeof all !== 'object' || Array.isArray(all)) return {};
  const cfg = all[pluginId];
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? { ...cfg } : {};
}

export function setPluginStoredConfig(pluginId, configObj) {
  if (typeof pluginId !== 'string' || !pluginId) return {};
  const rawAll = store.get('plugins.configs');
  const all = rawAll && typeof rawAll === 'object' && !Array.isArray(rawAll) ? { ...rawAll } : {};
  all[pluginId] =
    configObj && typeof configObj === 'object' && !Array.isArray(configObj) ? { ...configObj } : {};
  store.set('plugins.configs', all);
  return all[pluginId];
}

export function clearPluginStoredState(pluginId) {
  if (typeof pluginId !== 'string' || !pluginId) return;
  setPluginEnabledId(pluginId, false);
  const rawAll = store.get('plugins.configs');
  if (
    rawAll &&
    typeof rawAll === 'object' &&
    !Array.isArray(rawAll) &&
    Object.hasOwn(rawAll, pluginId)
  ) {
    const next = { ...rawAll };
    delete next[pluginId];
    store.set('plugins.configs', next);
  }
}
