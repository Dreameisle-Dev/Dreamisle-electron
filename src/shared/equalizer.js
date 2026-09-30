// 均衡器的纯逻辑：频段表、预设曲线、存储数据校验、自动前级。
// 不碰 DOM、不碰 Web Audio —— 音频图在 renderer/js/equalizer.js。

// ISO 标准十段，1 倍频程间隔
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_GAIN_LIMIT = 12; // dB
export const EQ_BAND_Q = 1.4; // ≈1 倍频程带宽，与 1-octave 频段间隔对齐

export const FLAT_GAINS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// 增益值顺序对应 EQ_BANDS（31Hz → 16kHz）
export const EQ_PRESETS = [
  { id: 'acoustic', gains: [-2, -1, 0, 1, 2, 2, 2, 1, 0, -1] },
  { id: 'pop', gains: [-1, 0, 1, 3, 3, 1, 0, 1, 2, 2] },
  { id: 'rock', gains: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4] },
  { id: 'jazz', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { id: 'classical', gains: [3, 2, 0, 0, -1, -1, 0, 2, 3, 4] },
  { id: 'electronic', gains: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5] },
  { id: 'bass', gains: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0] },
  { id: 'vocal', gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { id: 'night', gains: [-3, -2, 0, 1, 2, 2, 1, 0, -1, -3] },
];

export const DEFAULT_EQ = { enabled: false, gains: [...FLAT_GAINS] };

// 单段增益：非有限数按 0（损坏项归零，不牵连其余段），并夹到 ±12 后取整
function sanitizeGain(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const clamped = Math.min(EQ_GAIN_LIMIT, Math.max(-EQ_GAIN_LIMIT, Math.round(value)));
  return clamped === 0 ? 0 : clamped; // 顺手消掉 -0
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

// 自动前级：抵消最大提升量。提升 +6dB 时整条链先衰减 6dB，
// 峰不会被推到 1.0 以上（Web Audio 输出端是硬削顶，没有限制器兜底）。
// 只做衰减时返回 0，不做无谓的增益补偿。
export function computePreampDb(gains) {
  let max = 0;
  for (const gain of gains) {
    if (gain > max) max = gain;
  }
  return max > 0 ? -max : 0;
}

// 曲线 → 预设 id。全平直返回 'flat'（它不是预设按钮，是「没调过」的状态），
// 都对不上就是用户手拖出来的 'custom'。
export function matchPresetId(gains) {
  if (gains.every((g) => g === 0)) return 'flat';
  const match = EQ_PRESETS.find((preset) => preset.gains.every((g, i) => g === gains[i]));
  return match ? match.id : 'custom';
}
