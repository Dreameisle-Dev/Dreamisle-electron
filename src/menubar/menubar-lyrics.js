// macOS 菜单栏歌词：把当前歌词行显示在状态栏托盘图标旁。
//
// 菜单栏由系统独占绘制，无法像 Windows 任务栏那样嵌入自定义歌词条窗口；
// Tray.setTitle 是唯一稳定的入口，文字颜色/字号跟随系统明暗自动适配。
// 数据源复用桌面歌词的文本推送（渲染进程换行时发来），所以暂停/跳转/切歌
// 与桌面歌词完全同步，主进程不需要再维护一份播放时钟。

import { globalShortcut } from 'electron';
import { getMenubarLyricsSetting, setMenubarLyricsSetting } from '../main/store.js';
import {
  getTrayTitle,
  registerMenubarLyricsControls,
  rebuildTrayMenu,
  setTrayTitle,
} from '../main/tray.js';

// 菜单栏空间有限：过长会挤掉系统状态图标，按字符截断（CJK 与英文都按码点计）。
const MAX_TITLE_CHARS = 30;
// 与 Windows 任务栏歌词的 Ctrl+Alt+T 对应：macOS 上 Ctrl→Command、Alt→Option。
const MENUBAR_LYRICS_HOTKEY = 'Command+Alt+T';

let enabled = false;
// 最近一次歌词行文本（与桌面歌词同源）
let lastText = '';
let lastDoc = null;
let lastApplied = null;

function isDarwin() {
  return process.platform === 'darwin';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function ellipsize(text) {
  const chars = Array.from(text);
  return chars.length > MAX_TITLE_CHARS
    ? `${chars.slice(0, MAX_TITLE_CHARS).join('')}…`
    : text;
}

// 没有（或只有静态）歌词时用歌名/歌手占位，避免开关打开了却什么都不显示。
// 有时间轴的歌词在播放前/间奏的空行由渲染进程推空串，此时保持空白而不是刷歌名。
function fallbackTitle() {
  if (!lastDoc?.songPath) return '';
  const noTimedLyrics =
    lastDoc.isStatic || !Array.isArray(lastDoc.lines) || lastDoc.lines.length === 0;
  if (!noTimedLyrics) return '';

  const title = normalizeText(lastDoc.title);
  const artist = normalizeText(lastDoc.artist);
  if (title && artist) return `${title} - ${artist}`;
  return title || artist;
}

function applyTitle() {
  if (!isDarwin()) return;

  const title = enabled ? ellipsize(lastText || fallbackTitle()) : '';
  // Tray 可能比本模块初始化晚（--no-tray 时则始终没有）；顺带用真实标题做一次对齐
  if (title === lastApplied && title === getTrayTitle()) return;
  lastApplied = title;
  setTrayTitle(title);
}

export function isMenubarLyricsEnabled() {
  return isDarwin() && getMenubarLyricsSetting();
}

// 开关只改偏好并立即生效；非 macOS 上不写设置。
export function setMenubarLyricsEnabled(value) {
  if (!isDarwin()) return false;
  const next = !!value;
  setMenubarLyricsSetting(next);
  enabled = next;
  applyTitle();
  return next;
}

// 渲染进程在歌词换行时推送当前行（与桌面歌词同一份文本）
export function updateMenubarLyricsText(text) {
  lastText = normalizeText(text);
  if (enabled) applyTitle();
}

// 歌词文档：用于无歌词时显示歌名/歌手，以及判断是否为静态歌词
export function updateMenubarLyricsDocument(doc) {
  lastDoc = doc || null;
  if (enabled) applyTitle();
}

// 快捷键与 Windows 侧同键位：切换持久化偏好，并同步托盘勾选态
function toggleFromHotkey() {
  const next = !getMenubarLyricsSetting();
  setMenubarLyricsEnabled(next);
  rebuildTrayMenu();
}

export function initMenubarLyrics() {
  if (!isDarwin()) return;

  // 托盘菜单里的勾选项在每次 rebuildTrayMenu 时读取这里注册的状态
  registerMenubarLyricsControls({
    isEnabled: isMenubarLyricsEnabled,
    setEnabled: setMenubarLyricsEnabled,
  });
  rebuildTrayMenu(); // 托盘已在 createTray 里建好，这里补上菜单项
  enabled = getMenubarLyricsSetting();
  applyTitle();

  const ok = globalShortcut.register(MENUBAR_LYRICS_HOTKEY, toggleFromHotkey);
  if (!ok) {
    console.warn(
      `[Dreamisle] 全局快捷键 ${MENUBAR_LYRICS_HOTKEY} 注册失败，可能已被其他程序占用；设置页/托盘仍可切换`
    );
  }
}

export function disposeMenubarLyrics() {
  if (!isDarwin()) return;
  globalShortcut.unregister(MENUBAR_LYRICS_HOTKEY);
  enabled = false;
  lastApplied = '';
  setTrayTitle('');
}
