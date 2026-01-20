// DOM 元素引用
const audio = document.getElementById('audioPlayer');
const playlistDrawer = document.getElementById('playlistDrawer');
const playlistEl = document.getElementById('playlist');
const playlistCountEl = document.getElementById('playlistCount');
const searchInput = document.getElementById('searchInput');
const coverImg = document.getElementById('coverImg');
const defaultCover = document.getElementById('defaultCover');
const titleEl = document.getElementById('songTitle');
const artistEl = document.getElementById('artistName');
const progressBar = document.getElementById('progressBar');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const canvas = document.getElementById('colorCanvas');
const coverContainer = document.getElementById('coverContainer');
const volumeHud = document.getElementById('volumeHud');

// 按钮引用
const btnPlay = document.getElementById('btnPlay');
const btnMode = document.getElementById('btnMode');
const btnPlaylist = document.getElementById('btnPlaylist');
const iconLoop = document.getElementById('iconLoop');
const iconOne = document.getElementById('iconOne');
const iconShuffle = document.getElementById('iconShuffle');

// 状态变量
let songs = [];
let currentIndex = -1;
let isDragging = false;
let playMode = 0;
let volumeTimeout;

// 初始音量
audio.volume = 0.5;

// 初始化：尝试加载保存的目录和播放状态
window.addEventListener('DOMContentLoaded', async () => {
  const savedSongs = await window.dreamApi.loadSavedMusic();

  if (savedSongs && savedSongs.length > 0) {
    songs = savedSongs;
    searchInput.value = '';
    renderPlaylist();

    // 尝试恢复播放状态
    const savedState = await window.dreamApi.loadPlaybackState();
    if (savedState && savedState.currentIndex >= 0 && savedState.currentIndex < songs.length) {
      // 恢复播放状态
      currentIndex = savedState.currentIndex;
      playMode = savedState.playMode || 0;
      audio.volume = savedState.volume || 0.5;

      // 更新播放模式图标
      iconLoop.style.display = playMode === 0 ? 'block' : 'none';
      iconOne.style.display = playMode === 1 ? 'block' : 'none';
      iconShuffle.style.display = playMode === 2 ? 'block' : 'none';

      // 初始化歌曲信息但不自动播放
      initSongInfo(currentIndex);

      // 恢复播放进度
      if (savedState.currentTime > 0) {
        audio.currentTime = savedState.currentTime;
      }

      // 恢复播放/暂停状态
      if (savedState.isPlaying) {
        audio.play();
        updatePlayButton(true);
      }
    } else {
      // 没有保存的状态，初始化第一首歌但不播放
      if (songs.length > 0) initSongInfo(0);
    }
  } else {
    // 无存档则延迟弹出导入框
    setTimeout(() => {
      if (songs.length === 0) triggerImport();
    }, 500);
  }
});

// 手动触发导入
document.getElementById('coverContainer').addEventListener('click', () => {
  triggerImport();
});

async function triggerImport() {
  const newSongs = await window.dreamApi.importFolder();
  if (newSongs && newSongs.length > 0) {
    songs = newSongs; // 替换列表
    searchInput.value = '';
    renderPlaylist();
    if (currentIndex === -1) playSong(0);
  }
}

// 仅初始化信息不播放
function initSongInfo(index) {
  if (index < 0 || index >= songs.length) return;
  currentIndex = index;
  const song = songs[index];
  audio.src = song.url;

  titleEl.innerText = song.title;
  artistEl.innerText = song.artist;
  renderPlaylist();

  updateCoverAndColor(song);
}

// 核心播放逻辑
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
  renderPlaylist(searchInput.value.trim());

  updateCoverAndColor(song);

  // 保存状态
  saveStateOnChange();
}

// 切歌逻辑
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

// 更新封面与主题色
function updateCoverAndColor(song) {
  if (song.cover) {
    coverImg.src = song.cover;
    coverImg.style.display = 'block';
    defaultCover.style.display = 'none';
    updateThemeColor(song.cover);
  } else {
    coverImg.style.display = 'none';
    defaultCover.style.display = 'flex';
    updateThemeColor(null);
  }
}

// 智能取色算法
function updateThemeColor(src) {
  if (!src) {
    document.documentElement.style.setProperty('--bg-color-1', '#222');
    document.documentElement.style.setProperty('--bg-color-2', '#111');
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
      // 过滤过暗、过亮或饱和度过低的像素
      if ((max + min) / 2 > 20 && (max - min) > 30) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; c++;
      }
    }
    if (c > 0) {
      r = Math.floor(r / c); g = Math.floor(g / c); b = Math.floor(b / c);
      document.documentElement.style.setProperty('--bg-color-1', `rgb(${r},${g},${b})`);
      document.documentElement.style.setProperty('--bg-color-2', `rgb(${r * 0.6},${g * 0.6},${b * 0.6})`);
    }
  };
}

// 列表渲染 (支持搜索过滤)
function renderPlaylist(filterText = '') {
  playlistEl.innerHTML = '';
  const lowerFilter = filterText.toLowerCase();
  let visibleCount = 0;

  songs.forEach((song, index) => {
    if (filterText && !song.title.toLowerCase().includes(lowerFilter) && !song.artist.toLowerCase().includes(lowerFilter)) {
      return;
    }
    visibleCount++;
    const li = document.createElement('li');
    li.className = `playlist-item ${index === currentIndex ? 'active' : ''}`;
    li.innerHTML = `<div class="item-title">${song.title}</div><div class="item-artist">${song.artist}</div>`;
    li.onclick = () => playSong(index);
    playlistEl.appendChild(li);
  });

  playlistCountEl.innerText = `${visibleCount}首`;
}

