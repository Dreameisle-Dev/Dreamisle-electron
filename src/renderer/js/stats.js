// 播放统计浮层:渲染当前歌曲信息/音质规格/计数卡与全曲排行,并处理面板开关与点击播放。
import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import {
  audio,
  playlistDrawer,
  playlistsDrawer,
  statsOverlay,
  btnStatsClose,
  statsVinylCover,
  statsVinylFallback,
  statsSongTitle,
  statsSongArtist,
  statsTier,
  statsAlbum,
  statsBitrate,
  statsSampleRate,
  statsBits,
  statsFullPlays,
  statsLoopPlays,
  statsTotalPlays,
  statsRankedCount,
  statsDailyAvg,
  statsChartList,
  statsEmptyEl,
} from './dom.js';
import { buildRanking, totalPlays, dailyAverage } from '../../shared/stats.js';
import { classifyTier, formatBitrate, formatSampleRate } from '../../shared/stats-format.js';
import { resolveSongMeta } from '../../shared/song-metadata.js';
import { escapeHtml } from './helpers.js';
import { playSong } from './playback.js';

const TIER_LABELS = { hires: 'Hi-Res', sq: 'SQ', hq: 'HQ', other: 'Other' };
const CHART_LIMIT = 20;

// 最近一次从主进程拉取的统计(计数卡与排行渲染共用)
let statsData = { plays: {}, firstPlayDate: null };

export function isStatsOpen() {
  return statsOverlay.classList.contains('open');
}

export function openStats() {
  statsOverlay.classList.add('open');
  // 互斥:打开统计面板时收起两个抽屉
  playlistDrawer.classList.remove('open');
  playlistsDrawer.classList.remove('open');
  syncVinylSpin();
  refreshStats();
}

export function closeStats() {
  statsOverlay.classList.remove('open');
}

export function toggleStats() {
  if (isStatsOpen()) closeStats();
  else openStats();
}

// 歌曲切换时(playSong / initSongInfo)由 playback.js 调用,保持左栏信息同步
export function onSongChanged() {
  if (isStatsOpen()) refreshLiveCard();
}

// 封面就绪时由 playback.js 调用,更新唱片贴纸
export function onCoverReady(coverUrl) {
  if (isStatsOpen()) applyVinylCover(coverUrl);
}

export function bindStatsEvents() {
  if (btnStatsClose) btnStatsClose.onclick = closeStats;

  // 点击卡片外部遮罩关闭
  statsOverlay.addEventListener('click', (e) => {
    if (e.target === statsOverlay) closeStats();
  });

  // 排行行点击:切到对应歌曲播放(与播放列表点击行为一致)
  statsChartList.addEventListener('click', (e) => {
    const item = e.target.closest('.stats-chart-item');
    if (!item || !item.dataset.path) return;
    const index = state.songs.findIndex((s) => s.path === item.dataset.path);
    if (index >= 0) playSong(index);
  });

  // 歌曲播完计次后刷新面板数据
  audio.addEventListener('ended', () => {
    if (isStatsOpen()) refreshStats();
  });

  // 唱片旋转跟随播放状态
  audio.addEventListener('play', syncVinylSpin);
  audio.addEventListener('pause', syncVinylSpin);
}

async function refreshStats() {
  try {
    const stats = await window.dreamApi.getStats();
    statsData = stats || { plays: {}, firstPlayDate: null };
  } catch (e) {
    return;
  }
  refreshLiveCard();
  renderChart(statsData);
}

function syncVinylSpin() {
  statsOverlay.classList.toggle('playing', !audio.paused);
}

function applyVinylCover(url) {
  if (url) {
    statsVinylCover.src = url;
    statsVinylCover.style.display = 'block';
    statsVinylFallback.style.display = 'none';
  } else {
    statsVinylCover.src = '';
    statsVinylCover.style.display = 'none';
    statsVinylFallback.style.display = 'block';
  }
}

function refreshLiveCard() {
  // 歌单队列的歌曲快照可能缺音质规格字段,按 path 回查曲库补全
  const song = resolveSongMeta(state.songs[state.currentIndex], buildMetaMap());
  if (!song) {
    statsSongTitle.textContent = '--';
    statsSongArtist.textContent = t('stats.unavailable');
    statsTier.className = 'stats-tier tier-other';
    statsTier.textContent = '--';
    statsAlbum.textContent = '--';
    statsBitrate.textContent = '--';
    statsSampleRate.textContent = '--';
    statsBits.textContent = '--';
    statsFullPlays.textContent = '0';
    statsLoopPlays.textContent = '0';
    applyVinylCover(null);
    return;
  }

  statsSongTitle.textContent = song.title;
  statsSongArtist.textContent = song.artist;

  const tier = classifyTier(song);
  statsTier.className = `stats-tier tier-${tier}`;
  statsTier.textContent = TIER_LABELS[tier];

  statsAlbum.textContent = song.album || '--';
  statsBitrate.textContent = formatBitrate(song.bitrate);
  statsSampleRate.textContent = formatSampleRate(song.sampleRate);
  statsBits.textContent = song.bitsPerSample ? `${song.bitsPerSample}-bit` : '--';

  const entry = statsData.plays[song.path] || { full: 0, loop: 0 };
  statsFullPlays.textContent = entry.full;
  statsLoopPlays.textContent = entry.loop;

  applyVinylCover(state.currentCoverBlobUrl);
}

// 曲库歌曲元数据索引:排行行需要标题/艺术家(统计中可能含有已移出曲库的残留路径,兜底用文件名)
function buildMetaMap() {
  const map = new Map();
  const source = state.librarySongs.length > 0 ? state.librarySongs : state.songs;
  for (const s of source) map.set(s.path, { title: s.title, artist: s.artist });
  return map;
}

function renderChart(stats) {
  const ranking = buildRanking(stats);
  statsTotalPlays.textContent = totalPlays(stats);
  statsRankedCount.textContent = ranking.length;
  statsDailyAvg.textContent = dailyAverage(stats, Date.now());

  if (ranking.length === 0) {
    statsChartList.innerHTML = '';
    statsEmptyEl.hidden = false;
    return;
  }
  statsEmptyEl.hidden = true;

  const metaMap = buildMetaMap();
  const currentPath = state.songs[state.currentIndex] ? state.songs[state.currentIndex].path : null;
  const max = ranking[0].total;

  statsChartList.innerHTML = ranking
    .slice(0, CHART_LIMIT)
    .map((r, i) => {
      const meta = metaMap.get(r.path);
      const title = meta ? meta.title : r.path.replace(/^.*[\\/]/, '');
      const artist = meta ? meta.artist : '';
      const playing = r.path === currentPath ? ' playing' : '';
      const rankClass = i < 3 ? ` r${i + 1}` : '';
      const width = Math.max(4, Math.round((r.total / max) * 100));
      return `
        <li class="stats-chart-item${playing}" data-path="${escapeHtml(r.path)}">
          <span class="stats-rank${rankClass}">${String(i + 1).padStart(2, '0')}</span>
          <div class="stats-chart-song">
            <div class="stats-chart-song-top">
              <span class="stats-chart-name">${escapeHtml(title)}</span>
              <span class="stats-chart-count"><b>${r.total}</b> ${t('stats.timesUnit')}</span>
            </div>
            <div class="stats-chart-artist">${escapeHtml(artist)}</div>
            <div class="stats-chart-bar"><i style="--w:${width}%"></i></div>
          </div>
        </li>`;
    })
    .join('');
}
