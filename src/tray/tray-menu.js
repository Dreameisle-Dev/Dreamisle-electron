(() => {
  const cardEl = document.getElementById('tmCard');
  const coverWrapEl = document.getElementById('tmCoverWrap');
  const coverImgEl = document.getElementById('tmCoverImg');
  const titleEl = document.getElementById('tmTrackTitle');
  const artistEl = document.getElementById('tmTrackArtist');
  const playingDotEl = document.getElementById('tmPlayingDot');

  const btnPrev = document.getElementById('btnPrev');
  const btnPlayPause = document.getElementById('btnPlayPause');
  const btnNext = document.getElementById('btnNext');
  const iconPlay = document.getElementById('iconPlay');
  const iconPause = document.getElementById('iconPause');

  const btnDesktopLyrics = document.getElementById('btnDesktopLyrics');
  const labelDesktopLyrics = document.getElementById('labelDesktopLyrics');
  const btnTaskbarLyrics = document.getElementById('btnTaskbarLyrics');
  const labelTaskbarLyrics = document.getElementById('labelTaskbarLyrics');
  const btnToggleWindow = document.getElementById('btnToggleWindow');
  const labelToggleWindow = document.getElementById('labelToggleWindow');
  const btnQuit = document.getElementById('btnQuit');
  const labelQuit = document.getElementById('labelQuit');

  let lastCoverUrl = '';
  let lastShowSeq = -1;

  function applyTheme(themeMode) {
    const root = document.documentElement;
    root.classList.remove('theme-light', 'theme-dark');
    if (themeMode === 'light') root.classList.add('theme-light');
    else if (themeMode === 'dark') root.classList.add('theme-dark');
  }

  function applyCover(url) {
    const next = typeof url === 'string' && url.length > 0 ? url : '';
    if (next === lastCoverUrl) return;
    lastCoverUrl = next;
    if (!next) {
      coverWrapEl.classList.remove('has-cover');
      coverImgEl.removeAttribute('src');
      return;
    }
    coverImgEl.onload = () => {
      if (lastCoverUrl === next) coverWrapEl.classList.add('has-cover');
    };
    coverImgEl.onerror = () => {
      if (lastCoverUrl === next) coverWrapEl.classList.remove('has-cover');
    };
    coverImgEl.src = next;
  }

  function renderState(state) {
    if (!state || typeof state !== 'object') return;
    applyTheme(state.themeMode);
    if (state.lang) document.documentElement.lang = state.lang;

    const labels = state.labels || {};
    const track = state.track || {};
    const hasTrack = Boolean(track.hasTrack && track.title);
    const playing = Boolean(track.playing);

    titleEl.textContent = hasTrack ? track.title : labels.idleTitle || 'Dreamisle';
    artistEl.textContent = hasTrack ? track.artist || '' : labels.idleSub || '暂无播放';
    playingDotEl.hidden = !playing;
    applyCover(hasTrack ? track.coverUrl : '');

    iconPlay.classList.toggle('is-hidden', playing);
    iconPause.classList.toggle('is-hidden', !playing);
    btnPlayPause.title = playing
      ? labels.pause || labels.playPause || ''
      : labels.play || labels.playPause || '';
    btnPlayPause.setAttribute('aria-label', btnPlayPause.title);
    btnPrev.title = labels.prev || '';
    btnPrev.setAttribute('aria-label', btnPrev.title);
    btnNext.title = labels.next || '';
    btnNext.setAttribute('aria-label', btnNext.title);

    labelDesktopLyrics.textContent = labels.desktopLyrics || '';
    btnDesktopLyrics.setAttribute('aria-checked', String(Boolean(state.desktopLyricsEnabled)));

    labelTaskbarLyrics.textContent = labels.taskbarLyrics || '';
    btnTaskbarLyrics.setAttribute('aria-checked', String(Boolean(state.taskbarLyricsEnabled)));

    labelToggleWindow.textContent = state.mainWindowVisible
      ? labels.hideWindow || ''
      : labels.showWindow || '';
    labelQuit.textContent = labels.quitApp || labels.quit || '';

    const seq = Number(state.showSeq) || 0;
    if (seq !== lastShowSeq) {
      lastShowSeq = seq;
      cardEl.classList.remove('is-open');
      // 隐藏窗口期间 Chromium 会暂停 rAF，这里必须同步读取未缩放的 offsetWidth/offsetHeight 并立即上报，
      // 确保第 2、3…N 次右键都能瞬间弹出；入场动画待主进程 show() 后由 onShown 触发。
      window.trayMenuApi.ready({
        width: Math.ceil(cardEl.offsetWidth),
        height: Math.ceil(cardEl.offsetHeight),
        showSeq: seq,
      });
    }
  }

  function playOpenAnimation(seq) {
    if (seq !== lastShowSeq) return;
    requestAnimationFrame(() => {
      if (seq !== lastShowSeq) return;
      cardEl.classList.add('is-open');
      cardEl.focus({ preventScroll: true });
    });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      window.trayMenuApi.action(btn.dataset.action);
      return;
    }
    if (!e.target.closest('.tm-card')) {
      window.trayMenuApi.close();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      window.trayMenuApi.close();
      return;
    }
    if (e.key === ' ' && e.target === cardEl) {
      e.preventDefault();
      window.trayMenuApi.action('play-pause');
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...document.querySelectorAll('.tm-item')];
      if (items.length === 0) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement);
      const next =
        e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items[next].focus();
    }
  });

  window.trayMenuApi.onState(renderState);
  window.trayMenuApi.onShown(playOpenAnimation);
})();
