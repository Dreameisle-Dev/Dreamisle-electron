import { resolveRestoredIndex } from './playback-restore.js';
import { t, setLang, applyLang } from '../i18n.js';

const audio = document.getElementById('audioPlayer');
const playlistDrawer = document.getElementById('playlistDrawer');
const playlistEl = document.getElementById('playlist');
const playlistCountEl = document.getElementById('playlistCount');
const searchInput = document.getElementById('searchInput');

const coverContainer = document.getElementById('coverContainer');
const coverImg = document.getElementById('coverImg');
const defaultCover = document.getElementById('defaultCover');
const lyricsContainer = document.getElementById('lyricsContainer');
const lyricsScroll = document.getElementById('lyricsScroll');
const volumeHud = document.getElementById('volumeHud');

const titleEl = document.getElementById('songTitle');
const artistEl = document.getElementById('artistName');
const progressBar = document.getElementById('progressBar');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const canvas = document.getElementById('colorCanvas');

const btnPlay = document.getElementById('btnPlay');
const btnMode = document.getElementById('btnMode');
const btnPlaylist = document.getElementById('btnPlaylist');

const iconLoop = document.getElementById('iconLoop');
const iconOne = document.getElementById('iconOne');
const iconShuffle = document.getElementById('iconShuffle');

// 排序交互节点
const btnSortDefault = document.getElementById('sortDefault');
const btnSortTitle = document.getElementById('sortTitle');
const btnSortArtist = document.getElementById('sortArtist');
const btnSortRandom = document.getElementById('sortRandom');

// 设置浮层元素
const settingsOverlay = document.getElementById('settingsOverlay');
const btnSettingsClose = document.getElementById('btnSettingsClose');
const folderListEl = document.getElementById('folderList');
const btnAddFolder = document.getElementById('btnAddFolder');
const langSelectWrap = document.getElementById('langSelectWrap');
const langSelectBtn = document.getElementById('langSelectBtn');
const langSelectValue = document.getElementById('langSelectValue');
const langSelectList = document.getElementById('langSelectList');
const bgOpacityInput = document.getElementById('bgOpacity');
const textOpacityInput = document.getElementById('textOpacity');
const textColorInput = document.getElementById('textColor');
const bgOpacityVal = document.getElementById('bgOpacityVal');
const textOpacityVal = document.getElementById('textOpacityVal');
const btnResetStyle = document.getElementById('btnResetStyle');
const fontSelectWrap = document.getElementById('fontSelectWrap');
const fontSelectBtn = document.getElementById('fontSelectBtn');
const fontSelectValue = document.getElementById('fontSelectValue');
const fontSearchInput = document.getElementById('fontSearch');
const fontOptions = document.getElementById('fontOptions');

const DEFAULT_LYRICS_STYLE = { bgOpacity: 45, textOpacity: 100, textColor: '#ffffff', fontFamily: '' };
let currentLyricsStyle = { ...DEFAULT_LYRICS_STYLE };

// 小窗单行歌词元素
const miniLyricsEl = document.getElementById('miniLyrics');

// 帮助浮层元素
const helpOverlayEl = document.getElementById('helpOverlay');
const btnHelpClose = document.getElementById('btnHelpClose');
const helpVersionEl = document.getElementById('helpVersion');

let originalSongs = []; // 保存最原始物理读取顺序的备份
let songs = [];
let currentIndex = -1;
let isDragging = false;
let playMode = 0;
let volumeTimeout;

let currentLyrics = [];
let currentLineIndex = -1;
let lyricDoms = []; 
let lastDesktopText = null; // 去重：仅在实际变化时向主进程推送桌面歌词

let mouseX = 50, mouseY = 50;
let targetMouseX = 50, targetMouseY = 50;
let isAnimating = false;
let isUserScrolling = false;
let userScrollTimeout = null;

let currentCoverBlobUrl = null;

// 同步提示 toast
const syncToastEl = document.getElementById('syncToast');
let syncToastTimer = null;

const ITEM_HEIGHT = 62;
let filteredSongs = [];
let vsStartIndex = 0;
let vsEndIndex = 0;

// 窗口模式追踪
let isMiniMode = false;

audio.volume = 0.5;

