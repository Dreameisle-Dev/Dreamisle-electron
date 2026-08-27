import { t, setLang, applyLang } from '../../shared/i18n.js';
import { state } from './state.js';
import {
  audio,
  volumeHud,
  progressBar,
  playlistDrawer,
  playlistsDrawer,
  searchInput,
  settingsOverlay,
  helpOverlayEl,
  btnHelpClose,
  helpVersionEl,
  iconLoop,
  iconOne,
  iconShuffle,
  btnPlay,
  btnMode,
  contextMenu,
} from './dom.js';
import { initVirtualList, applyPlaylistFromMain, bindPlaylistEvents } from './playlist.js';
import {
  togglePlaylistsDrawer,
  bindPlaylistsEvents,
  loadPlaylists,
  closeContextMenu,
  prunePlaylistsFromLibrary,
} from './playlists.js';
import {
  playSong,
  initSongInfo,
  updatePlayButton,
  playNext,
  saveStateOnChange,
  bindPlaybackEvents,
} from './playback.js';
import { bindLyricsEvents } from './lyrics.js';
import { toggleSettings, closeSettings, bindSettingsEvents } from './settings.js';
import { toggleStats, closeStats, isStatsOpen, bindStatsEvents } from './stats.js';
import { initMouseFollow, updateProgressStyle } from './theme.js';
import { showSyncToast } from './helpers.js';
import { resolveRestoredIndex } from './playback-restore.js';

function openHelp() {
  helpOverlayEl.classList.add('open');
  // 版本号仅首次打开时请求一次
  if (!helpVersionEl.textContent) {
    window.dreamApi
      .getVersion()
      .then((v) => {
        helpVersionEl.textContent = `v${v}`;
      })
      .catch(() => {});
  }
}

function closeHelp() {
  helpOverlayEl.classList.remove('open');
}

function toggleHelp() {
  if (helpOverlayEl.classList.contains('open')) closeHelp();
  else openHelp();
}

