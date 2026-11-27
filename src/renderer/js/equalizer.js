// 均衡器：复用 audio-graph.js 提供的共享 Web Audio 链路（10 段 Biquad + 自动前级 Gain），
// 与实时频谱共用同一个 AudioContext / MediaElementSource，避免二次接管 <audio> 抛错。

import { t } from '../../shared/i18n.js';
import {
  EQ_BANDS,
  EQ_GAIN_LIMIT,
  EQ_GAIN_STEP,
  EQ_PRESETS,
  FLAT_GAINS,
  computePreampDb,
  matchPresetId,
  normalizeEq,
} from '../../shared/equalizer.js';
import {
  eqEnableSwitch,
  eqPresetsEl,
  eqFadersEl,
  eqStatusEl,
  eqPreampEl,
  eqResetBtn,
  eqCurveSvg,
  eqStageSvg,
  eqStageNodes,
  eqStagePreset,
  eqStagePreamp,
} from './dom.js';
import { state } from './state.js';
import { showSyncToast } from './helpers.js';
import { ensureAudioGraph, applyEqualizerToGraph, resumeAudioGraph } from './audio-graph.js';

let eqWarnedFailure = false; // 建图失败只提示一次，避免反复弹 toast
let eqUiBuilt = false;

let faderInputs = [];
let faderValues = [];

function ensureEqUiBuilt() {
  if (eqUiBuilt) return;
  eqUiBuilt = true;
  buildFaders();
}

function ensureGraphForEq() {
  const g = ensureAudioGraph();
  if (!g && !eqWarnedFailure) {
    eqWarnedFailure = true;
    showSyncToast(t('settings.eqUnavailable'));
  }
  return Boolean(g);
}

// 每次改动都写主进程。写的是 electron-store 的 JSON，和小节里的歌词样式滑块同款。
function commit() {
  window.dreamApi.setEqualizer(state.equalizer).catch(() => {});
  if (state.equalizer.enabled) ensureGraphForEq();
  applyEqualizerToGraph(state.equalizer);
  syncEqUi();
}

function setEnabled(enabled) {
  state.equalizer.enabled = enabled;
  commit();
}

function setGain(index, value) {
  state.equalizer.gains[index] = value;
  // 一动手就是明确想听效果：自动开启。否则拖了半天没反应，看起来像坏了。
  state.equalizer.enabled = true;
  commit();
}

function applyPreset(id) {
  const preset = EQ_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  state.equalizer.gains = [...preset.gains];
  state.equalizer.enabled = true;
  commit();
}

function resetEq() {
  state.equalizer.gains = [...FLAT_GAINS];
  commit();
}

// +12 / +2.5 / 0 / −1.5：正数带符号，整数不带 .0，减号用 U+2212（和刻度、音量显示的排版一致）
function formatDb(value) {
  const num = Number(value) || 0;
  if (num === 0) return '0';
  const abs = Math.abs(num);
  const str = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  return num > 0 ? `+${str}` : `−${str}`;
}

function buildFaders() {
  eqFadersEl.innerHTML = '';
  faderInputs = [];
  faderValues = [];

  EQ_BANDS.forEach((freq, i) => {
    const col = document.createElement('div');
    col.className = 'eq-col';

    const value = document.createElement('span');
    value.className = 'eq-col-val';
    col.appendChild(value);

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'eq-fader';
    input.min = String(-EQ_GAIN_LIMIT);
    input.max = String(EQ_GAIN_LIMIT);
    input.step = String(EQ_GAIN_STEP);
    input.value = '0';
    input.dataset.index = String(i);
    const label = freq >= 1000 ? `${freq / 1000} kHz` : `${freq} Hz`;
    input.title = label;
    input.setAttribute('aria-label', label);
    col.appendChild(input);

    const tick = document.createElement('span');
    tick.className = 'eq-col-freq';
    tick.textContent = freq >= 1000 ? `${freq / 1000}k` : String(freq);
    col.appendChild(tick);

    eqFadersEl.appendChild(col);
    faderInputs.push(input);
    faderValues.push(value);
  });
}

// 预设胶囊的文案来自 i18n，切换语言后要重建
export function renderEqPresets() {
  ensureEqUiBuilt();
  eqPresetsEl.innerHTML = '';
  for (const preset of EQ_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'eq-preset';
    btn.dataset.preset = preset.id;
    btn.textContent = t(`eq.preset.${preset.id}`);
    btn.addEventListener('click', () => applyPreset(preset.id));
    eqPresetsEl.appendChild(btn);
  }
}

