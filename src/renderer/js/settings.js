import { t, setLang, applyLang } from '../../shared/i18n.js';
import { state, DEFAULT_LYRICS_STYLE } from './state.js';
import {
  settingsOverlay,
  btnSettingsClose,
  folderListEl,
  btnAddFolder,
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
  fontSelectWrap,
  fontSelectBtn,
  fontSelectValue,
  fontSearchInput,
  fontOptions,
} from './dom.js';
import { showSyncToast } from './helpers.js';
import { applyPlaylistFromMain } from './playlist.js';

export function toggleSettings() {
  if (settingsOverlay.classList.contains('open')) closeSettings();
  else openSettings();
}

export function openSettings() {
  settingsOverlay.classList.add('open');
  refreshSettingsUi();
}

export function closeSettings() {
  settingsOverlay.classList.remove('open');
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
  syncLyricsStyleUi(settings.lyricsStyle || DEFAULT_LYRICS_STYLE);
}

export function renderFolderList(folders) {
  folderListEl.innerHTML = '';
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
  refreshSettingsUi();
}

export async function handleRemoveFolder(folderPath) {
  const res = await window.dreamApi.removeFolder(folderPath);
  if (res && res.playlist) {
    applyPlaylistFromMain(res.playlist);
  }
  refreshSettingsUi();
}

export async function handleLanguageChange(lang) {
  setLang(lang);
  applyLang();
  await window.dreamApi.setLanguage(lang);
  refreshSettingsUi(); // 重建动态行（文件夹列表/移除按钮标题），跟随新语言
}

export function syncLyricsStyleUi(style) {
  state.currentLyricsStyle = { ...DEFAULT_LYRICS_STYLE, ...style };
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
}

export function pushLyricsStyle() {
  window.dreamApi.setLyricsStyle(state.currentLyricsStyle);
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

export function renderFontOptions(filter = '') {
  fontOptions.innerHTML = '';
  const query = filter.trim().toLowerCase();

  const makeOption = (family, label, ownFont) => {
    const li = document.createElement('li');
    li.className = 'font-select-option';
    if (ownFont) li.style.fontFamily = `"${family}"`;
    li.textContent = label;
    li.dataset.value = family;
    if (family === (state.currentLyricsStyle.fontFamily || '')) li.classList.add('selected');
    li.addEventListener('click', () => {
      state.currentLyricsStyle.fontFamily = family;
      fontSelectValue.textContent = label;
      fontSelectValue.style.fontFamily = ownFont ? `"${family}"` : '';
      fontSelectWrap.classList.remove('open');
      pushLyricsStyle();
    });
    fontOptions.appendChild(li);
  };

  // 首项固定为默认字体，不参与搜索过滤
  makeOption('', t('settings.fontDefault'), false);
  for (const family of state.systemFonts) {
    if (query && !family.toLowerCase().includes(query)) continue;
    makeOption(family, family, true);
  }
}

export function bindSettingsEvents() {
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

  btnResetStyle.addEventListener('click', () => {
    syncLyricsStyleUi(DEFAULT_LYRICS_STYLE);
    pushLyricsStyle();
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
    fontSearchInput.focus();
  });

  fontSearchInput.addEventListener('input', () => renderFontOptions(fontSearchInput.value));

  // 左侧导航切换设置分区（面板互斥显示）
  document.querySelectorAll('.settings-nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document
        .querySelectorAll('.settings-nav-item')
        .forEach((n) => n.classList.toggle('active', n === item));
      document
        .querySelectorAll('.settings-panel')
        .forEach((p) => p.classList.toggle('active', p.dataset.panel === item.dataset.section));
    });
  });

  if (btnSettingsClose) btnSettingsClose.onclick = closeSettings;
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay)
      closeSettings(); // 点击卡片外部遮罩关闭
    else if (!langSelectWrap.contains(e.target)) langSelectWrap.classList.remove('open'); // 点下拉外部收起
  });
  if (btnAddFolder) btnAddFolder.onclick = handleAddFolder;
}
