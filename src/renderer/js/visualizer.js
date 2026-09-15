// 频谱可视化：进度条已播放段上的一排竖条。
//
// 这里是**模拟频谱**，不是 Web Audio 的实时分析。
// 实时方案（AudioContext + createMediaElementSource + AnalyserNode）在 Electron 下
// 有三个难缠问题：会接管音频输出链路、默认量程 −30dB 导致低频整段削顶成平顶、
// 以及与播放状态恢复的时序冲突会让绘制循环静默死掉。
// 模拟版在任何情况下都稳定，观感与设计稿一致。

const BAR_COUNT = 160;
const BAR_MAX_H = 28; // 与 .viz-bars 的高度一致

let bars = [];
let rafId = 0;

export function initVisualizer(audioEl, containerEl) {
  if (!containerEl) return;

  containerEl.innerHTML = '';
  bars = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const b = document.createElement('i');
    containerEl.appendChild(b);
    bars.push(b);
  }

  // 条的横坐标用**像素**算、以 .viz-wrap 的满宽为基准。
  // 不能用百分比 —— .viz-bars 的宽度随播放进度变化（它同时充当裁剪窗口），
  // 用百分比会让条的密度跟着进度变：30% 时 160 根挤在 30% 宽度里，100% 时铺满。
  const wrap = containerEl.closest('.viz-wrap') || containerEl.parentElement;
  const layout = () => {
    const w = (wrap || containerEl).clientWidth;
    if (!w) return;
    const pitch = w / BAR_COUNT;
    for (let i = 0; i < bars.length; i++) {
      bars[i].style.left = `${(i * pitch).toFixed(2)}px`;
    }
  };
  layout();
  window.addEventListener('resize', layout);

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

  const draw = (t) => {
    for (let i = 0; i < BAR_COUNT; i++) {
      const env = Math.pow(1 - i / BAR_COUNT, 0.8); // 低频高、高频低
      const beat = 0.3 + 0.7 * Math.abs(Math.sin(t / rate[i] + phase[i]));
      const kick = i < BAR_COUNT * 0.12 ? 0.25 * Math.abs(Math.sin(t / 190)) : 0;
      const target = Math.min(1, amp[i] * (0.35 + 0.65 * env) * beat + kick * amp[i]);
      vals[i] += (target - vals[i]) * 0.32;
      const h = Math.max(2.5, vals[i] * BAR_MAX_H);
      bars[i].style.height = `${h.toFixed(1)}px`;
      // 必须按中心对齐重设 top。CSS 里 i 的 top 固定在 13px（暗线所在位置），
      // 不重设的话所有条都从暗线往下长、且被 28px 高的容器裁掉一半 ——
      // 矮条和暗线完全重合，看上去就是「没有频谱」。
      bars[i].style.top = `${((BAR_MAX_H - h) / 2).toFixed(1)}px`;
      bars[i].style.opacity = (0.45 + 0.55 * vals[i]).toFixed(2);
    }
    rafId = requestAnimationFrame(draw);
  };

  const start = () => {
    if (!rafId) rafId = requestAnimationFrame(draw);
  };
  // 暂停时把条收回底线并停掉循环：让「停了」这件事看得见，也省掉无意义的绘制
  const stop = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    for (let i = 0; i < BAR_COUNT; i++) {
      bars[i].style.height = '2.5px';
      bars[i].style.opacity = '0.45';
    }
  };

  audioEl.addEventListener('play', start);
  audioEl.addEventListener('pause', stop);
  // 初始化时可能已经在播放（状态恢复），补一次
  if (!audioEl.paused) start();
}
