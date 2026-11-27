// 均衡器的纯逻辑：频段拓扑、现代通透预设曲线、存储校验与基于真实级联频响的自动前级。
// 不碰 DOM、不碰 Web Audio —— 音频图在 renderer/js/audio-graph.js。

// ISO 标准十段（1 倍频程显示刻度）
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_GAIN_LIMIT = 12; // dB
export const EQ_GAIN_STEP = 0.5; // dB
export const EQ_BAND_Q = 1.8; // 更干净的频段分离度，减少 125–500 Hz 浑浊区串扰

// 每段滤波器声学拓扑：
// - 31 Hz 采用 lowshelf (45 Hz, Butterworth Q=0.707)：极低频延伸顺滑不轰头；
// - 62 Hz – 8 kHz 采用 peaking (Q=1.8)：收紧低中频边界，消除相邻频段叠加发闷；
// - 16 kHz 采用 highshelf (11 kHz, Q=0.707)：避开 44.1/48 kHz 下 16k peaking 的双线性压缩，
//   给出自然通透、不刺齿音的高频空气感。
export const EQ_BAND_SPECS = [
  { freq: 31, type: 'lowshelf', filterFreq: 45, Q: 0.707 },
  { freq: 62, type: 'peaking', filterFreq: 62, Q: EQ_BAND_Q },
  { freq: 125, type: 'peaking', filterFreq: 125, Q: EQ_BAND_Q },
  { freq: 250, type: 'peaking', filterFreq: 250, Q: EQ_BAND_Q },
  { freq: 500, type: 'peaking', filterFreq: 500, Q: EQ_BAND_Q },
  { freq: 1000, type: 'peaking', filterFreq: 1000, Q: EQ_BAND_Q },
  { freq: 2000, type: 'peaking', filterFreq: 2000, Q: EQ_BAND_Q },
  { freq: 4000, type: 'peaking', filterFreq: 4000, Q: EQ_BAND_Q },
  { freq: 8000, type: 'peaking', filterFreq: 8000, Q: EQ_BAND_Q },
  { freq: 16000, type: 'highshelf', filterFreq: 11000, Q: 0.707 },
];

export const FLAT_GAINS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// 全新通透向调音预设（增益顺序对应 31Hz → 16kHz，单位 dB）：
// 统一采用「减法清理 250–500 Hz 浑浊箱声 + 节制 6–8 kHz 防齿音 + 柔顺 11k+ 空气感搁架」思路，
// 避免盲目堆叠增益导致响度塌陷与听感发闷。
export const EQ_PRESETS = [
  { id: 'clear', gains: [0.5, 0.5, -0.5, -2, -1.5, 0, 1.5, 2.5, 2, 3.5] },
  { id: 'hifi', gains: [2.5, 1.5, 0, -1.5, -0.5, 0, 1, 2, 1.5, 2.5] },
  { id: 'vocal', gains: [-1.5, -1, -1.5, -2, 0, 1.5, 3, 2.5, 1, 2.5] },
  { id: 'pop', gains: [2, 2.5, 0.5, -1.5, -1, 0.5, 1.5, 2.5, 2, 3] },
  { id: 'acg', gains: [1.5, 1, -0.5, -2, -1, 0.5, 2, 2.5, 2, 4] },
  { id: 'rock', gains: [2.5, 3, 1, -1.5, -1.5, 0, 2, 3, 2, 2.5] },
  { id: 'acoustic', gains: [-0.5, 0.5, 0, -1.5, -0.5, 0.5, 1.5, 2.5, 2, 3] },
  { id: 'classical', gains: [2, 1.5, 0, -1, -0.5, 0, 1, 2, 2, 4] },
  { id: 'electronic', gains: [3.5, 3, 0, -2, -2, 0, 1.5, 2.5, 2.5, 3.5] },
  { id: 'bass', gains: [3.5, 3, 1, -2, -1, 0, 0.5, 1.5, 1.5, 2] },
  { id: 'jazz', gains: [1.5, 2, 0.5, -0.5, -1, 0, 1, 1.5, 1.5, 3] },
  { id: 'night', gains: [2, 1.5, 0, -1.5, -1, 0, 0, 0.5, 1, 2] },
];

export const DEFAULT_EQ = { enabled: false, gains: [...FLAT_GAINS] };

// 单段增益：非有限数按 0（损坏项归零，不牵连其余段），夹到 ±12 并按 0.5 dB 步进规整
function sanitizeGain(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const clamped = Math.min(EQ_GAIN_LIMIT, Math.max(-EQ_GAIN_LIMIT, value));
  const stepped = Math.round(clamped / EQ_GAIN_STEP) * EQ_GAIN_STEP;
  return stepped === 0 ? 0 : stepped; // 顺手消掉 -0
}

