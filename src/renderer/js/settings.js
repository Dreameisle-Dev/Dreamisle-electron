import { t, setLang, applyLang } from '../../shared/i18n.js';
import {
  DEFAULT_TASKBAR_LYRICS_STYLE,
  normalizeTaskbarLyricsStyle,
  sanitizeFontFamily,
} from '../../shared/taskbar-style.js';
import { normalizeLyricsStyle } from '../../shared/lyrics-style.js';
import { state, DEFAULT_LYRICS_STYLE } from './state.js';
import {
  audio,
  settingsOverlay,
  btnSettingsClose,
  folderListEl,
  btnAddFolder,
  btnRescanLibrary,
  langSelectWrap,
  langSelectBtn,
  langSelectValue,
  langSelectList,
  bgOpacityInput,
  textOpacityInput,
  textColorInput,
  bgOpacityVal,
  textOpacityVal,
  btnResetStyle,
  desktopLyricsClickThroughSwitch,
  desktopLyricsLinesSeg,
  performanceModeSwitch,
  fontSelectWrap,
  fontSelectBtn,
  fontSelectValue,
  fontSearchInput,
  fontOptions,
  themeSeg,
  taskbarFontSelectWrap,
  taskbarFontSelectBtn,
  taskbarFontSelectValue,
  taskbarFontSearchInput,
  taskbarFontOptions,
  taskbarWeightSeg,
  taskbarAutoColor,
  taskbarAutoColorSwitch,
  taskbarTextColor,
  settingsLibraryBadge,
  desktopLyricsEnabledSwitch,
  taskbarLyricsEnabledSwitch,
  menubarLyricsEnabledSwitch,
  taskbarLyricsStatus,
  folderSummaryEl,
  settingsScroll,
  settingsStage,
  settingsStageTabs,
  desktopLyricsCapsule,
  desktopPreviewLine,
  desktopPreviewNext,
  desktopPreviewCover,
  desktopPreviewStatus,
  desktopCapHint,
  lyricColorDots,
  taskbarPreviewBar,
  taskbarLyricsPreview,
  taskbarPreviewLine,
  taskbarPreviewNext,
  taskbarPreviewCover,
  taskbarPreviewTime,
  btnTaskbarPreviewTone,
  menubarPreviewLine,
  playlistDrawer,
  playlistsDrawer,
} from './dom.js';
import { showSyncToast } from './helpers.js';
import { applyPlaylistFromMain } from './playlist.js';
import { syncLibrary } from './library-sync.js';
import { renderPlaylistsList } from './playlists.js';
import { applyThemeMode } from './theme.js';
import { applyPerformanceMode } from './performance.js';
import { renderEqPresets, syncEqUi } from './equalizer.js';

// 主题分段控件的选中态。'system'/'light'/'dark'，非法值按 system 处理。
function syncThemeSeg(mode) {
  const active = mode === 'light' || mode === 'dark' ? mode : 'system';
  themeSeg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === active);
  });
}

export { syncThemeSeg };

const SETTINGS_PANEL_KEY = 'dreamisle.settings.panel';
const SETTINGS_PANELS = new Set(['general', 'library', 'lyrics', 'equalizer']);
const SETTINGS_SECTIONS = [
  { id: 'general', elId: 'settingsSecGeneral', stage: 'vinyl' },
  { id: 'library', elId: 'settingsSecLibrary', stage: 'vinyl' },
  { id: 'lyrics', elId: 'settingsSecLyrics', stage: 'lyrics' },
  { id: 'equalizer', elId: 'settingsSecEqualizer', stage: 'eq' },
];
let desktopLyricsLines = 1;
let previewSyncTimer = null;
let previewTaskbarLight = null;
let currentStage = 'vinyl';
let scrollSpyLockUntil = 0;

function setSwitchState(el, on) {
  if (!el) return;
  el.classList.toggle('active', !!on);
  el.setAttribute('aria-checked', String(!!on));
}

