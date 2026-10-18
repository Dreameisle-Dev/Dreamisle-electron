import { app, dialog } from 'electron';
import path from 'path';
import Store from 'electron-store';
import { setLang as i18nSetLang, t } from '../shared/i18n.js';
import { normalizeEq } from '../shared/equalizer.js';
import { openStoreWithRecovery } from './store-recovery.js';

// electron-store 的默认落盘位置：userData 下的 config.json（name 默认 'config'）。
// 兜底逻辑要拿这个路径去备份坏文件，所以这里显式算一遍。
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

// 主进程持久化配置的唯一入口：electron-store 实例与设置读写集中于此
function initStore() {
  try {
    return openStoreWithRecovery({
      configPath: CONFIG_PATH,
      createStore: (options) => new Store(options),
    });
  } catch (error) {
    // 连重建都失败（目录不可写之类）就没法继续了：音乐库、歌单、设置全依赖配置文件。
    // 但也不能像以前那样无声无息地死掉——至少在退出前说清楚为什么。
    // 此时 store 不可用，语言只能按系统区域判断。
    const zh = app.getLocale().startsWith('zh');
    dialog.showErrorBox(
      zh ? '音梦屿无法启动' : 'Dreamisle cannot start',
      zh
        ? `无法读写配置文件：\n${CONFIG_PATH}\n\n${error.message}`
        : `Cannot read or write the settings file:\n${CONFIG_PATH}\n\n${error.message}`
    );
    app.exit(1);
    throw error; // app.exit 会立即结束进程，这行只是让「此后无 store」这件事显式化
  }
}

export const storeRecovery = initStore();
export const store = storeRecovery.store;

// 配置被重置过就得让用户知道备份在哪——静默重置等于把他的歌单和统计偷偷丢掉。
// 在主窗口建好之后调用（弹窗挂在窗口上，且此时语言已经初始化）。
export function notifyStoreRecovery(parentWindow) {
  if (!storeRecovery.recovered) return;
  dialog.showMessageBox(parentWindow, {
    type: 'warning',
    title: t('store.corruptTitle'),
    message: t('store.corruptTitle'),
    detail: storeRecovery.backupPath
      ? t('store.corruptDetail', { path: storeRecovery.backupPath })
      : t('store.corruptDetailNoBackup'),
    buttons: [t('common.close')],
    noLink: true,
  });
}

export const DEFAULT_LYRICS_STYLE = {
  bgOpacity: 45,
  textOpacity: 100,
  textColor: '#ffffff',
  fontFamily: '',
};

// 语言状态：默认跟随系统，用户可在设置中切换
let currentLanguage = null;

export function getMusicFolders() {
  return store.get('musicFolders') || [];
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

export function getLyricsStyle() {
  return { ...DEFAULT_LYRICS_STYLE, ...(store.get('settings.lyricsStyle') || {}) };
}

export function getLyricsTranslation() {
  return store.get('settings.lyricsTranslation') !== false; // 默认开启
}

// 任务栏歌词：默认关闭，开启后主进程会在任务栏里嵌入歌词条窗口
export function getTaskbarLyricsSetting() {
  return store.get('settings.taskbarLyrics') === true;
}

export function setTaskbarLyricsSetting(enabled) {
  store.set('settings.taskbarLyrics', !!enabled);
  return !!enabled;
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

export function clampPercent(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// 旧版单文件夹配置迁移为文件夹列表
export function migrateLegacyMusicFolder() {
  const legacy = store.get('musicFolder');
  if (legacy && !store.has('musicFolders')) {
    store.set('musicFolders', [legacy]);
    store.delete('musicFolder');
  }
}
