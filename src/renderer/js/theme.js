import { state } from './state.js';
import { canvas } from './dom.js';

// 当前生效的是浅色还是深色。三种模式都要判对：
//   .theme-light → 'light'；.theme-dark → 'dark'；跟随系统 → 'light dark'，用媒体查询兜底。
function isLightTheme() {
  const cs = getComputedStyle(document.documentElement).colorScheme;
  if (cs === 'light') return true;
  if (cs === 'dark') return false;
  return matchMedia('(prefers-color-scheme: light)').matches;
}

// 最近一次用过的封面地址：切换主题后要拿它重算色斑
let lastCoverSrc = null;

// 切换主题模式。'system' 时不挂类，交给 prefers-color-scheme；
// 'light'/'dark' 挂类覆盖（tokens.css 里的 :root.theme-* 选择器）。
// 主进程那边同步把 nativeTheme.themeSource 也设成同一个值。
export function applyThemeMode(mode) {
  const root = document.documentElement;
  root.classList.toggle('theme-light', mode === 'light');
  root.classList.toggle('theme-dark', mode === 'dark');
  // 色斑透明度按主题分了两档（浅色要更透），换主题得重算一次
  if (lastCoverSrc) updateThemeColor(lastCoverSrc);
}

// 色相角 0..360；灰色（无彩度）返回 -1
function hueOf(r, g, b) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return -1;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

// 不足 4 个色斑时补位用的明暗档：四个斑全同色会糊成一坨，错开才有层次
const BLOB_STEPS = [1, 1.22, 0.82, 1.42];

// 从封面里取最多 count 个主色。
//
// 旧实现只取「一个饱和均值」，再给 R+40 / B+20 造第二个色 —— 那个盲目的通道偏移
// 会把中性封面推成紫色（青灰的封面算出 rgb(109,87,108)）。而且它只写 --c1/--c2，
// --c3/--c4 永远停在 tokens.css 的写死值上，等于光场有一半是固定色。
//
// 现在按色相分 12 桶投票，票重 = 饱和度 × 中间调权重，取票数最高的几个桶。
// 相邻桶（30° 一档）是同一个色相被切开的，必须合并，否则四个斑会糊成一片。
function extractPalette(data, count) {
  const BUCKETS = 12;
  const acc = Array.from({ length: BUCKETS }, () => ({ r: 0, g: 0, b: 0, w: 0 }));
  let ar = 0,
    ag = 0,
    ab = 0,
    n = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    ar += r;
    ag += g;
    ab += b;
    n++;

    const max = Math.max(r, g, b);
    const light = (max + Math.min(r, g, b)) / 510;
    if (light < 0.07 || light > 0.96) continue; // 纯黑/纯白没有可用色相
    const w = (max ? (max - Math.min(r, g, b)) / max : 0) * (1 - Math.abs(light - 0.5) * 1.3);
    if (w <= 0.02) continue; // 灰阶像素不参与投票

    const k = acc[Math.min(BUCKETS - 1, Math.floor((hueOf(r, g, b) / 360) * BUCKETS))];
    k.r += r * w;
    k.g += g * w;
    k.b += b * w;
    k.w += w;
  }

  const picked = [];
  const order = acc.map((k, i) => ({ k, i })).sort((a, b) => b.k.w - a.k.w);
  // 主色门槛：一个色相的票数不到榜首的 1/5，就说明它只是封面里的一小块点缀。
  // 不加这道闸，几个高明度的杂色像素就能挤进色斑，背景会和封面的整体印象对不上
  // （深青的封面被算出橙+绿）。不够格的位置改用已选色的明暗档补。
  const floor = order.length ? order[0].k.w * 0.2 : 0;
  for (const { k, i } of order) {
    if (picked.length >= count || k.w <= 0 || k.w < floor) break;
    const clash = picked.some((p) => {
      const gap = Math.abs(p.i - i);
      return Math.min(gap, BUCKETS - gap) < 2;
    });
    if (clash) continue;
    picked.push({
      i,
      r: Math.round(k.r / k.w),
      g: Math.round(k.g / k.w),
      b: Math.round(k.b / k.w),
    });
  }

  // 完全无彩的封面（黑白/灰阶）：用整体均值按明暗档铺开，
  // 得到的是灰场 —— 而不是残留的主题紫。暗封面要提亮才看得见，
  // 亮封面要压暗，否则色斑会和底色糊在一起。
  if (picked.length === 0) {
    const base = n
      ? { r: Math.round(ar / n), g: Math.round(ag / n), b: Math.round(ab / n) }
      : { r: 128, g: 128, b: 128 };
    const lum = (base.r * 0.299 + base.g * 0.587 + base.b * 0.114) / 255;
    // 用加性平移而不是乘法缩放：纯黑的通道值是 0，乘任何系数都还是 0，
    // 会得到一个全黑的光场。平移才能把它抬成看得见的深灰。
    const shift = (lum < 0.5 ? 0.55 : 0.42) * 255 - lum * 255;
    return BLOB_STEPS.slice(0, count).map((s) => ({
      r: clamp255(base.r + shift * s),
      g: clamp255(base.g + shift * s),
      b: clamp255(base.b + shift * s),
    }));
  }

  // 有彩但不满 4 个桶：拿已选到的颜色按明暗档补位
  const seed = picked.slice();
  while (picked.length < count) {
    const s = seed[picked.length % seed.length];
    const f = BLOB_STEPS[picked.length];
    picked.push({ i: s.i, r: clamp255(s.r * f), g: clamp255(s.g * f), b: clamp255(s.b * f) });
  }
  return picked.map(({ r, g, b }) => ({ r, g, b }));
}