// 绘制平滑三次贝塞尔频响曲线：10 段横坐标落在 10 等分网格中心 ((i + 0.5) / 10)，与推子/频率刻字对齐。
function buildCurvePaths(gains, width, height, padY) {
  const usableH = height - padY * 2;
  const pts = gains.map((g, i) => ({
    x: ((i + 0.5) / gains.length) * width,
    y: padY + ((EQ_GAIN_LIMIT - g) / (2 * EQ_GAIN_LIMIT)) * usableH,
  }));
  let body = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const cx = ((p0.x + p1.x) / 2).toFixed(1);
    body += ` C ${cx} ${p0.y.toFixed(1)}, ${cx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  const d = `M 0 ${pts[0].y.toFixed(1)} L ${body.slice(2)} L ${width} ${pts[pts.length - 1].y.toFixed(1)}`;
  const area = `${d} L ${width} ${height} L 0 ${height} Z`;
  return { d, area, pts };
}

function syncEqCurves(gains, enabled, presetLabel, preampText) {
  if (eqCurveSvg) {
    const { d, area } = buildCurvePaths(gains, 600, 132, 5);
    const areaPath = eqCurveSvg.querySelector('.eq-curve-area');
    const strokePath = eqCurveSvg.querySelector('.eq-curve-stroke');
    if (areaPath) areaPath.setAttribute('d', area);
    if (strokePath) strokePath.setAttribute('d', d);
    eqCurveSvg.closest('.eq-bank')?.classList.toggle('bypassed', !enabled);
  }

  if (eqStageSvg) {
    const { d, area, pts } = buildCurvePaths(gains, 600, 160, 20);
    const areaPath = eqStageSvg.querySelector('.eq-stage-area');
    const strokePath = eqStageSvg.querySelector('.eq-stage-stroke');
    if (areaPath) areaPath.setAttribute('d', area);
    if (strokePath) strokePath.setAttribute('d', d);
    if (eqStageNodes) {
      eqStageNodes.innerHTML = '';
      for (const pt of pts) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', pt.x.toFixed(1));
        dot.setAttribute('cy', pt.y.toFixed(1));
        dot.setAttribute('r', '4');
        eqStageNodes.appendChild(dot);
      }
    }
    eqStageSvg.closest('.stage-eq-card')?.classList.toggle('bypassed', !enabled);
  }

  if (eqStagePreset) eqStagePreset.textContent = presetLabel;
  if (eqStagePreamp) eqStagePreamp.textContent = preampText;
}

export function syncEqUi() {
  ensureEqUiBuilt();
  const { enabled, gains } = state.equalizer;
  const currentId = matchPresetId(gains);

  eqEnableSwitch.classList.toggle('active', enabled);
  eqEnableSwitch.setAttribute('aria-checked', String(enabled));

  eqPresetsEl.querySelectorAll('.eq-preset').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === currentId);
  });

  faderInputs.forEach((input, i) => {
    const gain = gains[i];
    input.value = String(gain);
    // 填充从 0dB 线画到滑块：提升向上填、衰减向下填，0 时两停点重合、宽度为零
    const pos = ((EQ_GAIN_LIMIT - gain) / (2 * EQ_GAIN_LIMIT)) * 100;
    input.style.setProperty('--eq-a', `${Math.min(pos, 50)}%`);
    input.style.setProperty('--eq-b', `${Math.max(pos, 50)}%`);
    faderValues[i].textContent = formatDb(gain);
  });

  const name =
    currentId === 'flat'
      ? t('settings.eqFlat')
      : currentId === 'custom'
        ? t('settings.eqCustom')
        : t(`eq.preset.${currentId}`);
  const statusText = t('settings.eqCurrent', { name });
  eqStatusEl.textContent = statusText;

  // 前级读数按**实际生效**的曲线算：关闭时推的是平直，读数就该是 0dB，
  // 否则会写着「自动前级 −6dB」却什么都没发生
  const preamp = computePreampDb(enabled ? gains : FLAT_GAINS);
  const preampShort = t('settings.eqPreamp', { v: formatDb(preamp) });
  eqPreampEl.textContent = `${preampShort} · ${t('settings.eqPreampHint')}`;

  syncEqCurves(gains, enabled, statusText, preampShort);
}

export function initEqualizer(rawEq) {
  state.equalizer = normalizeEq(rawEq);
  // 设置页关闭时推子/预设胶囊/SVG 曲线不可见，延后到首次打开设置页（renderEqPresets / syncEqUi）时构建。
  // 启动时均衡器就是开着的：趁还没开始播放先把图建好，避免播放中途接管输出链路产生爆音。
  if (state.equalizer.enabled) {
    ensureGraphForEq();
    applyEqualizerToGraph(state.equalizer);
  }
}

export function bindEqEvents() {
  eqEnableSwitch.addEventListener('click', () => setEnabled(!state.equalizer.enabled));
  eqResetBtn.addEventListener('click', resetEq);

  // 推子是动态生成的，事件委托到容器上；双击任意频段推子快速归零
  eqFadersEl.addEventListener('input', (e) => {
    const input = e.target;
    if (!input.classList || !input.classList.contains('eq-fader')) return;
    setGain(Number(input.dataset.index), Number(input.value));
  });
  eqFadersEl.addEventListener('dblclick', (e) => {
    const input = e.target;
    if (!input.classList || !input.classList.contains('eq-fader')) return;
    setGain(Number(input.dataset.index), 0);
  });

  // 播放时兜底唤醒共享 AudioContext（audio-graph 内也已监听，这里保留兼容）
  resumeAudioGraph();
}
