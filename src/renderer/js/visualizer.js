// 频谱可视化：进度条已播放段上的一排竖条。这里是**模拟频谱**，不是实时分析 ——
// 不要顺手接 AnalyserNode：它默认量程 −30dB 会把低频整段削成平顶，绘制循环还会
// 和播放状态恢复的时序打架。模拟版只跟 play/pause 两个事件，任何情况下都稳定。
//
// 绘制用单块 canvas：旧版是 160 个 <i>，每帧写 height/top 会触发 160 次布局，
// 每根条还带 will-change: opacity（合成层数量直接翻到 160+），弱 GPU 上尤其明显。
// canvas 只占一个元素、一个合成层，每帧画 160 个矩形，不碰页面布局。

const BAR_COUNT = 160;
const BAR_MAX_H = 28; // 与 .viz-bars 的高度一致
const BAR_W = 3; // 与旧版 .viz-bars i 的宽度一致

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
      if (!audioEl.paused && !performanceMode && !rafId) start();
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
    if (!audioEl.paused && !performanceMode && !rafId) start();
  };
  window.addEventListener('resize', layout);
  relayout = layout;

  // 每根条一个固定的振幅与相位，避免排成整齐的梳子。
  // 振幅用平方分布 → 少数高峰、大量矮条，比均匀分布更像真实频谱。
  const amp = new Float32Array(BAR_COUNT);
  const phase = new Float32Array(BAR_COUNT);
  const rate = new Float32Array(BAR_COUNT);
  for (let i = 0; i < BAR_COUNT; i++) {
    const r = Math.random();
    amp[i] = 0.28 + 0.72 * r * r;
    phase[i] = Math.random() * 6.283;
    rate[i] = 300 + Math.random() * 260;
  }
  const vals = new Float32Array(BAR_COUNT);

  let lastDrawAt = 0;
  const draw = (t) => {
    if (!ctx) return;
    if (cssWidth <= 0) {
      rafId = 0;
      return;
    }

    // 限制在 ~70fps：120/144Hz 屏幕上没必要为了模拟频谱按屏幕刷新率重画。
    // 阈值取 14ms，60Hz 一帧不落，120Hz 每两帧画一次，240Hz 每四帧画一次。
    if (t - lastDrawAt < 14) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    lastDrawAt = t;

    ctx.clearRect(0, 0, cssWidth, BAR_MAX_H);
    ctx.fillStyle = barColor;

    const pitch = cssWidth / BAR_COUNT;
    for (let i = 0; i < BAR_COUNT; i++) {
      const env = Math.pow(1 - i / BAR_COUNT, 0.8); // 低频高、高频低
      const beat = 0.3 + 0.7 * Math.abs(Math.sin(t / rate[i] + phase[i]));
      const kick = i < BAR_COUNT * 0.12 ? 0.25 * Math.abs(Math.sin(t / 190)) : 0;
      const target = Math.min(1, amp[i] * (0.35 + 0.65 * env) * beat + kick * amp[i]);
      vals[i] += (target - vals[i]) * 0.32;
      const h = Math.max(2.5, vals[i] * BAR_MAX_H);
      const x = i * pitch;
      const y = (BAR_MAX_H - h) / 2;
      const alpha = 0.45 + 0.55 * vals[i];

      // 宽一点的半透明底当光晕，替代原来 .viz-bars 上的 drop-shadow 滤镜 ——
      // 滤镜会让整块动画内容每帧重新离屏渲染，是旧版的主要 GPU 开销之一。
      // 用 roundRect 而不是 fillRect：旧版每根条是 3px 宽、2px 圆角的胶囊，
      // 方角矩形看起来会明显更硬、更「像素」。
      ctx.globalAlpha = alpha * 0.18;
      ctx.beginPath();
      ctx.roundRect(x - 2, y, BAR_W + 4, h, Math.min((BAR_W + 4) / 2, h / 2));
      ctx.fill();

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.roundRect(x, y, BAR_W, h, Math.min(BAR_W / 2, h / 2));
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    rafId = requestAnimationFrame(draw);
  };

  function start() {
    // 性能模式：不画频谱，保持暂停形态的那条实线（进度本身仍由 updateProgressStyle 更新）
    if (performanceMode) return;
    // 元素隐藏时（小窗模式）不空转绘制循环；退出小窗后 relayoutVisualizer 会再调一次
    if ((wrap || containerEl).clientWidth <= 0) return;
    containerEl.classList.remove('paused');
    lastDrawAt = 0;
    if (!rafId && cssWidth > 0) rafId = requestAnimationFrame(draw);
  }

  // 暂停：停掉循环、清空 canvas、加 paused 类，由 .viz-bars.paused::after 接管成一条实线
  // —— 也就是「回归进度条本身」。
  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    containerEl.classList.add('paused');
    if (ctx && cssWidth > 0) ctx.clearRect(0, 0, cssWidth, BAR_MAX_H);
  }

  applyMode = () => {
    if (performanceMode || audioEl.paused || cssWidth <= 0) stop();
    else start();
  };

  audioEl.addEventListener('play', start);
  audioEl.addEventListener('pause', stop);

  // 初始排布必须在 draw/start 定义之后：layout 里恢复播放时会引用它们
  layout();

  // 初始化时可能已经在播放（状态恢复）；性能模式开启时停成进度线
  applyMode();
}
