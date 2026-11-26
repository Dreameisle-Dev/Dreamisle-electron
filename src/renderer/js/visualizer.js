// 实时频谱可视化：进度条已播放段上的一排竖条，由共享 Web Audio 图的 AnalyserNode 驱动。
//
// 针对真实 FFT 频谱常见坑做了四层处理：
// 1) 读 getFloatFrequencyData 原始 dBFS（不走默认 −30dB 上限的 byte 截断），杜绝低频削顶成平砖；
// 2) 补偿 audio.volume 衰减（Chromium 的 MediaElementAudioSourceNode 受元素音量缩放），低音量下仍饱满，静音/0 音量自然归零；
// 3) 按 36Hz–13.5kHz 对数频带 + +3dB/倍频程粉噪倾斜 + 44dB 自适应动态量程（AGC），轻柔钢琴与强节奏舞曲都层次分明；
// 4) 仅映射并绘制当前已播放宽度对应的竖条区间，开歌前几秒原声/人声前奏也立刻有真实律动，同时省掉未播放裁剪区的无效绘制。
//
// 绘制仍复用单块 canvas 与预分配 TypedArray，零 DOM 回流、零每帧堆分配。

import { ensureAudioGraph, getAudioGraph, resumeAudioGraph } from './audio-graph.js';

const BAR_COUNT = 160;
const BAR_MAX_H = 28; // 与 .viz-bars 的高度一致
const BAR_W = 3; // 每根频谱胶囊的 CSS 宽度

const MIN_FREQ_HZ = 36;
const MAX_FREQ_HZ = 13500;
const TILT_REF_HZ = 250;
const TILT_DB_PER_OCTAVE = 3.0;
const NOISE_FLOOR_DB = -82;
const DYNAMIC_RANGE_DB = 44;
const HEADROOM_DB = 3.0;
const INITIAL_PEAK_DB = -26;

let containerEl = null;
let canvasEl = null;
let ctx = null;
let relayout = null; // initVisualizer 里挂上重排函数，供窗口模式切换后显式调用
let rafId = 0;
let cssWidth = 0; // 波形区的完整宽度（不是进度段宽度）
let barColor = '#ffffff';
let themeMq = null;
let themeObserver = null;

// 性能模式的标志可能在 init 之前就被设置（启动时读取设置），所以单独存在模块级；
// init 后再挂一个 applyMode 回调，让开关即时生效。
let performanceMode = false;
let applyMode = null;

export function relayoutVisualizer() {
  if (relayout) relayout();
}

export function setVisualizerPerformanceMode(enabled) {
  performanceMode = !!enabled;
  if (applyMode) applyMode();
}

