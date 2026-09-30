// 均衡器：<audio> → MediaElementSource → Biquad ×10 → 前级 Gain → destination。
// 图是惰性建的 —— createMediaElementSource 每个元素只能调一次且拆不掉，所以关着时索性不建，
// 用户真启用才接管音频链路。AudioContext 停在 suspended 会整体静音，建图后与每次 play 都要 resume。

import { t } from '../../shared/i18n.js';
import {
  EQ_BANDS,
  EQ_BAND_Q,
  EQ_GAIN_LIMIT,
  EQ_PRESETS,
  FLAT_GAINS,
  computePreampDb,
  matchPresetId,
  normalizeEq,
} from '../../shared/equalizer.js';
import {
  audio,
  eqEnableSwitch,
  eqPresetsEl,
  eqFadersEl,
  eqStatusEl,
  eqPreampEl,
  eqResetBtn,
} from './dom.js';
import { state } from './state.js';
import { showSyncToast } from './helpers.js';

let ctx = null; // AudioContext，未启用时为 null（= 没碰过音频链路）
let filters = []; // 10 个 BiquadFilterNode
let preampNode = null; // 自动前级
let graphFailed = false; // 建图失败过就永不再试，避免反复弹提示

let faderInputs = [];
let faderValues = [];


function resumeGraph() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}

// 建图。返回是否可用；失败时音频保持元素直出，功能降级但不影响播放。
function ensureGraph() {
  if (ctx) return true;
  if (graphFailed) return false;

  let built = null;
  try {
    built = new AudioContext();

    const chain = EQ_BANDS.map((freq) => {
      const node = built.createBiquadFilter();
      node.type = 'peaking';
      node.frequency.value = freq;
      node.Q.value = EQ_BAND_Q;
      node.gain.value = 0;
      return node;
    });
    const preamp = built.createGain();
    let tail = chain[0];
    for (let i = 1; i < chain.length; i++) {
      tail.connect(chain[i]);
      tail = chain[i];
    }
    tail.connect(preamp);
    preamp.connect(built.destination);

    // 最后一步才接管 <audio>
    built.createMediaElementSource(audio).connect(chain[0]);

    ctx = built;
    filters = chain;
    preampNode = preamp;
    resumeGraph();
    return true;
  } catch (e) {
    // 走到这里说明接管失败。若停在 source 之前，音频链路是干净的；
    // 若 source 已建而后续抛了（实际不可能），声音会静掉 —— 那种情况下
    // 关掉 AudioContext 与留着都是静音，索性关掉省资源。
    graphFailed = true;
    ctx = null;
    filters = [];
    preampNode = null;
    try {
      if (built) built.close();
    } catch (e2) {}
    showSyncToast(t('settings.eqUnavailable'));
    return false;
  }
}

// 把当前曲线推给滤波器。关闭时推平直（= 旁通），而不是保留曲线不动。
function applyToGraph() {
  if (!ctx) return;
  const effective = state.equalizer.enabled ? state.equalizer.gains : FLAT_GAINS;
  filters.forEach((node, i) => {
    node.gain.value = effective[i];
  });
  preampNode.gain.value = Math.pow(10, computePreampDb(effective) / 20); // dB → 线性
  resumeGraph();
}


// 每次改动都写主进程。写的是 electron-store 的 JSON，和小节里的歌词样式滑块同款。
function commit() {
  window.dreamApi.setEqualizer(state.equalizer).catch(() => {});
  if (state.equalizer.enabled) ensureGraph();
  applyToGraph();
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


// +12 / 0 / −6：正数带符号，减号用 U+2212（和刻度、音量显示的排版一致）
function formatDb(value) {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return '0';
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
    input.step = '1';
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

export function syncEqUi() {
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
  eqStatusEl.textContent = t('settings.eqCurrent', { name });

  // 前级读数按**实际生效**的曲线算：关闭时推的是平直，读数就该是 0dB，
  // 否则会写着「自动前级 −6dB」却什么都没发生
  const preamp = computePreampDb(enabled ? gains : FLAT_GAINS);
  eqPreampEl.textContent = `${t('settings.eqPreamp', {
    v: formatDb(preamp),
  })} · ${t('settings.eqPreampHint')}`;
}


export function initEqualizer(rawEq) {
  state.equalizer = normalizeEq(rawEq);
  buildFaders();
  renderEqPresets();
  syncEqUi();
  // 启动时均衡器就是开着的：趁还没开始播放先把图建好，
  // 避免播放中途接管输出链路产生爆音
  if (state.equalizer.enabled) {
    ensureGraph();
    applyToGraph();
  }
}

export function bindEqEvents() {
  eqEnableSwitch.addEventListener('click', () => setEnabled(!state.equalizer.enabled));
  eqResetBtn.addEventListener('click', resetEq);

  // 推子是动态生成的，事件委托到容器上
  eqFadersEl.addEventListener('input', (e) => {
    const input = e.target;
    if (!input.classList || !input.classList.contains('eq-fader')) return;
    setGain(Number(input.dataset.index), Number(input.value));
  });

  // AudioContext 被系统挂起后再播放会整体静音，每次播放都兜一次
  audio.addEventListener('play', resumeGraph);
}
