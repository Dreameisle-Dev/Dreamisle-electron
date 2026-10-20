// 任务栏歌词外观：字体、粗细、颜色。纯函数，主进程和设置页共用。
// textColor 为 'auto' 时跟随任务栏明暗；否则是 #rrggbb。
export const DEFAULT_TASKBAR_LYRICS_STYLE = {
  fontFamily: '',
  fontWeight: 600,
  textColor: 'auto',
};

const ALLOWED_WEIGHTS = new Set([400, 500, 600, 700]);

function normalizeWeight(value) {
  const weight = Number(value);
  return ALLOWED_WEIGHTS.has(weight) ? weight : DEFAULT_TASKBAR_LYRICS_STYLE.fontWeight;
}

function normalizeColor(value) {
  if (typeof value !== 'string') return DEFAULT_TASKBAR_LYRICS_STYLE.textColor;
  const color = value.trim().toLowerCase();
  if (color === 'auto') return 'auto';
  return /^#[0-9a-f]{6}$/.test(color) ? color : DEFAULT_TASKBAR_LYRICS_STYLE.textColor;
}

export function normalizeTaskbarLyricsStyle(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    fontFamily: typeof source.fontFamily === 'string' ? source.fontFamily.trim() : '',
    fontWeight: normalizeWeight(source.fontWeight),
    textColor: normalizeColor(source.textColor),
  };
}