function setNavActive(panel) {
  document.querySelectorAll('.settings-nav-item').forEach((item) => {
    const active = item.dataset.section === panel;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}

export function setSettingsStage(stage) {
  const next = stage === 'lyrics' || stage === 'eq' ? stage : 'vinyl';
  currentStage = next;
  if (settingsOverlay) settingsOverlay.dataset.stage = next;
  if (settingsStageTabs) {
    settingsStageTabs.querySelectorAll('.stage-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.stage === next);
    });
  }
}

function scrollToSettingsSection(panel, smooth = true) {
  const entry = SETTINGS_SECTIONS.find((s) => s.id === panel);
  const target = entry ? document.getElementById(entry.elId) : null;
  if (!settingsScroll || !target) return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const useSmooth = smooth && !reduceMotion;
  scrollSpyLockUntil = Date.now() + (useSmooth ? 520 : 80);
  const top = target.offsetTop - 12;
  settingsScroll.scrollTo({
    top: Math.max(0, top),
    behavior: useSmooth ? 'smooth' : 'instant',
  });
}

function getSavedSettingsPanel() {
  try {
    const saved = localStorage.getItem(SETTINGS_PANEL_KEY);
    if (saved && SETTINGS_PANELS.has(saved)) return saved;
  } catch (error) {
    // 忽略
  }
  return 'general';
}

function activateSettingsPanel(
  panel,
  { persist = false, scroll = true, smooth = true, syncStage = true } = {}
) {
  const next = SETTINGS_PANELS.has(panel) ? panel : 'general';
  setNavActive(next);
  if (scroll) scrollToSettingsSection(next, smooth);
  if (syncStage) {
    const entry = SETTINGS_SECTIONS.find((s) => s.id === next);
    if (entry) setSettingsStage(entry.stage);
  }
  if (persist) {
    try {
      localStorage.setItem(SETTINGS_PANEL_KEY, next);
    } catch (error) {
      // 存储不可用时不影响设置页
    }
  }
}

function restoreSettingsPanel() {
  activateSettingsPanel(getSavedSettingsPanel(), { scroll: true, smooth: false, syncStage: true });
}

function syncLyricColorDots(color) {
  if (!lyricColorDots) return;
  const target = (color || '').toLowerCase();
  lyricColorDots.querySelectorAll('.lyric-color-dot').forEach((dot) => {
    dot.classList.toggle('active', (dot.dataset.color || '').toLowerCase() === target);
  });
}

function syncDesktopLyricsPreview() {
  if (!desktopLyricsCapsule) return;
  const style = normalizeLyricsStyle(state.currentLyricsStyle);
  desktopLyricsCapsule.style.setProperty('--preview-bg', `rgba(0, 0, 0, ${style.bgOpacity / 100})`);
  desktopLyricsCapsule.style.setProperty('--preview-opacity', String(style.textOpacity / 100));
  desktopLyricsCapsule.style.setProperty('--preview-color', style.textColor);
  desktopLyricsCapsule.style.fontFamily = style.fontFamily ? `"${style.fontFamily}"` : '';
  const enabled = desktopLyricsEnabledSwitch?.getAttribute('aria-checked') === 'true';
  desktopLyricsCapsule.classList.toggle('disabled-stage', !enabled);
  const clickThrough = desktopLyricsClickThroughSwitch?.getAttribute('aria-checked') !== 'false';
  if (desktopCapHint) {
    desktopCapHint.textContent = clickThrough
      ? t('settings.clickThroughShort')
      : t('settings.draggableShort');
  }
  if (desktopPreviewNext) {
    desktopPreviewNext.hidden = desktopLyricsLines !== 2 || !desktopPreviewNext.textContent;
  }
  syncLyricColorDots(style.textColor);
}

function defaultTaskbarPreviewLight() {
  const root = document.documentElement;
  if (root.classList.contains('theme-light')) return true;
  if (root.classList.contains('theme-dark')) return false;
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

function syncTaskbarLyricsPreview() {
  if (!taskbarPreviewLine || !taskbarPreviewNext) return;
  const isAuto = taskbarStyle.textColor === 'auto';
  const resolvedLight =
    previewTaskbarLight === null ? defaultTaskbarPreviewLight() : previewTaskbarLight;
  const useLightBar = isAuto && resolvedLight;
  if (taskbarPreviewBar) {
    taskbarPreviewBar.classList.toggle('light-tb', useLightBar);
  }
  if (btnTaskbarPreviewTone) {
    btnTaskbarPreviewTone.hidden = !isAuto;
    btnTaskbarPreviewTone.textContent = useLightBar
      ? t('settings.taskbarDarkPreview')
      : t('settings.taskbarLightPreview');
  }
  const mainColor = isAuto ? (useLightBar ? '#101010' : '#ffffff') : taskbarStyle.textColor;
  taskbarPreviewLine.style.color = mainColor;
  taskbarPreviewNext.style.color = mainColor;
  taskbarPreviewNext.style.opacity = '0.68';
  const fontFamily = taskbarStyle.fontFamily ? `"${taskbarStyle.fontFamily}"` : '';
  taskbarPreviewLine.style.fontFamily = fontFamily;
  taskbarPreviewNext.style.fontFamily = fontFamily;
  const weight = Number(taskbarStyle.fontWeight) || DEFAULT_TASKBAR_LYRICS_STYLE.fontWeight;
  taskbarPreviewLine.style.fontWeight = String(weight);
  taskbarPreviewNext.style.fontWeight = String(Math.max(400, weight - 100));
  const enabled = taskbarLyricsEnabledSwitch?.getAttribute('aria-checked') === 'true';
  if (taskbarLyricsPreview) {
    taskbarLyricsPreview.classList.toggle('disabled-stage', !enabled);
  }
}

function updateTaskbarLyricsStatus(enabled, running) {
  if (!taskbarLyricsStatus) return;
  taskbarLyricsStatus.hidden = !(enabled && !running);
}

// 按音频当前时间定位歌词行：暂停时 state.currentLineIndex 可能还没更新，
// 预览直接读 currentTime 更准。
function findPreviewLineIndex(lines, timeMs) {
  if (!Array.isArray(lines) || lines.length === 0) return 0;
  if (timeMs < lines[0].time) return 0;
  let low = 0;
  let high = lines.length - 1;
  let result = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lines[mid].time <= timeMs) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

// 预览读取当前播放的歌：有时轴歌词用当前行/译文/下一句；
// 没有歌词时退回歌名/歌手（任务栏歌词本来就是这种兜底）。
function currentPreviewData() {
  const fallback = {
    first: t('settings.previewLine1'),
    second: t('settings.previewLine2'),
    status: t('settings.previewExample'),
  };
  const song = state.songs[state.currentIndex];
  if (!song) return fallback;

  const lines = Array.isArray(state.currentLyrics) ? state.currentLyrics : [];
  const timed = lines.length > 0 && !lines[0]?.isStatic;

  if (!timed) {
    return {
      first: song.title || fallback.first,
      second: song.artist || fallback.second,
      status: t('stats.nowPlaying'),
    };
  }

  const index = findPreviewLineIndex(lines, (audio.currentTime || 0) * 1000);
  const line = lines[index] || {};
  const next = lines[index + 1] || null;
  const first = line.text || line.translation || song.title || fallback.first;
  const translation = state.showLyricsTranslation ? line.translation || '' : '';
  const second = translation || (next ? next.text || next.translation || '' : '');
  return {
    first,
    second,
    status: song.title ? `${t('stats.nowPlaying')} · ${song.title}` : t('stats.nowPlaying'),
  };
}

function syncNowPlayingPreviews() {
  if (!settingsOverlay.classList.contains('open')) return;

  const data = currentPreviewData();
  if (desktopPreviewLine) desktopPreviewLine.textContent = data.first;
  if (desktopPreviewNext) {
    desktopPreviewNext.textContent = data.second;
    desktopPreviewNext.hidden = desktopLyricsLines !== 2 || !data.second;
  }
  if (desktopPreviewStatus) desktopPreviewStatus.textContent = data.status;
  if (taskbarPreviewLine) taskbarPreviewLine.textContent = data.first;
  if (taskbarPreviewNext) {
    taskbarPreviewNext.textContent = data.second;
    taskbarPreviewNext.hidden = !data.second;
  }
  if (menubarPreviewLine) {
    menubarPreviewLine.textContent = `♫ ${data.first}`;
    const menubarOn = menubarLyricsEnabledSwitch?.getAttribute('aria-checked') === 'true';
    menubarPreviewLine.classList.toggle('disabled-stage', !menubarOn);
  }
  if (taskbarPreviewTime) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const dateStr = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
    const timeEl = taskbarPreviewTime.querySelector('.tb-clock-hhmm');
    const dateEl = taskbarPreviewTime.querySelector('.tb-clock-date');
    if (timeEl) timeEl.textContent = `${hh}:${mm}`;
    if (dateEl) dateEl.textContent = dateStr;
  }

  const coverUrl = state.currentCoverBlobUrl || '';
  for (const image of [desktopPreviewCover, taskbarPreviewCover]) {
    if (!image) continue;
    if (coverUrl) {
      if (image.getAttribute('src') !== coverUrl) image.src = coverUrl;
      image.hidden = false;
    } else {
      image.removeAttribute('src');
      image.hidden = true;
    }
  }
}

function startPreviewSync() {
  stopPreviewSync();
  syncNowPlayingPreviews();
  previewSyncTimer = setInterval(syncNowPlayingPreviews, 500);
}

function stopPreviewSync() {
  clearInterval(previewSyncTimer);
  previewSyncTimer = null;
}

export function toggleSettings() {
  if (settingsOverlay.classList.contains('open')) closeSettings();
  else openSettings();
}

export async function openSettings() {
  if (playlistDrawer) playlistDrawer.classList.remove('open');
  if (playlistsDrawer) playlistsDrawer.classList.remove('open');
  document.body.classList.add('settings-open');
  settingsOverlay.classList.add('open');
  restoreSettingsPanel();
  startPreviewSync();
  await refreshSettingsUi();
  // 文件夹列表与预设渲染完成后重校准一次滚动锚点，避免高度变化导致定位偏移
  if (settingsOverlay.classList.contains('open')) {
    scrollToSettingsSection(getSavedSettingsPanel(), false);
  }
}

export function closeSettings() {
  document.body.classList.remove('settings-open');
  settingsOverlay.classList.remove('open');
  stopPreviewSync();
}

// 打开时同步主进程中的设置到控件
export async function refreshSettingsUi() {
  const settings = await window.dreamApi.getSettings();
  const lang = settings.language || 'zh-CN';
  langSelectList.querySelectorAll('.lang-select-option').forEach((item) => {
    const selected = item.dataset.value === lang;
    item.classList.toggle('selected', selected);
    if (selected) langSelectValue.textContent = item.textContent;
  });
  renderFolderList(settings.musicFolders || []);
  // 文件夹树按设置的根目录组织，根目录增删后同步刷新左侧抽屉
  state.musicFolders = (settings.musicFolders || []).map((folder) => folder.path);
  renderPlaylistsList();

  desktopLyricsLines = settings.desktopLyricsLines === 2 ? 2 : 1;

  syncLyricsStyleUi(settings.lyricsStyle || DEFAULT_LYRICS_STYLE);
  const clickThrough = settings.desktopLyricsClickThrough !== false;
  desktopLyricsClickThroughSwitch.classList.toggle('active', clickThrough);
  desktopLyricsClickThroughSwitch.setAttribute('aria-checked', String(clickThrough));
  desktopLyricsLinesSeg.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.lines) === desktopLyricsLines);
  });
  syncTaskbarLyricsStyleUi(settings.taskbarLyricsStyle || DEFAULT_TASKBAR_LYRICS_STYLE);

  setSwitchState(desktopLyricsEnabledSwitch, settings.desktopLyricsVisible === true);
  setSwitchState(taskbarLyricsEnabledSwitch, settings.taskbarLyricsEnabled === true);
  setSwitchState(menubarLyricsEnabledSwitch, settings.menubarLyricsEnabled === true);
  syncDesktopLyricsPreview();
  syncTaskbarLyricsPreview();
  updateTaskbarLyricsStatus(
    settings.taskbarLyricsEnabled === true,
    settings.taskbarLyricsRunning === true
  );
  if (settingsLibraryBadge) {
    settingsLibraryBadge.hidden = !(settings.musicFolders || []).some(
      (folder) => !folder.available
    );
  }

  syncThemeSeg(settings.themeMode);
  performanceModeSwitch.classList.toggle('active', settings.performanceMode === true);
  performanceModeSwitch.setAttribute('aria-checked', String(settings.performanceMode === true));
  // 均衡器状态在渲染进程里（state.equalizer 是唯一真源，主进程只负责存），
  // 这里只重建跟随语言的文案：预设胶囊名、当前曲线、前级读数
  renderEqPresets();
  syncEqUi();
  syncNowPlayingPreviews();
}

