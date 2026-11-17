// 任务栏歌词外观：字体、粗细、颜色。纯函数，主进程和设置页共用。
// textColor 为 'auto' 时跟随任务栏明暗；否则是 #rrggbb。
export const DEFAULT_TASKBAR_LYRICS_STYLE = {
  fontFamily: '',
  fontWeight: 600,
  textColor: 'auto',
};

const ALLOWED_WEIGHTS = new Set([400, 500, 600, 700]);
const MAX_FONT_FAMILY_LEN = 128;

// 过滤可能跳出 CSS font-family 引号或注入声明的字符，保留真实系统字体名
export function sanitizeFontFamily(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f"'\\;{}<>]/g, '')
    .trim()
    .slice(0, MAX_FONT_FAMILY_LEN);
}

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
    fontFamily: sanitizeFontFamily(source.fontFamily),
    fontWeight: normalizeWeight(source.fontWeight),
    textColor: normalizeColor(source.textColor),
  };
}