// 存储里的数据可能被手改坏：整条形状不对就回落平直，单段坏只坏那一段
export function normalizeEq(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: false, gains: [...FLAT_GAINS] };
  }
  const gains =
    Array.isArray(raw.gains) && raw.gains.length === EQ_BANDS.length
      ? raw.gains.map(sanitizeGain)
      : [...FLAT_GAINS];
  return { enabled: raw.enabled === true, gains };
}

// 按 Web Audio API (Audio EQ Cookbook) 双二阶传递函数计算单段在频率 f 的幅频响应（dB）
function singleBiquadMagDb(spec, gainDb, f, sampleRate = 48000) {
  if (!gainDb) return 0;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * spec.filterFreq) / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;

  if (spec.type === 'peaking') {
    const alpha = sinw0 / (2 * spec.Q);
    b0 = 1 + alpha * A;
    b1 = -2 * cosw0;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cosw0;
    a2 = 1 - alpha / A;
  } else if (spec.type === 'lowshelf') {
    const alpha = (sinw0 / 2) * Math.SQRT2;
    const sq = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 - (A - 1) * cosw0 + sq);
    b1 = 2 * A * (A - 1 - (A + 1) * cosw0);
    b2 = A * (A + 1 - (A - 1) * cosw0 - sq);
    a0 = A + 1 + (A - 1) * cosw0 + sq;
    a1 = -2 * (A - 1 + (A + 1) * cosw0);
    a2 = A + 1 + (A - 1) * cosw0 - sq;
  } else {
    const alpha = (sinw0 / 2) * Math.SQRT2;
    const sq = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 + (A - 1) * cosw0 + sq);
    b1 = -2 * A * (A - 1 + (A + 1) * cosw0);
    b2 = A * (A + 1 + (A - 1) * cosw0 - sq);
    a0 = A + 1 - (A - 1) * cosw0 + sq;
    a1 = 2 * (A - 1 - (A + 1) * cosw0);
    a2 = A + 1 - (A - 1) * cosw0 - sq;
  }

  const w = (2 * Math.PI * f) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const nr = b0 + b1 * cos1 + b2 * cos2;
  const ni = -(b1 * sin1 + b2 * sin2);
  const dr = a0 + a1 * cos1 + a2 * cos2;
  const di = -(a1 * sin1 + a2 * sin2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

export function evaluateEqResponseDb(gains, f, sampleRate = 48000) {
  let total = 0;
  for (let i = 0; i < EQ_BAND_SPECS.length; i++) {
    total += singleBiquadMagDb(EQ_BAND_SPECS[i], gains[i] || 0, f, sampleRate);
  }
  return total;
}

const PREAMP_PROBE_FREQS = [
  28, 42, 62, 90, 125, 180, 250, 360, 500, 720, 1000, 1450, 2000, 2900, 4000, 5800, 8000, 11500,
  16000,
];

// 自动前级：按真实级联幅频响应的峰值防削顶（兼顾相邻频段叠加安全与高频空气感响度保留）。
// 真实音乐能量随频率自然滚降，10 kHz 以上极高频能量远低于满幅，给予 1 dB 极高频余量，
// 避免轻微提亮空气感就把整首歌响度压暗；中低频重叠提升仍按真实叠加峰值全额防削顶。
export function computePreampDb(gains) {
  if (!Array.isArray(gains) || gains.every((g) => !g || g <= 0)) return 0;

  let effectivePeak = 0;
  for (const f of PREAMP_PROBE_FREQS) {
    let mag = evaluateEqResponseDb(gains, f);
    if (f >= 10000) mag -= 1;
    if (mag > effectivePeak) effectivePeak = mag;
  }

  if (effectivePeak <= 0.1) return 0;
  const rounded = Math.ceil(effectivePeak / EQ_GAIN_STEP) * EQ_GAIN_STEP;
  return -Math.min(EQ_GAIN_LIMIT + 6, rounded);
}

// 曲线 → 预设 id。全平直返回 'flat'（它不是预设按钮，是「没调过」的状态），
// 都对不上就是用户手拖出来的 'custom'。
export function matchPresetId(gains) {
  if (gains.every((g) => g === 0)) return 'flat';
  const match = EQ_PRESETS.find((preset) => preset.gains.every((g, i) => g === gains[i]));
  return match ? match.id : 'custom';
}