// 进度条 UI 更新
function updateProgress(val) {
  progressBar.style.background = `linear-gradient(to right, #fff ${val}%, rgba(255,255,255,0.15) ${val}%)`;
}

// 模式切换
btnMode.addEventListener('click', () => {
  playMode = (playMode + 1) % 3;
  iconLoop.style.display = playMode === 0 ? 'block' : 'none';
  iconOne.style.display = playMode === 1 ? 'block' : 'none';
  iconShuffle.style.display = playMode === 2 ? 'block' : 'none';
  saveStateOnChange();
});

// 列表抽屉控制
btnPlaylist.addEventListener('click', (e) => {
  e.stopPropagation();
  playlistDrawer.classList.toggle('open');
});
document.querySelector('.app-container').addEventListener('click', () => playlistDrawer.classList.remove('open'));
playlistDrawer.addEventListener('click', (e) => e.stopPropagation());

// 搜索事件
searchInput.addEventListener('input', (e) => renderPlaylist(e.target.value.trim()));

// 音频事件监听
audio.addEventListener('timeupdate', () => {
  if (!isDragging && audio.duration) {
    const p = (audio.currentTime / audio.duration) * 100;
    progressBar.value = p;
    updateProgress(p);
    currentTimeEl.innerText = formatTime(audio.currentTime);
    totalTimeEl.innerText = formatTime(audio.duration);
  }
});

// 拖拽进度条
progressBar.addEventListener('input', () => {
  isDragging = true;
  updateProgress(progressBar.value);
  currentTimeEl.innerText = formatTime((progressBar.value / 100) * audio.duration);
});

progressBar.addEventListener('change', () => {
  isDragging = false;
  if (audio.duration) audio.currentTime = (progressBar.value / 100) * audio.duration;
});

// 播放控制按钮
btnPlay.addEventListener('click', () => {
  if (audio.paused) {
    if (currentIndex === -1 && songs.length) playSong(0); else audio.play();
    updatePlayButton(true);
  } else {
    audio.pause(); updatePlayButton(false);
  }
});

coverContainer.addEventListener('wheel', (e) => {
  e.preventDefault();
  let newVolume = audio.volume - (e.deltaY > 0 ? 0.05 : -0.05);

  if (newVolume > 1) newVolume = 1;
  if (newVolume < 0) newVolume = 0;

  audio.volume = newVolume;

  // 显示 HUD
  volumeHud.innerText = `VOL ${Math.round(newVolume * 100)}%`;
  volumeHud.classList.add('visible');

  clearTimeout(volumeTimeout);
  volumeTimeout = setTimeout(() => {
    volumeHud.classList.remove('visible');
  }, 1000);

  // 保存状态
  saveStateOnChange();
});

document.getElementById('btnNext').addEventListener('click', () => playNext(false));
document.getElementById('btnPrev').addEventListener('click', () => {
  let prev = currentIndex - 1;
  if (playMode === 2) prev = Math.floor(Math.random() * songs.length);
  else if (prev < 0) prev = songs.length - 1;
  playSong(prev);
});

audio.addEventListener('ended', () => playNext(true));

// 工具函数
function updatePlayButton(isPlaying) {
  document.getElementById('iconPlay').style.display = isPlaying ? 'none' : 'block';
  document.getElementById('iconPause').style.display = isPlaying ? 'block' : 'none';
  if (isPlaying) document.querySelector('.album-art-container').classList.add('playing');
  else document.querySelector('.album-art-container').classList.remove('playing');
}

function formatTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// 保存播放状态
async function savePlaybackState() {
  if (songs.length === 0) return;

  const state = {
    currentIndex: currentIndex,
    currentTime: audio.currentTime || 0,
    volume: audio.volume,
    playMode: playMode,
    isPlaying: !audio.paused
  };

  try {
    await window.dreamApi.savePlaybackState(state);
  } catch (error) {
    console.error('保存播放状态失败:', error);
  }
}

// 定期保存播放状态（每60秒）
setInterval(() => {
  if (songs.length > 0) {
    savePlaybackState();
  }
}, 60000);

// 在窗口关闭前保存状态
window.addEventListener('beforeunload', () => {
  if (songs.length > 0) {
    // 使用同步方式保存，因为异步可能来不及完成
    const state = {
      currentIndex: currentIndex,
      currentTime: audio.currentTime || 0,
      volume: audio.volume,
      playMode: playMode,
      isPlaying: !audio.paused
    };

    // 使用同步IPC调用
    window.dreamApi.savePlaybackState(state).catch(() => {
      // 忽略错误，因为窗口正在关闭
    });
  }
});

// 在重要状态变化时立即保存
function saveStateOnChange() {
  if (songs.length > 0) {
    savePlaybackState();
  }
}

// 监听重要状态变化
audio.addEventListener('play', saveStateOnChange);
audio.addEventListener('pause', saveStateOnChange);
audio.addEventListener('volumechange', saveStateOnChange);