export function renderFolderList(folders) {
  folderListEl.innerHTML = '';
  if (folderSummaryEl) {
    folderSummaryEl.textContent = t('settings.folderSummary', {
      total: folders.length,
      unavailable: folders.filter((folder) => !folder.available).length,
    });
  }
  if (!folders.length) {
    const empty = document.createElement('li');
    empty.className = 'folder-empty';
    empty.textContent = t('settings.noFolders');
    folderListEl.appendChild(empty);
    return;
  }
  for (const folder of folders) {
    const li = document.createElement('li');
    li.className = 'folder-item';

    const status = document.createElement('span');
    status.className = 'folder-status' + (folder.available ? '' : ' warn');
    li.appendChild(status);

    const span = document.createElement('span');
    span.className = 'folder-path' + (folder.available ? '' : ' unavailable');
    span.textContent = folder.path + (folder.available ? '' : t('settings.folderUnavailable'));
    li.appendChild(span);

    const btn = document.createElement('button');
    btn.className = 'folder-remove';
    btn.textContent = '✕';
    btn.title = t('settings.removeFolder');
    btn.onclick = () => handleRemoveFolder(folder.path);
    li.appendChild(btn);

    folderListEl.appendChild(li);
  }
}

export async function handleAddFolder() {
  const res = await window.dreamApi.addFolder();
  if (!res) return;
  if (res.duplicate) {
    showSyncToast(t('folders.duplicate'));
    return;
  }
  if (res.playlist && res.playlist.length > 0) {
    applyPlaylistFromMain(res.playlist);
  }
  renderPlaylistsList(); // 曲库变了，歌单抽屉的「全部歌曲」数量要跟着走
  refreshSettingsUi();
}

