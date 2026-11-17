// 桌面歌词外观：背景/文字不透明度、文字颜色、字体。主进程与渲染进程共用，防止配置或 IPC 注入非法 CSS 值。
import { sanitizeFontFamily } from './taskbar-style.js';

export const DEFAULT_LYRICS_STYLE = {
  bgOpacity: 45,
  textOpacity: 100,
  textColor: '#ffffff',
  fontFamily: '',
};

export function clampPercent(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function normalizeHexColor(value) {
  if (typeof value !== 'string') return DEFAULT_LYRICS_STYLE.textColor;
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : DEFAULT_LYRICS_STYLE.textColor;
}

export function normalizeLyricsStyle(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    bgOpacity: clampPercent(source.bgOpacity, DEFAULT_LYRICS_STYLE.bgOpacity),
    textOpacity: clampPercent(source.textOpacity, DEFAULT_LYRICS_STYLE.textOpacity),
    textColor: normalizeHexColor(source.textColor),
    fontFamily: sanitizeFontFamily(source.fontFamily),
  };
}