window.addEventListener('DOMContentLoaded', async () => {
  // 启动时应用已存语言并刷新界面文案
  const settings = await window.dreamApi.getSettings();
  setLang(settings.language);
  applyLang();
  volumeHud.innerText = t('hud.volume', { n: Math.round(audio.volume * 100) });

  initMouseFollow();

  // 检测当前系统并添加类标识
  const platform = window.dreamApi.getPlatform();
  document.body.classList.add(`platform-${platform}`);

  // 绑定自绘标题栏按钮点击事件
  const btnMin = document.getElementById('btnMin');
  const btnMax = document.getElementById('btnMax');
  const btnClose = document.getElementById('btnClose');

  if (btnMin) btnMin.onclick = () => window.dreamApi.minimizeWindow();
  if (btnMax) btnMax.onclick = () => window.dreamApi.maximizeWindow();
  if (btnClose) btnClose.onclick = () => window.dreamApi.closeWindow();

  // 绑定帮助浮层关闭交互
  if (btnHelpClose) btnHelpClose.onclick = closeHelp;
  helpOverlayEl.addEventListener('click', (e) => {
    if (e.target === helpOverlayEl) closeHelp(); // 点击卡片外部遮罩关闭
  });

  if (btnSettingsClose) btnSettingsClose.onclick = closeSettings;
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettings(); // 点击卡片外部遮罩关闭
    else if (!langSelectWrap.contains(e.target)) langSelectWrap.classList.remove('open'); // 点下拉外部收起
  });
  if (btnAddFolder) btnAddFolder.onclick = handleAddFolder;

  // 绑定键盘快捷键
  let altTimer = null;
  window.addEventListener('keydown', (e) => {
    const isInputActive = document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA';

    // F5：独立于输入框外，任何时候均允许切换窗口模式
    if (e.key === 'F5') {
      e.preventDefault();
      window.dreamApi.toggleMiniMode();
      return;
    }

    // Ctrl+,：打开/关闭设置（无论焦点位置）
    if (e.ctrlKey && e.code === 'Comma') {
      e.preventDefault();
      toggleSettings();
      return;
    }

    // Esc：先关设置浮层，再关帮助浮层（无论焦点位置）
    if (e.code === 'Escape') {
      if (settingsOverlay.classList.contains('open')) {
        e.preventDefault();
        closeSettings();
      } else if (helpOverlayEl.classList.contains('open')) {
        e.preventDefault();
        closeHelp();
      }
      return;
    }

    // 焦点位于搜索框或输入框时，屏蔽以下快捷键
    if (isInputActive) return;

    // Space：播放/暂停
    if (e.code === 'Space') {
      e.preventDefault();
      btnPlay.click();
    }

    // Q：上一首
    if (e.code === 'KeyQ') {
      e.preventDefault();
      document.getElementById('btnPrev').click();
    }

    // E：下一首
    if (e.code === 'KeyE') {
      e.preventDefault();
      document.getElementById('btnNext').click();
    }

    // R：切换播放模式
    if (e.code === 'KeyR') {
      e.preventDefault();
      btnMode.click();
    }

    // H：打开/关闭帮助浮层
    if (e.code === 'KeyH') {
      e.preventDefault();
      toggleHelp();
    }

    // LeftALT：长按 0.5s 呼出/折叠播放列表
    if (e.code === 'AltLeft') {
      e.preventDefault();
      if (e.repeat) return; // 屏蔽自动重复
      
      altTimer = setTimeout(() => {
        playlistDrawer.classList.toggle('open');
        altTimer = null;
      }, 500);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'AltLeft') {
      e.preventDefault();
      if (altTimer) {
        clearTimeout(altTimer);
        altTimer = null;
      }
    }
  });

  // 监听窗口模式更改通知
  window.dreamApi.onWindowModeChanged((mode) => {
    if (mode === 'mini') {
      isMiniMode = true;
      document.body.classList.add('mini-mode');
    } else {
      isMiniMode = false;
      document.body.classList.remove('mini-mode');
    }
    updateProgressStyle(progressBar.value);
  });
  
  const savedSongs = await window.dreamApi.loadSavedMusic();

  if (savedSongs && savedSongs.length > 0) {
    originalSongs = [...savedSongs]; // 备份原始数据
    songs = [...savedSongs];
    searchInput.value = '';
    initVirtualList(); 

    const savedState = await window.dreamApi.loadPlaybackState();
    const restoredIndex = resolveRestoredIndex(songs, savedState);
    if (restoredIndex >= 0) {
      currentIndex = restoredIndex;
      playMode = savedState.playMode || 0;
      audio.volume = savedState.volume || 0.5;

      iconLoop.style.display = playMode === 0 ? 'block' : 'none';
      iconOne.style.display = playMode === 1 ? 'block' : 'none';
      iconShuffle.style.display = playMode === 2 ? 'block' : 'none';

      initSongInfo(currentIndex);

      if (savedState.currentTime > 0) audio.currentTime = savedState.currentTime;
      if (savedState.isPlaying) {
        audio.play();
        updatePlayButton(true);
      }
    } else {
      if (songs.length > 0) initSongInfo(0);
    }
  } else {
    // 首次启动（未配置任何音乐文件夹）：弹一次添加文件夹对话框
    const settings = await window.dreamApi.getSettings();
    if (!settings.musicFolders || settings.musicFolders.length === 0) {
      const res = await window.dreamApi.addFolder();
      if (res && res.playlist && res.playlist.length > 0) {
        applyPlaylistFromMain(res.playlist);
        playSong(0);
      }
    }
  }

  setupIpcListeners();
  updateProgressStyle(0);

  // 播放恢复完成后，后台同步文件夹新增/删除的歌曲
  applyFolderSync().catch(() => { });
});

function initVirtualList(filterText = '') {
  const lowerFilter = filterText.toLowerCase();
  filteredSongs = filterText
    ? songs.map((s, i) => ({ ...s, originalIndex: i })).filter(s => s.title.toLowerCase().includes(lowerFilter) || s.artist.toLowerCase().includes(lowerFilter))
    : songs.map((s, i) => ({ ...s, originalIndex: i }));

  playlistCountEl.innerText = t('playlist.count', { n: filteredSongs.length });

  vsStartIndex = -1; 
  updateVirtualList();
}