export async function handleRemoveFolder(folderPath) {
  const res = await window.dreamApi.removeFolder(folderPath);
  if (res && res.playlist) {
    applyPlaylistFromMain(res.playlist);
  }
  renderPlaylistsList(); // 同上
  refreshSettingsUi();
}

// 手动重新扫描曲库。扫描期间禁用按钮：主进程是串行解析新文件的，
// 大曲库要几秒到几十秒，不禁用会被连点。
export async function handleRescanLibrary() {
  if (!btnRescanLibrary || btnRescanLibrary.disabled) return;

  btnRescanLibrary.disabled = true;
  btnRescanLibrary.textContent = t('settings.rescanning');
  try {
    await syncLibrary({ manual: true });
  } finally {
    // 文案按当前语言取回，而不是记住点击前的字符串 —— 扫描期间可能切了语言
    btnRescanLibrary.disabled = false;
    btnRescanLibrary.textContent = t('settings.rescan');
  }
}

export async function handleLanguageChange(lang) {
  setLang(lang);
  applyLang();
  // applyLang 只管静态文案；当前歌曲的歌手/标题要显式补回来（空库则回等待文案）
  window.dispatchEvent(new CustomEvent('dreamisle:language-changed'));
  await window.dreamApi.setLanguage(lang);
  refreshSettingsUi(); // 重建动态行（文件夹列表/移除按钮标题），跟随新语言
  renderPlaylistsList(); // 歌单抽屉动态文案跟随语言
}

