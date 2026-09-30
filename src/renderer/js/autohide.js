import { state } from './state.js';

// 传输栏自动隐藏。触发区高度必须**大于等于条高**（130）：取小值会把条从光标底下
// 抽走（鼠标停在条的上半部分时会判定为「不在底部」）。150 = 条高 130 + 20px 提前量。
const TRIGGER = 150;
const DELAY = 1200;

let hideTimer = null;
let isHidden = false;
// 最后一次 mousemove 时"光标是否压在条上"。点按钮时光标常常是不动的，
// 单靠 mousemove 判断会在点完之后把条从光标底下收走，所以缓存下来给别处用。
let lastEngaged = true;

// 浮层打开时不能收：设置/统计盖住整屏，条在下面收不收看不见，
// 但关掉浮层那一刻会露出一个空底，很突兀。
function overlayOpen() {
  return !!document.querySelector('.help-overlay.open, .stats-overlay.open');
}

export function showBar() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!isHidden) return;
  isHidden = false;
  document.body.classList.remove('bar-hidden');
}

function scheduleHide() {
  if (hideTimer || isHidden) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    isHidden = true;
    document.body.classList.add('bar-hidden');
  }, DELAY);
}

// 光标是否在「该露出来」的位置：底部触发区，或者压在条 / 翻译按钮上
function isEngaged(e) {
  if (e.clientY >= window.innerHeight - TRIGGER) return true;
  const t = e.target;
  return !!(t && t.closest && t.closest('.player-bar, .lyric-translation-toggle'));
}

function reevaluate() {
  if (overlayOpen() || lastEngaged) showBar();
  else scheduleHide();
}

// 小窗模式下强制显示（进小窗那一刻条可能正收着）
export function setAutoHideEnabled(enabled) {
  if (!enabled) showBar();
}

export function initAutoHide() {
  window.addEventListener('mousemove', (e) => {
    // 小窗模式不启用：那里面条就是全部内容，收起来等于没界面
    if (state.isMiniMode) return;
    lastEngaged = isEngaged(e);
    reevaluate();
  });

  // 光标移出窗口后 mousemove 不再触发，得单独排一次收回，
  // 否则从底部以外的地方离开窗口，条会一直挂着。
  document.addEventListener('mouseleave', () => {
    if (state.isMiniMode || overlayOpen()) return;
    scheduleHide();
  });

  // 浮层关闭 / 点了别处之后，按最后已知的光标位置重判一次，
  // 不然会停在「浮层期间强制显示」的状态不动。
  document.addEventListener('click', () => {
    if (overlayOpen()) return;
    reevaluate();
  });
}
