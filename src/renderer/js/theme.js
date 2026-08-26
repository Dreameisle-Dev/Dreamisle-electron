import { state } from './state.js';
import { canvas, progressBar } from './dom.js';

// 根据封面主色调更新 CSS 变量（设在根节点：ambient 背景与帮助浮层都能继承）
export function updateThemeColor(src) {
  const root = document.documentElement;
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
    let r = 0,
      g = 0,
      b = 0,
      c = 0;
    for (let i = 0; i < data.length; i += 4) {
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      if ((max + min) / 2 > 20 && max - min > 30) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        c++;
      }
    }
    if (c > 0) {
      r = Math.floor(r / c);
      g = Math.floor(g / c);
      b = Math.floor(b / c);
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

export function updateProgressStyle(value) {
  progressBar.style.setProperty('--progress', `${value}%`);

  if (state.isMiniMode) {
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

// 环境光跟随鼠标缓动
export function initMouseFollow() {
  const ambientBg = document.querySelector('.ambient-bg');

  document.addEventListener('mousemove', (e) => {
    state.targetMouseX = (e.clientX / window.innerWidth) * 100;
    state.targetMouseY = (e.clientY / window.innerHeight) * 100;
    if (!state.isAnimating) {
      state.isAnimating = true;
      requestAnimationFrame(animateMouseFollow);
    }
  });

  function animateMouseFollow() {
    const dx = state.targetMouseX - state.mouseX;
    const dy = state.targetMouseY - state.mouseY;

    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
      state.isAnimating = false;
      return;
    }

    state.mouseX += dx * 0.05;
    state.mouseY += dy * 0.05;

    if (ambientBg) {
      ambientBg.style.setProperty('--mouse-x', `${state.mouseX}%`);
      ambientBg.style.setProperty('--mouse-y', `${state.mouseY}%`);
    }

    const lightField = document.querySelector('.light-field');
    if (lightField) {
      const offsetX = (state.mouseX - 50) * 0.15;
      const offsetY = (state.mouseY - 50) * 0.15;
      // 将缩放值改为固定的 scale(5)，保证暂停状态下背景灯光依然铺满全屏
      lightField.style.transform = `translate3d(${offsetX}%, ${offsetY}%, 0) scale(5)`;
    }

    if (state.isAnimating) requestAnimationFrame(animateMouseFollow);
  }
}