function updateVirtualList() {
  const scrollTop = playlistEl.scrollTop;
  const viewportHeight = playlistEl.clientHeight || 800;
  
  const newStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 5);
  const newEnd = Math.min(filteredSongs.length, Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + 5);

  if (newStart === vsStartIndex && newEnd === vsEndIndex && playlistEl.children.length > 0) return;

  vsStartIndex = newStart;
  vsEndIndex = newEnd;

  let spacer = document.getElementById('playlistSpacer');
  if (!spacer) {
    spacer = document.createElement('div');
    spacer.id = 'playlistSpacer';
  }
  spacer.style.height = `${filteredSongs.length * ITEM_HEIGHT}px`;
  spacer.style.width = '100%';

  playlistEl.innerHTML = '';
  playlistEl.appendChild(spacer);

  const fragment = document.createDocumentFragment();
  for (let i = vsStartIndex; i < vsEndIndex; i++) {
    const songInfo = filteredSongs[i];
    const li = document.createElement('li');
    li.className = `playlist-item ${songInfo.originalIndex === currentIndex ? 'active' : ''}`;
    
    li.style.top = '10px'; 
    li.style.transform = `translateY(${i * ITEM_HEIGHT}px)`;
    
    li.innerHTML = `<div class="item-title">${songInfo.title}</div><div class="item-artist">${songInfo.artist}</div>`;
    li.onclick = () => playSong(songInfo.originalIndex);
    fragment.appendChild(li);
  }
  playlistEl.appendChild(fragment);
}

playlistEl.addEventListener('scroll', updateVirtualList);
searchInput.addEventListener('input', (e) => initVirtualList(e.target.value.trim()));

lyricsScroll.addEventListener('wheel', () => {
  isUserScrolling = true;
  clearTimeout(userScrollTimeout);
  userScrollTimeout = setTimeout(() => {
    isUserScrolling = false;
    if (currentLineIndex !== -1 && lyricDoms[currentLineIndex]) {
      const activeLine = lyricDoms[currentLineIndex];
      lyricsScroll.scrollTop = activeLine.offsetTop - lyricsContainer.clientHeight / 2 + activeLine.clientHeight / 2;
    }
  }, 3000);
});

function updateProgressStyle(value) {
  progressBar.style.setProperty('--progress', `${value}%`);
  
  if (isMiniMode) {
    progressBar.style.background = `linear-gradient(to right, 
      rgba(255,255,255,0.4) 0%, 
      rgba(255,255,255,0.3) ${value}%, 
      rgba(255,255,255,0.05) ${value}%
    )`;
  } else {
    progressBar.style.background = `linear-gradient(to right, 
      rgba(255,255,255,0.9) 0%, 
      rgba(255,255,255,0.6) ${value}%, 
      rgba(255,255,255,0.1) ${value}%
    )`;
  }
}

function initMouseFollow() {
  const ambientBg = document.querySelector('.ambient-bg');
  
  document.addEventListener('mousemove', (e) => {
    targetMouseX = (e.clientX / window.innerWidth) * 100;
    targetMouseY = (e.clientY / window.innerHeight) * 100;
    if (!isAnimating) {
      isAnimating = true;
      requestAnimationFrame(animateMouseFollow);
    }
  });

  function animateMouseFollow() {
    const dx = targetMouseX - mouseX;
    const dy = targetMouseY - mouseY;

    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
      isAnimating = false;
      return;
    }

    mouseX += dx * 0.05;
    mouseY += dy * 0.05;

    if (ambientBg) {
      ambientBg.style.setProperty('--mouse-x', `${mouseX}%`);
      ambientBg.style.setProperty('--mouse-y', `${mouseY}%`);
    }
    
    const lightField = document.querySelector('.light-field');
    if (lightField) {
      const offsetX = (mouseX - 50) * 0.15;
      const offsetY = (mouseY - 50) * 0.15;
      // 将缩放值改为固定的 scale(5)，保证暂停状态下背景灯光依然铺满全屏
      lightField.style.transform = `translate3d(${offsetX}%, ${offsetY}%, 0) scale(5)`;
    }

    if (isAnimating) requestAnimationFrame(animateMouseFollow);
  }
}

function initSongInfo(index) {
  if (index < 0 || index >= songs.length) return;
  currentIndex = index;
  const song = songs[index];
  audio.src = song.url;

  titleEl.innerText = song.title;
  artistEl.innerText = song.artist;
  updateVirtualList(); 

  updateCoverAndColor(song);
  loadAndRenderLyrics(song);
}

function playSong(index) {
  if (index < 0 || index >= songs.length) return;
  currentIndex = index;
  const song = songs[index];

  audio.src = song.url;
  audio.play();

  const infoContainer = document.querySelector('.song-info');
  infoContainer.classList.add('changing');

  setTimeout(() => {
    titleEl.innerText = song.title;
    artistEl.innerText = song.artist;
    infoContainer.classList.remove('changing');
  }, 300);

  updatePlayButton(true);
  
  vsStartIndex = -1;
  updateVirtualList();

  updateCoverAndColor(song);
  loadAndRenderLyrics(song);

  saveStateOnChange();
}