// 根据封面主色调更新光场色斑（写在根节点，ambient 背景与浮层都能继承）。
// 写的是「颜色值」而非 rgb 三元组 —— 淡出到同色零透明由 CSS 的
// 相对颜色语法 rgb(from var(--c1) r g b / 0) 处理。
export function updateThemeColor(src) {
  lastCoverSrc = src || null;
  const root = document.documentElement;
  if (!src) {
    // 移除内联覆盖，回落到 tokens.css 里按主题定义的默认色斑
    for (const v of ['--c1', '--c2', '--c3', '--c4']) root.style.removeProperty(v);
    return;
  }
  const img = new Image();
  img.src = src;
  img.onload = () => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 50, 50);
    ctx.drawImage(img, 0, 0, 50, 50);
    const data = ctx.getImageData(0, 0, 50, 50).data;

    // 浅色模式的色斑本身就要更透：白遮罩盖深色斑等于去饱和，会洗成惨白
    const alphas = isLightTheme()
      ? [0.72, 0.68, 0.6, 0.56]
      : [0.9, 0.85, 0.72, 0.66];
    extractPalette(data, 4).forEach((c, i) => {
      root.style.setProperty(`--c${i + 1}`, `rgba(${c.r}, ${c.g}, ${c.b}, ${alphas[i]})`);
    });

    ctx.clearRect(0, 0, 50, 50);
    img.onload = null;
    img.src = '';
  };
}

// 进度可视化：已播放段是频谱条，其余是一条暗线，交界处是播放头。
// --progress-ratio 同时给小窗模式下那条细线用。
export function updateProgressStyle(value) {
  const pct = Number.isFinite(value) ? value : 0;
  document.documentElement.style.setProperty('--progress-ratio', `${pct}%`);
  const bars = document.getElementById('vizBars');
  const head = document.getElementById('vizHead');
  if (bars) bars.style.width = `${pct}%`;
  if (head) head.style.left = `${pct}%`;
}

// 环境光跟随鼠标缓动
export function initMouseFollow() {
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

    const lightField = document.querySelector('.light-field');
    if (lightField) {
      // 走 translate 属性而不是 transform：transform 已被 ambientDrift 动画占用，
      // 内联 transform 会被动画覆盖（动画在层叠里优先级高于内联），写了等于没写。
      const offsetX = (state.mouseX - 50) * 0.68;
      const offsetY = (state.mouseY - 50) * 0.68;
      lightField.style.setProperty('--mx', `${offsetX.toFixed(1)}px`);
      lightField.style.setProperty('--my', `${offsetY.toFixed(1)}px`);
    }

    if (state.isAnimating) requestAnimationFrame(animateMouseFollow);
  }
}
