import { app } from 'electron';
import Store from 'electron-store';
import { setLang as i18nSetLang } from '../shared/i18n.js';
import { normalizeEq } from '../shared/equalizer.js';

// 主进程持久化配置的唯一入口：electron-store 实例与设置读写集中于此
export const store = new Store();

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
