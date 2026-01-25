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

let songs = [];
let currentIndex = -1;
let isDragging = false;
let playMode = 0;
let volumeTimeout;

let currentLyrics = [];
let isLyricsVisible = false;
let currentLineIndex = -1;

audio.volume = 0.5;

window.addEventListener('DOMContentLoaded', async () => {
  const savedSongs = await window.dreamApi.loadSavedMusic();

  if (savedSongs && savedSongs.length > 0) {
    songs = savedSongs;
    searchInput.value = '';
    renderPlaylist();

    const savedState = await window.dreamApi.loadPlaybackState();
    if (savedState && savedState.currentIndex >= 0 && savedState.currentIndex < songs.length) {
      currentIndex = savedState.currentIndex;
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
    setTimeout(() => {
      if (songs.length === 0) triggerImport();
    }, 500);
  }

  setupIpcListeners();
});

document.getElementById('coverContainer').addEventListener('click', () => {
  if (!isLyricsVisible) triggerImport();
});

async function triggerImport() {
  const newSongs = await window.dreamApi.importFolder();
  if (newSongs && newSongs.length > 0) {
    songs = newSongs;
    searchInput.value = '';
    renderPlaylist();
    if (currentIndex === -1) playSong(0);
  }
}

function initSongInfo(index) {
  if (index < 0 || index >= songs.length) return;
  currentIndex = index;
  const song = songs[index];
  audio.src = song.url;

  titleEl.innerText = song.title;
  artistEl.innerText = song.artist;
  renderPlaylist();

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
  renderPlaylist(searchInput.value.trim());

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

function parseLrc(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return [];

  const lines = lrcText.split(/\r\n|\r|\n/);

  const result = [];
  const timeExp = /\[(\d{1,2}):(\d{1,2})(\.\d{1,3})?\]/;
  let hasTimestamps = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const match = timeExp.exec(trimmedLine);
    if (match) {
      hasTimestamps = true;
      const min = parseInt(match[1]);
      const sec = parseInt(match[2]);
      const ms = match[3] ? parseFloat(match[3]) : 0;
      const time = min * 60 + sec + ms;

      const text = trimmedLine.replace(timeExp, '').trim();

      if (text) result.push({ time, text });
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

async function loadAndRenderLyrics(song) {
  currentLineIndex = -1;
  currentLyrics = [];

  if (lyricsScroll) {
    lyricsScroll.innerHTML = '<p class="lyric-line placeholder">加载歌词中...</p>';
    lyricsScroll.scrollTop = 0;
  }

  let lrcData = await window.dreamApi.getLyrics(song.path);

  if (lrcData) {
    if (typeof lrcData === 'object' && lrcData !== null) {
      if (Array.isArray(lrcData.syncText) && lrcData.syncText.length > 0) {
        currentLyrics = lrcData.syncText.map(item => ({
          time: item.timestamp / 1000,
          text: item.text || ''
        }));
        currentLyrics.sort((a, b) => a.time - b.time);
      }
      else if (typeof lrcData.text === 'string') {
        currentLyrics = parseLrc(lrcData.text);
      }
      else if (lrcData.type === 'Buffer') {
        try {
          const str = new TextDecoder().decode(new Uint8Array(lrcData.data));
          currentLyrics = parseLrc(str);
        } catch (e) { }
      }
    }
    else if (typeof lrcData === 'string') {
      currentLyrics = parseLrc(lrcData);
    }
  }

  renderLyricsToDom();
}

function renderLyricsToDom() {
  if (!lyricsScroll) return;
  lyricsScroll.innerHTML = '';

  if (currentLyrics && currentLyrics.length > 0) {
    const fragment = document.createDocumentFragment();
    const isStatic = currentLyrics[0].isStatic;

    currentLyrics.forEach((line, index) => {
      if (!line.text.trim()) return;

      const p = document.createElement('p');
      p.className = 'lyric-line';
      p.innerText = line.text;
      p.dataset.index = index;

      if (!isStatic) {
        p.onclick = () => {
          audio.currentTime = line.time;
          if (audio.paused) {
            audio.play();
            updatePlayButton(true);
          }
        };
      } else {
        p.style.cursor = 'default';
        p.style.opacity = '0.9';
        p.style.margin = '8px 0';
      }

      fragment.appendChild(p);
    });
    lyricsScroll.appendChild(fragment);
  } else {
    lyricsScroll.innerHTML = '<p class="lyric-line placeholder">Dreamisle<br><br>暂无歌词信息</p>';
  }
}

function syncLyrics(currentTime) {
  if (!currentLyrics.length || !isLyricsVisible) return;
  if (currentLyrics[0].isStatic) return;

  let activeIndex = -1;
  for (let i = 0; i < currentLyrics.length; i++) {
    if (currentTime >= currentLyrics[i].time) {
      activeIndex = i;
    } else {
      break;
    }
  }

  if (activeIndex === currentLineIndex) return;
  currentLineIndex = activeIndex;

  const activeItem = lyricsScroll.querySelector('.active');
  if (activeItem) activeItem.classList.remove('active');

  if (activeIndex !== -1) {
    const lines = lyricsScroll.querySelectorAll('.lyric-line');

    let targetLine = null;
    for (const line of lines) {
      if (parseInt(line.dataset.index) === activeIndex) {
        targetLine = line;
        break;
      }
    }

    if (targetLine) {
      targetLine.classList.add('active');
      targetLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function toggleLyricsView() {
  isLyricsVisible = !isLyricsVisible;

  if (isLyricsVisible) {
    if (coverContainer) coverContainer.style.display = 'none';
    if (lyricsContainer) lyricsContainer.style.display = 'block';

    syncLyrics(audio.currentTime);
  } else {
    if (coverContainer) coverContainer.style.display = 'block';
    if (lyricsContainer) lyricsContainer.style.display = 'none';
  }
}

document.addEventListener('keydown', (e) => {
  if (document.activeElement === searchInput) return;
  if (e.key.toLowerCase() === 'i') {
    toggleLyricsView();
  }
});

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

function updateProgress(val) {
  progressBar.style.background = `linear-gradient(to right, #fff ${val}%, rgba(255,255,255,0.15) ${val}%)`;
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

searchInput.addEventListener('input', (e) => renderPlaylist(e.target.value.trim()));

audio.addEventListener('timeupdate', () => {
  if (!isDragging && audio.duration) {
    const p = (audio.currentTime / audio.duration) * 100;
    progressBar.value = p;
    updateProgress(p);
    currentTimeEl.innerText = formatTime(audio.currentTime);
    totalTimeEl.innerText = formatTime(audio.duration);
    syncLyrics(audio.currentTime);
  }
});

progressBar.addEventListener('input', () => {
  isDragging = true;
  updateProgress(progressBar.value);
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

  volumeHud.innerText = `VOL ${Math.round(newVolume * 100)}%`;
  volumeHud.classList.add('visible');

  clearTimeout(volumeTimeout);
  volumeTimeout = setTimeout(() => {
    volumeHud.classList.remove('visible');
  }, 1000);

  saveStateOnChange();
}

coverContainer.addEventListener('wheel', handleVolumeWheel);
if (lyricsContainer) lyricsContainer.addEventListener('wheel', handleVolumeWheel);

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
  if (isPlaying) {
    document.querySelector('.album-art-container').classList.add('playing');
  } else {
    document.querySelector('.album-art-container').classList.remove('playing');
  }
}

function formatTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

async function savePlaybackState() {
  if (songs.length === 0) return;
  const state = {
    currentIndex: currentIndex,
    currentTime: audio.currentTime || 0,
    volume: audio.volume,
    playMode: playMode,
    isPlaying: !audio.paused
  };
  try { await window.dreamApi.savePlaybackState(state); } catch (error) { }
}

setInterval(() => { if (songs.length > 0) savePlaybackState(); }, 60000);

window.addEventListener('beforeunload', () => {
  if (songs.length > 0) {
    const state = {
      currentIndex: currentIndex,
      currentTime: audio.currentTime || 0,
      volume: audio.volume,
      playMode: playMode,
      isPlaying: !audio.paused
    };
    window.dreamApi.savePlaybackState(state).catch(() => { });
  }
});

function saveStateOnChange() {
  if (songs.length > 0) savePlaybackState();
}

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