export function initVisualizer(audioEl, containerElArg) {
  if (!containerElArg) return;

  containerEl = containerElArg;
  containerEl.innerHTML = '';
  containerEl.classList.add('paused');

  canvasEl = document.createElement('canvas');
  // 从 .viz-bars 的计算色取色（CSS 里 .viz-bars 设了 color: var(--ink1)）。
  // canvas 不认 currentColor，所以拿 getComputedStyle 解析好的颜色值。
  containerEl.appendChild(canvasEl);
  ctx = canvasEl.getContext('2d', { alpha: true });

  // 条的横坐标用**像素**算、以 .viz-wrap 的满宽为基准。
  // 不能用百分比 —— .viz-bars 的宽度随播放进度变化（它同时充当裁剪窗口），
  // 用百分比会让条的密度跟着进度变：30% 时 160 根挤在 30% 宽度里，100% 时铺满。
  // canvas 本身按满宽绘制，超出进度段的像素由 .viz-bars 的 overflow: hidden 裁掉。
  const wrap = containerEl.closest('.viz-wrap') || containerEl.parentElement;

  const readBarColor = () => {
    const color = getComputedStyle(containerEl).color;
    if (color) barColor = color;
  };
  readBarColor();

  // 主题切换（系统深浅色或设置里固定主题）会改 --ink1，重新读一次计算色。
  // 不逐帧读：getComputedStyle 会强制样式刷新，放在 rAF 里反而变成新的热点。
  themeMq = matchMedia('(prefers-color-scheme: dark)');
  themeMq.addEventListener('change', readBarColor);
  themeObserver = new MutationObserver(readBarColor);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });

  // 全部复用的预分配数组，热循环内零对象分配
  let freqDb = null;
  const rawBarDb = new Float32Array(BAR_COUNT);
  const normEnergy = new Float32Array(BAR_COUNT);
  const smoothedEnergy = new Float32Array(BAR_COUNT);
  const vals = new Float32Array(BAR_COUNT);
  const bandStartBin = new Float32Array(BAR_COUNT);
  const bandEndBin = new Float32Array(BAR_COUNT);
  const bandTiltDb = new Float32Array(BAR_COUNT);

  let cachedSpan = -1;
  let cachedSampleRate = 0;
  let cachedFftSize = 0;
  let rollingPeakDb = INITIAL_PEAK_DB;

  function ensureBandMap(span, sampleRate, fftSize) {
    if (span === cachedSpan && sampleRate === cachedSampleRate && fftSize === cachedFftSize) return;
    // 大幅跳转进度（如点击进度条）时重置平滑残留，避免旧频段位置短暂残留在新低频区
    if (cachedSpan > 0 && Math.abs(span - cachedSpan) > 4) {
      vals.fill(0);
    }
    cachedSpan = span;
    cachedSampleRate = sampleRate;
    cachedFftSize = fftSize;

    const maxFreq = Math.min(MAX_FREQ_HZ, sampleRate * 0.44);
    const ratio = maxFreq / MIN_FREQ_HZ;
    const binHz = sampleRate / fftSize;
    const maxBin = fftSize / 2 - 1;

    for (let i = 0; i < span; i++) {
      const f0 = MIN_FREQ_HZ * Math.pow(ratio, i / span);
      const f1 = MIN_FREQ_HZ * Math.pow(ratio, (i + 1) / span);
      const fMid = Math.sqrt(f0 * f1);
      const b0 = Math.max(1, Math.min(maxBin, f0 / binHz));
      const b1 = Math.max(b0, Math.min(maxBin, f1 / binHz));
      bandStartBin[i] = b0;
      bandEndBin[i] = b1;
      bandTiltDb[i] = Math.max(
        -6,
        Math.min(12, Math.log2(fMid / TILT_REF_HZ) * TILT_DB_PER_OCTAVE)
      );
    }
  }

  function getActiveSpan() {
    const duration = audioEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) return 1;
    const progress = Math.min(1, Math.max(0, (audioEl.currentTime || 0) / duration));
    // 多留 1 根缓冲，避免 4Hz timeupdate 与 60fps 渲染之间在播放头边缘出现细缝
    return Math.min(BAR_COUNT, Math.max(1, Math.ceil(progress * BAR_COUNT) + 1));
  }

  function sampleSpectrum(analyser, sampleRate, span) {
    const binCount = analyser.frequencyBinCount;
    if (!freqDb || freqDb.length !== binCount) {
      freqDb = new Float32Array(binCount);
    }

    ensureBandMap(span, sampleRate, analyser.fftSize);

    const silent = audioEl.muted || audioEl.volume <= 0.001;
    if (silent) {
      rawBarDb.fill(-Infinity, 0, span);
      return -Infinity;
    }

    analyser.getFloatFrequencyData(freqDb);
    const volCompDb = -20 * Math.log10(Math.max(0.02, audioEl.volume));

    let framePeakDb = -Infinity;
    for (let i = 0; i < span; i++) {
      const b0 = bandStartBin[i];
      const b1 = bandEndBin[i];
      let sampled = -Infinity;

      if (b1 - b0 <= 1.0) {
        // 低频区单条窄于 1 个 FFT bin：线性插值消除阶梯块感
        const mid = (b0 + b1) * 0.5;
        const lo = Math.floor(mid);
        const hi = Math.min(binCount - 1, lo + 1);
        const frac = mid - lo;
        const v0 = freqDb[lo];
        const v1 = freqDb[hi];
        if (Number.isFinite(v0) && Number.isFinite(v1)) {
          sampled = v0 + (v1 - v0) * frac;
        } else if (Number.isFinite(v0)) {
          sampled = v0;
        } else if (Number.isFinite(v1)) {
          sampled = v1;
        }
      } else {
        // 中高频多 bin 聚合：在线性功率域求均值（RMS）并与峰值加权。
        // 不能直接在 dB 域做算术平均——高频单条覆盖几十个 bin，少量强谐波被大量底噪 bin
        // 的 −110dB 拉垮（相当于几何平均），会导致钢琴高音、弦乐泛音与镲片泛音偏闷。
        const start = Math.floor(b0);
        const end = Math.min(binCount - 1, Math.ceil(b1));
        let maxV = -Infinity;
        let powerSum = 0;
        const binSpan = end - start + 1;
        for (let b = start; b <= end; b++) {
          const v = freqDb[b];
          if (Number.isFinite(v) && v > -120) {
            if (v > maxV) maxV = v;
            powerSum += Math.pow(10, v * 0.1);
          }
        }
        if (powerSum > 0 && Number.isFinite(maxV)) {
          const rmsDb = 10 * Math.log10(powerSum / binSpan);
          sampled = maxV * 0.7 + rmsDb * 0.3;
        }
      }

      const db = Number.isFinite(sampled) ? sampled + volCompDb + bandTiltDb[i] : -Infinity;
      rawBarDb[i] = db;
      if (db > framePeakDb) framePeakDb = db;
    }

    return framePeakDb;
  }

  const layout = () => {
    const w = (wrap || containerEl).clientWidth;
    if (!w) {
      // 隐藏时宽度为 0（小窗模式下 .viz-wrap 是 display:none）：保留上一次的正确值，
      // 别把条全压到 0；同时停掉绘制循环，别给隐藏的 canvas 白跑 rAF。
      stop();
      return;
    }

    if (w === cssWidth) {
      // 宽度没变但可能是从隐藏状态恢复（进/出小窗时 resize 不一定会触发）：
      // 播放中且循环没跑就把它接回来。
      if (!audioEl.paused && !performanceMode && !document.hidden && !rafId) start();
      return;
    }
    cssWidth = w;
    const dpr = window.devicePixelRatio || 1;
    canvasEl.width = Math.max(1, Math.round(w * dpr));
    canvasEl.height = Math.max(1, Math.round(BAR_MAX_H * dpr));
    canvasEl.style.width = `${w}px`;
    canvasEl.style.height = `${BAR_MAX_H}px`;
    // width/height 赋值会重置上下文状态，所以 transform 必须在后面重设
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 暂停时 canvas 应保持空白（由 .viz-bars.paused::after 画实线）；
    // 播放中则等下一帧 rAF 重绘。
    ctx.clearRect(0, 0, w, BAR_MAX_H);

    // 从隐藏状态恢复（例如退出小窗）：播放中且非性能模式时重新起循环
    if (!audioEl.paused && !performanceMode && !document.hidden && !rafId) start();
  };
  window.addEventListener('resize', layout);
  relayout = layout;

  let lastDrawAt = 0;
  const draw = (t) => {
    if (!ctx) return;
    if (cssWidth <= 0 || document.hidden || performanceMode || audioEl.paused) {
      rafId = 0;
      return;
    }

    // 限制在 ~70fps：120/144Hz 屏幕上没必要按超高刷重复重绘频谱。
    if (t - lastDrawAt < 14) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    lastDrawAt = t;

    const graph = getAudioGraph();
    if (!graph) {
      stop();
      return;
    }

    const span = getActiveSpan();
    const framePeakDb = sampleSpectrum(graph.analyser, graph.ctx.sampleRate, span);

    // 自适应动态量程：仅在有真实音频能量时更新滚动峰值，静默段不拉低阈值避免下一拍爆顶
    if (framePeakDb > -74) {
      const clampedPeak = Math.max(-46, Math.min(0, framePeakDb));
      const coeff = clampedPeak > rollingPeakDb ? 0.16 : 0.015;
      rollingPeakDb += (clampedPeak - rollingPeakDb) * coeff;
    }

    const ceilDb = rollingPeakDb + HEADROOM_DB;
    const floorDb = Math.max(NOISE_FLOOR_DB, ceilDb - DYNAMIC_RANGE_DB);
    const invRange = 1 / Math.max(12, ceilDb - floorDb);

    for (let i = 0; i < span; i++) {
      const db = rawBarDb[i];
      if (!Number.isFinite(db) || db <= floorDb) {
        normEnergy[i] = 0;
      } else {
        const linear = Math.min(1, (db - floorDb) * invRange);
        normEnergy[i] = Math.pow(linear, 1.35);
      }
    }

    // 轻度三点空间平滑，让相邻频谱条过渡成流畅起伏的波浪，同时保留高频窄峰瞬态
    if (span >= 3) {
      smoothedEnergy[0] = normEnergy[0] * 0.86 + normEnergy[1] * 0.14;
      for (let i = 1; i < span - 1; i++) {
        smoothedEnergy[i] =
          normEnergy[i - 1] * 0.12 + normEnergy[i] * 0.76 + normEnergy[i + 1] * 0.12;
      }
      smoothedEnergy[span - 1] = normEnergy[span - 1] * 0.86 + normEnergy[span - 2] * 0.14;
    } else {
      for (let i = 0; i < span; i++) smoothedEnergy[i] = normEnergy[i];
    }

    ctx.clearRect(0, 0, cssWidth, BAR_MAX_H);
    ctx.fillStyle = barColor;

    const pitch = cssWidth / BAR_COUNT;
    for (let i = 0; i < span; i++) {
      const target = smoothedEnergy[i];
      // 快攻慢放：鼓点上升干脆，回落柔顺自然
      vals[i] += (target - vals[i]) * (target > vals[i] ? 0.56 : 0.18);
      const v = vals[i];
      const h = Math.max(2.5, v * BAR_MAX_H);
      const x = i * pitch;
      const y = (BAR_MAX_H - h) / 2;
      const alpha = 0.4 + 0.6 * v;

      // 宽一点的半透明底当光晕，替代 drop-shadow 滤镜避免每帧整块离屏渲染
      ctx.globalAlpha = alpha * 0.18;
      ctx.beginPath();
      ctx.roundRect(x - 2, y, BAR_W + 4, h, Math.min((BAR_W + 4) / 2, h / 2));
      ctx.fill();

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.roundRect(x, y, BAR_W, h, Math.min(BAR_W / 2, h / 2));
      ctx.fill();
    }
    for (let i = span; i < BAR_COUNT; i++) {
      if (vals[i] > 0) vals[i] = 0;
    }
    ctx.globalAlpha = 1;

    rafId = requestAnimationFrame(draw);
  };

  function start() {
    // 性能模式或页面隐藏时不跑频谱绘制，保持实线进度条
    if (performanceMode || document.hidden) return;
    // 元素隐藏时（小窗模式）不空转绘制循环；退出小窗后 relayoutVisualizer 会再调一次
    if ((wrap || containerEl).clientWidth <= 0) return;

    const graph = ensureAudioGraph();
    if (!graph) return;
    resumeAudioGraph();

    containerEl.classList.remove('paused');
    lastDrawAt = 0;
    if (!rafId && cssWidth > 0) rafId = requestAnimationFrame(draw);
  }

  // 暂停：停掉循环、清空 canvas、加 paused 类，由 .viz-bars.paused::after 接管成一条实线
  // —— 也就是「回归进度条本身」。
  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    vals.fill(0);
    rollingPeakDb = INITIAL_PEAK_DB;
    containerEl.classList.add('paused');
    if (ctx && cssWidth > 0) ctx.clearRect(0, 0, cssWidth, BAR_MAX_H);
  }

  applyMode = () => {
    if (performanceMode || document.hidden || audioEl.paused || cssWidth <= 0) stop();
    else start();
  };

  // 非性能模式下在首次播放前先把共享 Web Audio 图建好，避免中途接管输出产生爆音
  if (!performanceMode) {
    ensureAudioGraph();
  }

  audioEl.addEventListener('play', start);
  audioEl.addEventListener('playing', start);
  audioEl.addEventListener('pause', stop);
  audioEl.addEventListener('ended', stop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else applyMode();
  });

  // 初始排布必须在 draw/start 定义之后：layout 里恢复播放时会引用它们
  layout();

  // 初始化时可能已经在播放（状态恢复）；性能模式开启时停成进度线
  applyMode();
}