export function syncLyricsStyleUi(style) {
  state.currentLyricsStyle = normalizeLyricsStyle(style);
  bgOpacityInput.value = state.currentLyricsStyle.bgOpacity;
  textOpacityInput.value = state.currentLyricsStyle.textOpacity;
  textColorInput.value = state.currentLyricsStyle.textColor;
  bgOpacityVal.textContent = `${state.currentLyricsStyle.bgOpacity}%`;
  textOpacityVal.textContent = `${state.currentLyricsStyle.textOpacity}%`;
  bgOpacityInput.style.setProperty('--progress', `${state.currentLyricsStyle.bgOpacity}%`);
  textOpacityInput.style.setProperty('--progress', `${state.currentLyricsStyle.textOpacity}%`);
  // 按钮上直接以所选字体渲染当前字体名，空值显示"默认字体"
  fontSelectValue.textContent = state.currentLyricsStyle.fontFamily || t('settings.fontDefault');
  fontSelectValue.style.fontFamily = state.currentLyricsStyle.fontFamily
    ? `"${state.currentLyricsStyle.fontFamily}"`
    : '';
  syncDesktopLyricsPreview();
}

export function pushLyricsStyle() {
  syncDesktopLyricsPreview();
  window.dreamApi.setLyricsStyle(state.currentLyricsStyle);
}

// ── 任务栏歌词外观（独立于桌面歌词） ──
let taskbarStyle = { ...DEFAULT_TASKBAR_LYRICS_STYLE };
// 记住上次的自定义颜色：切到“跟随任务栏”再切回来时不要丢
let lastTaskbarCustomColor = '#ffffff';

export function syncTaskbarLyricsStyleUi(style) {
  taskbarStyle = normalizeTaskbarLyricsStyle(style);
  taskbarFontSelectValue.textContent = taskbarStyle.fontFamily || t('settings.fontDefault');
  taskbarFontSelectValue.style.fontFamily = taskbarStyle.fontFamily
    ? `"${taskbarStyle.fontFamily}"`
    : '';
  taskbarWeightSeg.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.weight) === taskbarStyle.fontWeight);
  });
  const auto = taskbarStyle.textColor === 'auto';
  if (!auto) lastTaskbarCustomColor = taskbarStyle.textColor;
  taskbarAutoColor.checked = auto;
  taskbarTextColor.disabled = auto;
  taskbarTextColor.value = auto ? lastTaskbarCustomColor : taskbarStyle.textColor;
  setSwitchState(taskbarAutoColorSwitch, auto);
  syncTaskbarLyricsPreview();
}

export function pushTaskbarLyricsStyle() {
  syncTaskbarLyricsPreview();
  window.dreamApi
    .setTaskbarLyricsStyle(taskbarStyle)
    .then((next) => {
      if (next) syncTaskbarLyricsStyleUi(next);
    })
    .catch(() => {});
}

