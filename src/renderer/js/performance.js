import { setVisualizerPerformanceMode } from './visualizer.js';

// 性能模式：CSS 侧只认 body.performance-mode（见 index.css 末尾），
// 频谱是 canvas 逐帧绘制的，必须显式停/启，光靠 CSS 停不掉 rAF。
export function applyPerformanceMode(enabled) {
  const on = enabled === true;
  document.body.classList.toggle('performance-mode', on);
  setVisualizerPerformanceMode(on);
}