// 托盘与主进程推送的播放控制
function setupIpcListeners() {
  window.dreamApi.onWindowVisibilityChanged((isVisible) => {});
  window.dreamApi.onTrayPlayPause(() => {
    if (audio.paused) {
      if (state.currentIndex === -1 && state.songs.length) playSong(0);
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
    let prev = state.currentIndex - 1;
    if (state.playMode === 2) prev = Math.floor(Math.random() * state.songs.length);
    else if (prev < 0) prev = state.songs.length - 1;
    playSong(prev);
  });
}

// 启动后自动同步：合并文件夹新增/删除的歌曲，不打断当前播放
async function applyFolderSync() {
  const result = await window.dreamApi.syncFolder();
  if (!result || (result.added === 0 && result.removed === 0)) return;

  if (state.activeQueue.type === 'playlist') {
    // 歌单队列中：只更新曲库缓存，不打断播放；随后清理歌单失效歌曲
    state.librarySongs = [...result.playlist];
    await prunePlaylistsFromLibrary();
    return;
  }

  applyPlaylistFromMain(result.playlist);
  if (result.added > 0) showSyncToast(t('sync.foundNew', { n: result.added }));
}

window.addEventListener('DOMContentLoaded', async () => {
  // 注册各 feature 模块的事件绑定（等价于原先脚本求值期的顶层绑定）
  bindPlaybackEvents();
  bindLyricsEvents();
  bindSettingsEvents();
  bindPlaylistEvents();
  bindPlaylistsEvents();
  bindStatsEvents();

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

  // 绑定键盘快捷键
  let altTimer = null;
  let ctrlTimer = null;
  let shiftTimer = null;
  window.addEventListener('keydown', (e) => {
    // 长按 Ctrl 计时期间按下任何其他键 → 取消计时(防 Ctrl+, / Ctrl+Alt+L 误触发)
    if (e.code !== 'ControlLeft' && ctrlTimer) {
      clearTimeout(ctrlTimer);
      ctrlTimer = null;
    }
    // 长按 Shift 计时期间按下任何其他键 → 取消计时
    if (e.code !== 'ShiftLeft' && shiftTimer) {
      clearTimeout(shiftTimer);
      shiftTimer = null;
    }

    const isInputActive =
      document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA';

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

    // Esc：先关右键菜单，再关设置浮层，再关帮助浮层，最后关抽屉
    if (e.code === 'Escape') {
      if (contextMenu.classList.contains('open')) {
        e.preventDefault();
        closeContextMenu();
      } else if (settingsOverlay.classList.contains('open')) {
        e.preventDefault();
        closeSettings();
      } else if (helpOverlayEl.classList.contains('open')) {
        e.preventDefault();
        closeHelp();
      } else if (isStatsOpen()) {
        e.preventDefault();
        closeStats();
      } else if (
        playlistDrawer.classList.contains('open') ||
        playlistsDrawer.classList.contains('open')
      ) {
        e.preventDefault();
        playlistDrawer.classList.remove('open');
        playlistsDrawer.classList.remove('open');
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
        playlistsDrawer.classList.remove('open'); // 互斥：打开右侧关左侧
        closeStats(); // 互斥：打开抽屉关统计浮层
        altTimer = null;
      }, 500);
    }

    // LeftCtrl：长按 0.5s 呼出/折叠歌单抽屉
    if (e.code === 'ControlLeft') {
      e.preventDefault();
      if (e.repeat) return; // 屏蔽自动重复

      ctrlTimer = setTimeout(() => {
        togglePlaylistsDrawer();
        closeStats(); // 互斥：打开抽屉关统计浮层
        ctrlTimer = null;
      }, 500);
    }

    // LeftShift：长按 0.5s 呼出/折叠播放统计
    if (e.code === 'ShiftLeft') {
      e.preventDefault();
      if (e.repeat) return; // 屏蔽自动重复

      shiftTimer = setTimeout(() => {
        toggleStats();
        shiftTimer = null;
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
    if (e.code === 'ControlLeft') {
      e.preventDefault();
      if (ctrlTimer) {
        clearTimeout(ctrlTimer);
        ctrlTimer = null;
      }
    }
    if (e.code === 'ShiftLeft') {
      e.preventDefault();
      if (shiftTimer) {
        clearTimeout(shiftTimer);
        shiftTimer = null;
      }
    }
  });

  // 窗口失焦时收不到 keyup：取消进行中的长按计时，防止抽屉意外弹出
  window.addEventListener('blur', () => {
    if (altTimer) {
      clearTimeout(altTimer);
      altTimer = null;
    }
    if (ctrlTimer) {
      clearTimeout(ctrlTimer);
      ctrlTimer = null;
    }
    if (shiftTimer) {
      clearTimeout(shiftTimer);
      shiftTimer = null;
    }
  });

  // 监听窗口模式更改通知
  window.dreamApi.onWindowModeChanged((mode) => {
    if (mode === 'mini') {
      state.isMiniMode = true;
      document.body.classList.add('mini-mode');
    } else {
      state.isMiniMode = false;
      document.body.classList.remove('mini-mode');
    }
    updateProgressStyle(progressBar.value);
  });

  const savedSongs = await window.dreamApi.loadSavedMusic();

  if (savedSongs && savedSongs.length > 0) {
    state.originalSongs = [...savedSongs]; // 备份原始数据
    state.songs = [...savedSongs];
    state.librarySongs = [...savedSongs]; // 曲库缓存
    searchInput.value = '';
    initVirtualList();

    const savedState = await window.dreamApi.loadPlaybackState();
    const restoredIndex = resolveRestoredIndex(state.songs, savedState);
    if (restoredIndex >= 0) {
      state.currentIndex = restoredIndex;
      state.playMode = savedState.playMode || 0;
      audio.volume = savedState.volume || 0.5;

      iconLoop.style.display = state.playMode === 0 ? 'block' : 'none';
      iconOne.style.display = state.playMode === 1 ? 'block' : 'none';
      iconShuffle.style.display = state.playMode === 2 ? 'block' : 'none';

      initSongInfo(state.currentIndex);

      if (savedState.currentTime > 0) audio.currentTime = savedState.currentTime;
      if (savedState.isPlaying) {
        audio.play();
        updatePlayButton(true);
      }
    } else {
      if (state.songs.length > 0) initSongInfo(0);
    }
  } else {
    // 首次启动（未配置任何音乐文件夹）：弹一次添加文件夹对话框
    const firstRunSettings = await window.dreamApi.getSettings();
    if (!firstRunSettings.musicFolders || firstRunSettings.musicFolders.length === 0) {
      const res = await window.dreamApi.addFolder();
      if (res && res.playlist && res.playlist.length > 0) {
        applyPlaylistFromMain(res.playlist);
        playSong(0);
      }
    }
  }

  setupIpcListeners();
  updateProgressStyle(0);
  loadPlaylists().catch(() => {});

  // 播放恢复完成后，后台同步文件夹新增/删除的歌曲；同步结束后再清理歌单失效歌曲
  applyFolderSync()
    .then(() => prunePlaylistsFromLibrary())
    .catch(() => {});
});