function playNext(auto = false) {
  if (songs.length === 0) return;
  if (auto && playMode === 1) {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  let next = playMode === 2
    ? Math.floor(Math.random() * songs.length)
    : (currentIndex + 1) % songs.length;
  playSong(next);
}

async function updateCoverAndColor(song) {
  coverImg.style.display = 'none';
  defaultCover.style.display = 'flex';
  updateThemeColor(null);

  if (currentCoverBlobUrl) {
    URL.revokeObjectURL(currentCoverBlobUrl);
    currentCoverBlobUrl = null;
  }

  const coverUrl = await window.dreamApi.getCover(song.path);
  if (coverUrl) {
    currentCoverBlobUrl = coverUrl;
    coverImg.src = coverUrl;
    coverImg.style.display = 'block';
    defaultCover.style.display = 'none';
    updateThemeColor(coverUrl);
  }
}

function parseLrc(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return [];
  const lines = lrcText.split(/\r\n|\r|\n/);

  const timeExp = /\[(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\]/g;
  let hasTimestamps = false;
  const result = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const matches = [...trimmedLine.matchAll(timeExp)];

    if (matches.length > 0) {
      hasTimestamps = true;
      const text = trimmedLine.replace(/\[\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?\]/g, '').trim();

      if (text) {
        for (const match of matches) {
          const min = parseInt(match[1]);
          const sec = parseInt(match[2]);
          const ms = match[3] ? parseFloat("0." + match[3]) : 0;
          const time = min * 60 + sec + ms;
          result.push({ time, text });
        }
      }
    }
  }

  if (!hasTimestamps && lines.length > 0) {
    return lines
      .map(line => line.trim())
      .filter(line => line.length > 0 && !/^\[.*?\]$/.test(line))
      .map(text => ({ time: 0, text, isStatic: true }));
  }

  result.sort((a, b) => a.time - b.time);
  return result;
}

function groupTranslations(lyricsArray) {
  if (!lyricsArray || lyricsArray.length === 0 || lyricsArray[0].isStatic) return lyricsArray;
  
  const tempMap = new Map();
  for (const item of lyricsArray) {
    const timeKey = item.time.toFixed(2);
    if (tempMap.has(timeKey)) {
      tempMap.set(timeKey, tempMap.get(timeKey) + '\n' + item.text);
    } else {
      tempMap.set(timeKey, item.text);
    }
  }
  
  const result = Array.from(tempMap.entries()).map(([time, text]) => ({
    time: parseFloat(time),
    text
  }));
  result.sort((a, b) => a.time - b.time);
  return result;
}

function escapeHtml(unsafe) {
  return unsafe
       .replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&#039;");
}

async function loadAndRenderLyrics(song) {
  currentLineIndex = -1;
  currentLyrics = [];
  lastDesktopText = null;
  pushDesktopLyrics("");
  if (miniLyricsEl) miniLyricsEl.innerText = ""; // 切换歌曲时首先清空单行歌词

  if (lyricsScroll) {
    lyricsScroll.innerHTML = `<p class="lyric-line placeholder">${t('lyrics.loading')}</p>`;
    lyricsScroll.scrollTop = 0;
  }

  let lrcData = await window.dreamApi.getLyrics(song.path);

  if (lrcData) {
    if (typeof lrcData === 'object' && lrcData !== null) {
      if (Array.isArray(lrcData.syncText) && lrcData.syncText.length > 0) {
        currentLyrics = lrcData.syncText.map(item => ({ time: item.timestamp / 1000, text: item.text || '' }));
        currentLyrics.sort((a, b) => a.time - b.time);
      } else if (typeof lrcData.text === 'string') {
        currentLyrics = parseLrc(lrcData.text);
      } else if (lrcData.type === 'Buffer') {
        try { currentLyrics = parseLrc(new TextDecoder().decode(new Uint8Array(lrcData.data))); } catch (e) { }
      }
    } else if (typeof lrcData === 'string') {
      currentLyrics = parseLrc(lrcData);
    }
  }

  if (currentLyrics && currentLyrics.length > 0) {
    currentLyrics = groupTranslations(currentLyrics);
    // 统一过滤掉空白行，防止在不同歌词来源下，渲染列表与数据列表因空白行产生索引错位
    currentLyrics = currentLyrics.filter(line => line.text && line.text.trim() !== '');
  }

  renderLyricsToDom();
}

function renderLyricsToDom() {
  if (!lyricsScroll) return;
  lyricsScroll.innerHTML = '';
  lyricDoms = []; 

  if (currentLyrics && currentLyrics.length > 0) {
    const fragment = document.createDocumentFragment();
    const isStatic = currentLyrics[0].isStatic;

    currentLyrics.forEach((line, index) => {
      const p = document.createElement('p');
      p.className = 'lyric-line';
      p.dataset.index = index;

      const textParts = line.text.split('\n').map(escapeHtml);
      if (textParts.length > 1) {
        p.innerHTML = `${textParts[0]}<br><span style="font-size: 0.8em; opacity: 0.75; margin-top: 6px; display: inline-block; font-weight: 400;">${textParts.slice(1).join('<br>')}</span>`;
      } else {
        p.innerText = line.text;
      }

      if (!isStatic) {
        p.onclick = () => {
          audio.currentTime = line.time;
          if (audio.paused) { audio.play(); updatePlayButton(true); }
        };
      } else {
        p.style.cursor = 'default'; p.style.opacity = '0.9'; p.style.margin = '8px 0';
      }
      fragment.appendChild(p);
      lyricDoms.push(p); 
    });
    lyricsScroll.appendChild(fragment);
  } else {
    lyricsScroll.innerHTML = `<p class="lyric-line placeholder">Dreamisle<br><br>${t('lyrics.noLyrics')}</p>`;
  }
}

function syncLyrics(currentTime) {
  if (!currentLyrics.length || currentLyrics[0].isStatic || lyricDoms.length === 0) {
    if (miniLyricsEl) miniLyricsEl.innerText = "";
    pushDesktopLyrics("");
    return;
  }

  let activeIndex = -1;
  for (let i = 0; i < currentLyrics.length; i++) {
    if (currentTime >= currentLyrics[i].time) activeIndex = i;
    else break;
  }

  if (activeIndex === currentLineIndex) return;

  if (currentLineIndex !== -1 && lyricDoms[currentLineIndex]) {
    lyricDoms[currentLineIndex].classList.remove('active');
  }

  currentLineIndex = activeIndex;

  if (activeIndex !== -1 && lyricDoms[activeIndex]) {
    const targetLine = lyricDoms[activeIndex];
    targetLine.classList.add('active');
    if (!isUserScrolling) {
      lyricsScroll.scrollTop = targetLine.offsetTop - lyricsContainer.clientHeight / 2 + targetLine.clientHeight / 2;
    }

    if (miniLyricsEl && currentLyrics[activeIndex]) {
      const text = currentLyrics[activeIndex].text || '';
      miniLyricsEl.innerText = text.replace(/\n/g, ' / ');
      pushDesktopLyrics(miniLyricsEl.innerText);
    }
  } else {
    if (miniLyricsEl) miniLyricsEl.innerText = "";
    pushDesktopLyrics("");
  }
}

// 向主进程推送桌面歌词文本（含翻译行合并、去重）
function pushDesktopLyrics(text) {
  if (text === lastDesktopText) return;
  lastDesktopText = text;
  window.dreamApi.updateDesktopLyrics(text);
}

function openHelp() {
  helpOverlayEl.classList.add('open');
  // 版本号仅首次打开时请求一次
  if (!helpVersionEl.textContent) {
    window.dreamApi.getVersion()
      .then((v) => { helpVersionEl.textContent = `v${v}`; })
      .catch(() => { });
  }
}

function closeHelp() {
  helpOverlayEl.classList.remove('open');
}

function toggleHelp() {
  if (helpOverlayEl.classList.contains('open')) closeHelp();
  else openHelp();
}

function toggleSettings() {
  if (settingsOverlay.classList.contains('open')) closeSettings();
  else openSettings();
}

function openSettings() {
  settingsOverlay.classList.add('open');
  refreshSettingsUi();
}

function closeSettings() {
  settingsOverlay.classList.remove('open');
}

// 打开时同步主进程中的设置到控件
async function refreshSettingsUi() {
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

function renderFolderList(folders) {
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

async function handleAddFolder() {
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

async function handleRemoveFolder(folderPath) {
  const res = await window.dreamApi.removeFolder(folderPath);
  if (res && res.playlist) {
    applyPlaylistFromMain(res.playlist);
  }
  refreshSettingsUi();
}

async function handleLanguageChange(lang) {
  setLang(lang);
  applyLang();
  await window.dreamApi.setLanguage(lang);
  refreshSettingsUi(); // 重建动态行（文件夹列表/移除按钮标题），跟随新语言
}

function syncLyricsStyleUi(style) {
  currentLyricsStyle = { ...DEFAULT_LYRICS_STYLE, ...style };
  bgOpacityInput.value = currentLyricsStyle.bgOpacity;
  textOpacityInput.value = currentLyricsStyle.textOpacity;
  textColorInput.value = currentLyricsStyle.textColor;
  bgOpacityVal.textContent = `${currentLyricsStyle.bgOpacity}%`;
  textOpacityVal.textContent = `${currentLyricsStyle.textOpacity}%`;
  bgOpacityInput.style.setProperty('--progress', `${currentLyricsStyle.bgOpacity}%`);
  textOpacityInput.style.setProperty('--progress', `${currentLyricsStyle.textOpacity}%`);
  // 按钮上直接以所选字体渲染当前字体名，空值显示"默认字体"
  fontSelectValue.textContent = currentLyricsStyle.fontFamily || t('settings.fontDefault');
  fontSelectValue.style.fontFamily = currentLyricsStyle.fontFamily ? `"${currentLyricsStyle.fontFamily}"` : '';
}

function pushLyricsStyle() {
  window.dreamApi.setLyricsStyle(currentLyricsStyle);
}

bgOpacityInput.addEventListener('input', () => {
  currentLyricsStyle.bgOpacity = Number(bgOpacityInput.value);
  bgOpacityVal.textContent = `${currentLyricsStyle.bgOpacity}%`;
  bgOpacityInput.style.setProperty('--progress', `${currentLyricsStyle.bgOpacity}%`);
  pushLyricsStyle();
});

textOpacityInput.addEventListener('input', () => {
  currentLyricsStyle.textOpacity = Number(textOpacityInput.value);
  textOpacityVal.textContent = `${currentLyricsStyle.textOpacity}%`;
  textOpacityInput.style.setProperty('--progress', `${currentLyricsStyle.textOpacity}%`);
  pushLyricsStyle();
});

textColorInput.addEventListener('input', () => {
  currentLyricsStyle.textColor = textColorInput.value;
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

// 系统字体列表：首次展开下拉时通过 Local Font Access API 读取并缓存
let systemFonts = null;
let fontsLoadFailed = false;

async function ensureSystemFonts() {
  if (systemFonts || fontsLoadFailed) return;
  try {
    if (typeof window.queryLocalFonts !== 'function') throw new Error('unsupported');
    const all = await window.queryLocalFonts(); // 必须在用户手势内同步发起，由点击事件直接调用
    const seen = new Set();
    systemFonts = [];
    for (const font of all) {
      if (!seen.has(font.family)) {
        seen.add(font.family);
        systemFonts.push(font.family);
      }
    }
    systemFonts.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch (err) {
    fontsLoadFailed = true;
    showSyncToast(t('settings.fontLoadError'));
  }
}

function renderFontOptions(filter = '') {
  fontOptions.innerHTML = '';
  const query = filter.trim().toLowerCase();

  const makeOption = (family, label, ownFont) => {
    const li = document.createElement('li');
    li.className = 'font-select-option';
    if (ownFont) li.style.fontFamily = `"${family}"`;
    li.textContent = label;
    li.dataset.value = family;
    if (family === (currentLyricsStyle.fontFamily || '')) li.classList.add('selected');
    li.addEventListener('click', () => {
      currentLyricsStyle.fontFamily = family;
      fontSelectValue.textContent = label;
      fontSelectValue.style.fontFamily = ownFont ? `"${family}"` : '';
      fontSelectWrap.classList.remove('open');
      pushLyricsStyle();
    });
    fontOptions.appendChild(li);
  };

  // 首项固定为默认字体，不参与搜索过滤
  makeOption('', t('settings.fontDefault'), false);
  for (const family of systemFonts) {
    if (query && !family.toLowerCase().includes(query)) continue;
    makeOption(family, family, true);
  }
}

fontSelectBtn.addEventListener('click', async () => {
  const willOpen = !fontSelectWrap.classList.contains('open');
  fontSelectWrap.classList.toggle('open');
  if (!willOpen) return;
  await ensureSystemFonts(); // 读取失败时仅提示，不展开列表
  if (fontsLoadFailed) {
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
    document.querySelectorAll('.settings-nav-item').forEach((n) => n.classList.toggle('active', n === item));
    document.querySelectorAll('.settings-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === item.dataset.section));
  });
});

function updateThemeColor(src) {
  const root = document.documentElement; // 设在根节点：ambient 背景与帮助浮层都能继承
  if (!src) {
    root.style.setProperty('--bg-color-1', '#222');
    root.style.setProperty('--bg-color-2', '#111');
    root.style.setProperty('--glow-primary', 'rgba(120, 140, 255, 0.15)');
    root.style.setProperty('--glow-secondary', 'rgba(255, 120, 180, 0.12)');
    return;
  }
  const img = new Image();
  img.src = src;
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 50, 50);
    const data = ctx.getImageData(0, 0, 50, 50).data;
    let r = 0, g = 0, b = 0, c = 0;
    for (let i = 0; i < data.length; i += 4) {
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      if ((max + min) / 2 > 20 && (max - min) > 30) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; c++;
      }
    }
    if (c > 0) {
      r = Math.floor(r / c); g = Math.floor(g / c); b = Math.floor(b / c);
      root.style.setProperty('--bg-color-1', `rgb(${r},${g},${b})`);
      root.style.setProperty('--bg-color-2', `rgb(${r * 0.6},${g * 0.6},${b * 0.6})`);
      root.style.setProperty('--glow-primary', `rgba(${r}, ${g + 20}, ${b + 40}, 0.15)`);
      root.style.setProperty('--glow-secondary', `rgba(${r + 40}, ${g}, ${b + 20}, 0.12)`);
    }
    
    ctx.clearRect(0, 0, 50, 50);
    img.onload = null;
    img.src = ''; 
  };
}

btnMode.addEventListener('click', () => {
  playMode = (playMode + 1) % 3;
  iconLoop.style.display = playMode === 0 ? 'block' : 'none';
  iconOne.style.display = playMode === 1 ? 'block' : 'none';
  iconShuffle.style.display = playMode === 2 ? 'block' : 'none';
  saveStateOnChange();
});

btnPlaylist.addEventListener('click', (e) => {
  e.stopPropagation();
  playlistDrawer.classList.toggle('open');
});
document.querySelector('.app-container').addEventListener('click', () => playlistDrawer.classList.remove('open'));
playlistDrawer.addEventListener('click', (e) => e.stopPropagation());

audio.addEventListener('timeupdate', () => {
  if (!isDragging && audio.duration) {
    const p = (audio.currentTime / audio.duration) * 100;
    progressBar.value = p;
    updateProgressStyle(p);
    currentTimeEl.innerText = formatTime(audio.currentTime);
    totalTimeEl.innerText = formatTime(audio.duration);
    syncLyrics(audio.currentTime);
  }
});

progressBar.addEventListener('input', () => {
  isDragging = true;
  updateProgressStyle(progressBar.value);
  currentTimeEl.innerText = formatTime((progressBar.value / 100) * audio.duration);
});

progressBar.addEventListener('change', () => {
  isDragging = false;
  if (audio.duration) {
    const seekTime = (progressBar.value / 100) * audio.duration;
    audio.currentTime = seekTime;
    syncLyrics(seekTime);
  }
});

btnPlay.addEventListener('click', () => {
  if (audio.paused) {
    if (currentIndex === -1 && songs.length) playSong(0); else audio.play();
    updatePlayButton(true);
  } else {
    audio.pause(); updatePlayButton(false);
  }
});

function handleVolumeWheel(e) {
  e.preventDefault();
  let newVolume = audio.volume - (e.deltaY > 0 ? 0.05 : -0.05);
  if (newVolume > 1) newVolume = 1;
  if (newVolume < 0) newVolume = 0;
  audio.volume = newVolume;

  volumeHud.innerText = t('hud.volume', { n: Math.round(newVolume * 100) });
  volumeHud.classList.add('visible');
  clearTimeout(volumeTimeout);
  volumeTimeout = setTimeout(() => volumeHud.classList.remove('visible'), 1000);
  saveStateOnChange();
}

coverContainer.addEventListener('wheel', handleVolumeWheel);

document.getElementById('btnNext').addEventListener('click', () => playNext(false));
document.getElementById('btnPrev').addEventListener('click', () => {
  let prev = currentIndex - 1;
  if (playMode === 2) prev = Math.floor(Math.random() * songs.length);
  else if (prev < 0) prev = songs.length - 1;
  playSong(prev);
});

audio.addEventListener('ended', () => playNext(true));

function updatePlayButton(isPlaying) {
  document.getElementById('iconPlay').style.display = isPlaying ? 'none' : 'block';
  document.getElementById('iconPause').style.display = isPlaying ? 'block' : 'none';
  
  const ambientBg = document.querySelector('.ambient-bg');
  if (isPlaying) {
    document.querySelector('.album-art-container').classList.add('playing');
    if (ambientBg) ambientBg.classList.add('playing'); 
  } else {
    document.querySelector('.album-art-container').classList.remove('playing');
    if (ambientBg) ambientBg.classList.remove('playing'); 
  }
}

function formatTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

async function savePlaybackState() {
  if (songs.length === 0) return;
  const state = { currentIndex, currentSongPath: songs[currentIndex] ? songs[currentIndex].path : null, currentTime: audio.currentTime || 0, volume: audio.volume, playMode, isPlaying: !audio.paused };
  try { await window.dreamApi.savePlaybackState(state); } catch (e) { }
}

setInterval(() => { if (songs.length > 0) savePlaybackState(); }, 60000);

window.addEventListener('beforeunload', () => {
  if (songs.length > 0) {
    const state = { currentIndex, currentSongPath: songs[currentIndex] ? songs[currentIndex].path : null, currentTime: audio.currentTime || 0, volume: audio.volume, playMode, isPlaying: !audio.paused };
    window.dreamApi.savePlaybackState(state).catch(() => { });
  }
});

function saveStateOnChange() { if (songs.length > 0) savePlaybackState(); }

audio.addEventListener('play', saveStateOnChange);
audio.addEventListener('pause', saveStateOnChange);
audio.addEventListener('volumechange', saveStateOnChange);

function setupIpcListeners() {
  window.dreamApi.onWindowVisibilityChanged((isVisible) => { });
  window.dreamApi.onTrayPlayPause(() => {
    if (audio.paused) {
      if (currentIndex === -1 && songs.length) playSong(0);
      else audio.play();
      updatePlayButton(true);
    } else {
      audio.pause();
      updatePlayButton(false);
    }
    saveStateOnChange();
  });
  window.dreamApi.onTrayNext(() => playNext(false));
  window.dreamApi.onTrayPrev(() => {
    let prev = currentIndex - 1;
    if (playMode === 2) prev = Math.floor(Math.random() * songs.length);
    else if (prev < 0) prev = songs.length - 1;
    playSong(prev);
  });
}

// 混排比对器：优先 A-Z 排序英文，然后按拼音排序中文，其余字符排在尾部
function compareMixed(aStr, bStr) {
  const cleanA = (aStr || '').trim();
  const cleanB = (bStr || '').trim();
  
  if (!cleanA && !cleanB) return 0;
  if (!cleanA) return 1;
  if (!cleanB) return -1;

  const charA = cleanA[0];
  const charB = cleanB[0];

  const isLatin = (ch) => /^[a-zA-Z]/.test(ch);
  const isChinese = (ch) => /^[\u4e00-\u9fa5]/.test(ch);

  // 分类评级：1-英文 2-中文 3-数字或其它符号
  const typeA = isLatin(charA) ? 1 : isChinese(charA) ? 2 : 3;
  const typeB = isLatin(charB) ? 1 : isChinese(charB) ? 2 : 3;

  if (typeA !== typeB) {
    return typeA - typeB; 
  }

  if (typeA === 1) {
    // 英文按标准 A-Z 忽略大小写及数字排序
    return cleanA.localeCompare(cleanB, 'en', { sensitivity: 'base', numeric: true });
  } else if (typeA === 2) {
    // 中文按本地化拼音排序
    return cleanA.localeCompare(cleanB, 'zh-CN', { numeric: true });
  } else {
    // 其它边缘符号或数字
    return cleanA.localeCompare(cleanB, undefined, { numeric: true });
  }
}

/**
 * 更新排序按钮的高亮状态
 */
function updateSortButtons(activeBtn) {
  [btnSortDefault, btnSortTitle, btnSortArtist, btnSortRandom].forEach(btn => {
    if (btn) btn.classList.remove('active');
  });
  if (activeBtn) activeBtn.classList.add('active');
}

/**
 * 执行队列重排并更新播放指针
 */
function applySort(mode, btnEl) {
  if (originalSongs.length === 0) return;
  
  updateSortButtons(btnEl);

  // 记录当前播放的歌曲，以便重排后重定向指针，不干扰当前播放
  const currentPlayingSong = songs[currentIndex];

  if (mode === 'default') {
    songs = [...originalSongs];
  } else if (mode === 'title') {
    songs = [...originalSongs].sort((a, b) => compareMixed(a.title, b.title));
  } else if (mode === 'artist') {
    songs = [...originalSongs].sort((a, b) => compareMixed(a.artist, b.artist));
  } else if (mode === 'random') {
    // 洗牌算法重新排列
    songs = [...originalSongs].sort(() => Math.random() - 0.5);
  }

  if (currentPlayingSong) {
    currentIndex = songs.findIndex(s => s.path === currentPlayingSong.path);
  }

  // 刷新前端过滤和列表渲染，保留搜索框已有字符
  initVirtualList(searchInput.value.trim());
}

function showSyncToast(text) {
  if (!syncToastEl) return;
  syncToastEl.innerText = text;
  syncToastEl.classList.add('visible');
  clearTimeout(syncToastTimer);
  syncToastTimer = setTimeout(() => syncToastEl.classList.remove('visible'), 3000);
}

// 用主进程返回的新播放列表替换本地列表：按路径重定位当前歌曲、套用排序、刷新列表
function applyPlaylistFromMain(playlist) {
  const playingPath = songs[currentIndex] ? songs[currentIndex].path : null;

  originalSongs = [...playlist];
  songs = [...originalSongs];
  currentIndex = resolveRestoredIndex(songs, { currentSongPath: playingPath });
  if (currentIndex === -1) currentIndex = songs.length > 0 ? 0 : -1;

  // 空库（如移除最后一个文件夹）：停止播放并复位界面状态
  if (songs.length === 0) {
    audio.pause();
    updatePlayButton(false);
    titleEl.innerText = 'Dreamisle';
    artistEl.innerText = t('app.waitingForMusic');
    if (miniLyricsEl) miniLyricsEl.innerText = '';
    pushDesktopLyrics('');
    currentLyrics = [];
    currentLineIndex = -1;
    lyricDoms = [];
    if (lyricsScroll) {
      lyricsScroll.innerHTML = `<p class="lyric-line placeholder">${t('lyrics.noLyrics')}</p>`;
    }
    if (currentCoverBlobUrl) {
      URL.revokeObjectURL(currentCoverBlobUrl);
      currentCoverBlobUrl = null;
    }
    coverImg.style.display = 'none';
    defaultCover.style.display = 'flex';
    updateThemeColor(null);
  }

  const activeSortBtn = [btnSortDefault, btnSortTitle, btnSortArtist, btnSortRandom]
    .find((btn) => btn && btn.classList.contains('active'));
  if (activeSortBtn && activeSortBtn !== btnSortDefault) {
    applySort(activeSortBtn.dataset.mode, activeSortBtn);
  } else {
    initVirtualList(searchInput.value.trim());
  }
}

// 启动后自动同步：合并文件夹新增/删除的歌曲，不打断当前播放
async function applyFolderSync() {
  const result = await window.dreamApi.syncFolder();
  if (!result || (result.added === 0 && result.removed === 0)) return;

  applyPlaylistFromMain(result.playlist);
  if (result.added > 0) showSyncToast(t('sync.foundNew', { n: result.added }));
}

if (btnSortDefault) btnSortDefault.onclick = () => applySort('default', btnSortDefault);
if (btnSortTitle) btnSortTitle.onclick = () => applySort('title', btnSortTitle);
if (btnSortArtist) btnSortArtist.onclick = () => applySort('artist', btnSortArtist);
if (btnSortRandom) btnSortRandom.onclick = () => applySort('random', btnSortRandom);