// 系统字体列表：首次展开下拉时通过 Local Font Access API 读取并缓存
export async function ensureSystemFonts() {
  if (state.systemFonts || state.fontsLoadFailed) return;
  try {
    if (typeof window.queryLocalFonts !== 'function') throw new Error('unsupported');
    const all = await window.queryLocalFonts(); // 必须在用户手势内同步发起，由点击事件直接调用
    const seen = new Set();
    state.systemFonts = [];
    for (const font of all) {
      if (!seen.has(font.family)) {
        seen.add(font.family);
        state.systemFonts.push(font.family);
      }
    }
    state.systemFonts.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch (err) {
    state.fontsLoadFailed = true;
    showSyncToast(t('settings.fontLoadError'));
  }
}

// 字体下拉的通用渲染：桌面歌词与任务栏歌词各用一套 DOM 和回调。
function renderFontOptionsInto({ optionsEl, valueEl, wrapEl, selectedFamily, onSelect, filter }) {
  optionsEl.innerHTML = '';
  const query = (filter || '').trim().toLowerCase();

  const makeOption = (family, label, ownFont) => {
    const safeFamily = sanitizeFontFamily(family);
    const li = document.createElement('li');
    li.className = 'font-select-option';
    if (ownFont && safeFamily) li.style.fontFamily = `"${safeFamily}"`;
    li.textContent = label;
    li.dataset.value = safeFamily;
    if (safeFamily === (selectedFamily || '')) li.classList.add('selected');
    li.addEventListener('click', () => {
      valueEl.textContent = label;
      valueEl.style.fontFamily = ownFont && safeFamily ? `"${safeFamily}"` : '';
      wrapEl.classList.remove('open');
      onSelect(safeFamily);
    });
    optionsEl.appendChild(li);
  };

  // 首项固定为默认字体，不参与搜索过滤
  makeOption('', t('settings.fontDefault'), false);
  for (const family of state.systemFonts) {
    if (query && !family.toLowerCase().includes(query)) continue;
    makeOption(family, family, true);
  }
}

export function renderFontOptions(filter = '') {
  renderFontOptionsInto({
    optionsEl: fontOptions,
    valueEl: fontSelectValue,
    wrapEl: fontSelectWrap,
    selectedFamily: state.currentLyricsStyle.fontFamily,
    onSelect: (family) => {
      state.currentLyricsStyle.fontFamily = family;
      pushLyricsStyle();
    },
    filter,
  });
}

function renderTaskbarFontOptions(filter = '') {
  renderFontOptionsInto({
    optionsEl: taskbarFontOptions,
    valueEl: taskbarFontSelectValue,
    wrapEl: taskbarFontSelectWrap,
    selectedFamily: taskbarStyle.fontFamily,
    onSelect: (family) => {
      taskbarStyle.fontFamily = family;
      pushTaskbarLyricsStyle();
    },
    filter,
  });
}

function ensureDropdownVisible(wrapEl) {
  if (!settingsScroll || !wrapEl) return;
  requestAnimationFrame(() => {
    const listEl = wrapEl.querySelector('.font-select-list');
    if (!listEl) return;
    const overflow =
      listEl.getBoundingClientRect().bottom - settingsScroll.getBoundingClientRect().bottom;
    if (overflow > 0) {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      settingsScroll.scrollTo({
        top: settingsScroll.scrollTop + overflow + 14,
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    }
  });
}

export function bindSettingsEvents() {
  themeSeg.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      syncThemeSeg(mode);
      applyThemeMode(mode);
      syncTaskbarLyricsPreview();
      setSettingsStage('vinyl');
      window.dreamApi.setThemeMode(mode).catch(() => {});
    });
  });

  bgOpacityInput.addEventListener('input', () => {
    state.currentLyricsStyle.bgOpacity = Number(bgOpacityInput.value);
    bgOpacityVal.textContent = `${state.currentLyricsStyle.bgOpacity}%`;
    bgOpacityInput.style.setProperty('--progress', `${state.currentLyricsStyle.bgOpacity}%`);
    pushLyricsStyle();
  });

  textOpacityInput.addEventListener('input', () => {
    state.currentLyricsStyle.textOpacity = Number(textOpacityInput.value);
    textOpacityVal.textContent = `${state.currentLyricsStyle.textOpacity}%`;
    textOpacityInput.style.setProperty('--progress', `${state.currentLyricsStyle.textOpacity}%`);
    pushLyricsStyle();
  });

  textColorInput.addEventListener('input', () => {
    state.currentLyricsStyle.textColor = textColorInput.value;
    pushLyricsStyle();
  });

  if (lyricColorDots) {
    lyricColorDots.querySelectorAll('.lyric-color-dot').forEach((dot) => {
      dot.addEventListener('click', () => {
        const color = dot.dataset.color;
        if (!color) return;
        state.currentLyricsStyle.textColor = color;
        textColorInput.value = color;
        pushLyricsStyle();
      });
    });
  }

  btnResetStyle.addEventListener('click', () => {
    syncLyricsStyleUi(DEFAULT_LYRICS_STYLE);
    pushLyricsStyle();
  });

  desktopLyricsClickThroughSwitch.addEventListener('click', () => {
    const next = !desktopLyricsClickThroughSwitch.classList.contains('active');
    desktopLyricsClickThroughSwitch.classList.toggle('active', next);
    desktopLyricsClickThroughSwitch.setAttribute('aria-checked', String(next));
    syncDesktopLyricsPreview();
    window.dreamApi.setDesktopLyricsClickThrough(next).catch(() => {});
  });

  performanceModeSwitch.addEventListener('click', () => {
    const next = !performanceModeSwitch.classList.contains('active');
    performanceModeSwitch.classList.toggle('active', next);
    performanceModeSwitch.setAttribute('aria-checked', String(next));
    applyPerformanceMode(next); // 立即生效，不等主进程落盘
    setSettingsStage('vinyl');
    window.dreamApi.setPerformanceMode(next).catch(() => {});
  });

  desktopLyricsLinesSeg.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lines = Number(btn.dataset.lines) === 2 ? 2 : 1;
      desktopLyricsLines = lines;
      desktopLyricsLinesSeg.querySelectorAll('button').forEach((item) => {
        item.classList.toggle('active', Number(item.dataset.lines) === lines);
      });
      syncDesktopLyricsPreview();
      window.dreamApi.setDesktopLyricsLines(lines).catch(() => {});
    });
  });

  // 三个歌词开关：桌面是运行态，任务栏/菜单栏是持久化偏好
  desktopLyricsEnabledSwitch.addEventListener('click', async () => {
    const next = desktopLyricsEnabledSwitch.getAttribute('aria-checked') !== 'true';
    setSwitchState(desktopLyricsEnabledSwitch, next);
    syncDesktopLyricsPreview();
    try {
      const visible = await window.dreamApi.setDesktopLyricsEnabled(next);
      setSwitchState(desktopLyricsEnabledSwitch, visible === true);
      syncDesktopLyricsPreview();
    } catch (error) {
      setSwitchState(desktopLyricsEnabledSwitch, !next);
      syncDesktopLyricsPreview();
    }
  });

  taskbarLyricsEnabledSwitch.addEventListener('click', async () => {
    const next = taskbarLyricsEnabledSwitch.getAttribute('aria-checked') !== 'true';
    setSwitchState(taskbarLyricsEnabledSwitch, next);
    syncTaskbarLyricsPreview();
    try {
      const result = await window.dreamApi.setTaskbarLyricsEnabled(next);
      const enabled = !!(result && result.enabled);
      setSwitchState(taskbarLyricsEnabledSwitch, enabled);
      syncTaskbarLyricsPreview();
      updateTaskbarLyricsStatus(enabled, !!(result && result.running));
    } catch (error) {
      setSwitchState(taskbarLyricsEnabledSwitch, !next);
      syncTaskbarLyricsPreview();
    }
  });

  menubarLyricsEnabledSwitch.addEventListener('click', async () => {
    const next = menubarLyricsEnabledSwitch.getAttribute('aria-checked') !== 'true';
    setSwitchState(menubarLyricsEnabledSwitch, next);
    syncNowPlayingPreviews();
    try {
      const enabled = await window.dreamApi.setMenubarLyricsEnabled(next);
      setSwitchState(menubarLyricsEnabledSwitch, enabled === true);
      syncNowPlayingPreviews();
    } catch (error) {
      setSwitchState(menubarLyricsEnabledSwitch, !next);
      syncNowPlayingPreviews();
    }
  });

  if (btnTaskbarPreviewTone) {
    btnTaskbarPreviewTone.addEventListener('click', () => {
      const current =
        previewTaskbarLight === null ? defaultTaskbarPreviewLight() : previewTaskbarLight;
      previewTaskbarLight = !current;
      syncTaskbarLyricsPreview();
    });
  }

  // 可见开关驱动隐藏的 checkbox，沿用已有的自动颜色逻辑
  taskbarAutoColorSwitch.addEventListener('click', () => {
    taskbarAutoColor.checked = taskbarAutoColorSwitch.getAttribute('aria-checked') !== 'true';
    taskbarAutoColor.dispatchEvent(new Event('change'));
  });

  langSelectBtn.addEventListener('click', () => {
    langSelectWrap.classList.toggle('open');
  });

  langSelectList.querySelectorAll('.lang-select-option').forEach((item) => {
    item.addEventListener('click', () => {
      langSelectValue.textContent = item.textContent;
      langSelectWrap.classList.remove('open');
      handleLanguageChange(item.dataset.value);
    });
  });

  fontSelectBtn.addEventListener('click', async () => {
    const willOpen = !fontSelectWrap.classList.contains('open');
    fontSelectWrap.classList.toggle('open');
    if (!willOpen) return;
    await ensureSystemFonts(); // 读取失败时仅提示，不展开列表
    if (state.fontsLoadFailed) {
      fontSelectWrap.classList.remove('open');
      return;
    }
    fontSearchInput.value = '';
    renderFontOptions();
    ensureDropdownVisible(fontSelectWrap);
    fontSearchInput.focus();
  });

  fontSearchInput.addEventListener('input', () => renderFontOptions(fontSearchInput.value));

  // 顶部锚点导航：平滑滚到对应分区并联动右侧舞台预览
  document.querySelectorAll('.settings-nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      activateSettingsPanel(item.dataset.section, { persist: true, scroll: true, syncStage: true });
    });
  });

  // 单页滚动时自动高亮当前所在分区的锚点胶囊
  if (settingsScroll) {
    settingsScroll.addEventListener('scroll', () => {
      if (Date.now() < scrollSpyLockUntil) return;
      const atBottom =
        settingsScroll.scrollTop + settingsScroll.clientHeight >= settingsScroll.scrollHeight - 12;
      let activeId = atBottom ? 'equalizer' : 'general';
      if (!atBottom) {
        const threshold = settingsScroll.scrollTop + 44;
        for (const sec of SETTINGS_SECTIONS) {
          const el = document.getElementById(sec.elId);
          if (el && el.offsetTop <= threshold) activeId = sec.id;
        }
      }
      setNavActive(activeId);
    });
  }

  // 右侧舞台手动切换（活黑胶 / 歌词实景 / 声学曲线）
  if (settingsStageTabs) {
    settingsStageTabs.querySelectorAll('.stage-tab').forEach((btn) => {
      btn.addEventListener('click', () => setSettingsStage(btn.dataset.stage));
    });
  }

  // 在歌词或均衡器区块里操作控件时，自动切到对应的右侧实时预览舞台
  const lyricsSec = document.getElementById('settingsSecLyrics');
  if (lyricsSec) {
    const showLyricsStage = () => {
      if (currentStage !== 'lyrics') setSettingsStage('lyrics');
    };
    lyricsSec.addEventListener('pointerdown', showLyricsStage);
    lyricsSec.addEventListener('input', showLyricsStage);
  }
  const eqSec = document.getElementById('settingsSecEqualizer');
  if (eqSec) {
    const showEqStage = () => {
      if (currentStage !== 'eq') setSettingsStage('eq');
    };
    eqSec.addEventListener('pointerdown', showEqStage);
    eqSec.addEventListener('input', showEqStage);
  }

  // ── 任务栏歌词外观 ──
  taskbarFontSelectBtn.addEventListener('click', async () => {
    const willOpen = !taskbarFontSelectWrap.classList.contains('open');
    taskbarFontSelectWrap.classList.toggle('open');
    if (!willOpen) return;
    await ensureSystemFonts();
    if (state.fontsLoadFailed) {
      taskbarFontSelectWrap.classList.remove('open');
      return;
    }
    taskbarFontSearchInput.value = '';
    renderTaskbarFontOptions();
    ensureDropdownVisible(taskbarFontSelectWrap);
    taskbarFontSearchInput.focus();
  });

  taskbarFontSearchInput.addEventListener('input', () =>
    renderTaskbarFontOptions(taskbarFontSearchInput.value)
  );

  taskbarWeightSeg.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      taskbarStyle.fontWeight = Number(btn.dataset.weight);
      syncTaskbarLyricsStyleUi(taskbarStyle);
      pushTaskbarLyricsStyle();
    });
  });

  taskbarAutoColor.addEventListener('change', () => {
    taskbarStyle.textColor = taskbarAutoColor.checked ? 'auto' : lastTaskbarCustomColor;
    syncTaskbarLyricsStyleUi(taskbarStyle);
    pushTaskbarLyricsStyle();
  });

  taskbarTextColor.addEventListener('input', () => {
    if (taskbarAutoColor.checked) return;
    lastTaskbarCustomColor = taskbarTextColor.value;
    taskbarStyle.textColor = taskbarTextColor.value;
    pushTaskbarLyricsStyle();
  });

  if (btnSettingsClose) btnSettingsClose.onclick = closeSettings;
  settingsOverlay.addEventListener('click', (e) => {
    if (
      e.target === settingsOverlay ||
      e.target === settingsStage ||
      (e.target.classList && e.target.classList.contains('settings-stage-hud'))
    ) {
      closeSettings(); // 点击右侧空白舞台收起控制中心
      return;
    }
    // 点下拉外部收起（语言、桌面歌词字体、任务栏歌词字体）
    if (!langSelectWrap.contains(e.target)) langSelectWrap.classList.remove('open');
    if (!fontSelectWrap.contains(e.target)) fontSelectWrap.classList.remove('open');
    if (!taskbarFontSelectWrap.contains(e.target)) taskbarFontSelectWrap.classList.remove('open');
  });
  if (btnAddFolder) btnAddFolder.onclick = handleAddFolder;
  if (btnRescanLibrary) btnRescanLibrary.onclick = handleRescanLibrary;
}
