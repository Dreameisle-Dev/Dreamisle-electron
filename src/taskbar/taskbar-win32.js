import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_SYSMENU = 0x00080000;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_APPWINDOW = 0x40000;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOZORDER = 0x4;
const SWP_NOACTIVATE = 0x10;
const GW_OWNER = 4;
const GA_PARENT = 1;
const GWLP_HWNDPARENT = -8;
const MONITOR_DEFAULTTONEAREST = 2;
// MONITORINFO: DWORD cbSize + RECT rcMonitor + RECT rcWork + DWORD dwFlags
const MONITORINFO_SIZE = 40;
const RRF_RT_REG_DWORD = 0x10;
const HKEY_CURRENT_USER = 0x80000001n;
const FINGERPRINT_MULTIPLIER = 0x9e3779b97f4a7c15n;
const MASK_64 = 0xffffffffffffffffn;
const IGNORED_FOREGROUND_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
]);

let initialized = false;
let available = false;
let koffi = null;
let user32 = null;
let advapi32 = null;
let initError = null;

// 可选函数绑定失败时不要拖垮整个功能：任务栏嵌入只强依赖窗口/坐标相关 API，
// 主题读取、DPI 查询、快捷键守卫各有降级路径。
function bindOptional(lib, prototype) {
  try {
    return lib.func(prototype);
  } catch {
    return null;
  }
}

function ensureNative() {
  if (initialized) return available;
  initialized = true;
  if (process.platform !== 'win32') return false;

  try {
    koffi = require('koffi');
    const user32Lib = koffi.load('user32.dll');

    koffi.struct('RECT', {
      left: 'long',
      top: 'long',
      right: 'long',
      bottom: 'long',
    });
    koffi.struct('POINT', {
      x: 'long',
      y: 'long',
    });

    koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)');

    user32 = {
      FindWindowW: user32Lib.func(
        'void * __stdcall FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)'
      ),
      FindWindowExW: user32Lib.func(
        'void * __stdcall FindWindowExW(void *hWndParent, void *hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)'
      ),
      GetWindowRect: user32Lib.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)'),
      GetClientRect: user32Lib.func('bool __stdcall GetClientRect(void *hWnd, _Out_ RECT *lpRect)'),
      ClientToScreen: user32Lib.func(
        'bool __stdcall ClientToScreen(void *hWnd, _Inout_ POINT *lpPoint)'
      ),
      GetDpiForWindow: bindOptional(user32Lib, 'uint __stdcall GetDpiForWindow(void *hWnd)'),
      SetParent: user32Lib.func('void * __stdcall SetParent(void *hWndChild, void *hWndNewParent)'),
      GetParent: user32Lib.func('void * __stdcall GetParent(void *hWnd)'),
      GetAncestor: user32Lib.func('void * __stdcall GetAncestor(void *hwnd, uint gaFlags)'),
      GetWindowLongW: user32Lib.func('long __stdcall GetWindowLongW(void *hWnd, int nIndex)'),
      SetWindowLongW: user32Lib.func(
        'long __stdcall SetWindowLongW(void *hWnd, int nIndex, long dwNewLong)'
      ),
      // 64 位上 GWLP_HWNDPARENT 是指针宽度；SetWindowLongW 不能可靠设置 owner。
      SetWindowLongPtrW: bindOptional(
        user32Lib,
        'intptr_t __stdcall SetWindowLongPtrW(void *hWnd, int nIndex, intptr_t dwNewLong)'
      ),
      SetWindowPos: user32Lib.func(
        'bool __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'
      ),
      ShowWindow: user32Lib.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)'),
      IsWindow: user32Lib.func('bool __stdcall IsWindow(void *hWnd)'),
      IsWindowVisible: user32Lib.func('bool __stdcall IsWindowVisible(void *hWnd)'),
      GetForegroundWindow: user32Lib.func('void * __stdcall GetForegroundWindow()'),
      MonitorFromWindow: bindOptional(
        user32Lib,
        'void * __stdcall MonitorFromWindow(void *hWnd, uint dwFlags)'
      ),
      GetMonitorInfoW: bindOptional(
        user32Lib,
        'bool __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ uint8_t *lpmi)'
      ),
      GetAsyncKeyState: bindOptional(user32Lib, 'short __stdcall GetAsyncKeyState(int vKey)'),
      GetWindow: user32Lib.func('void * __stdcall GetWindow(void *hWnd, uint uCmd)'),
      EnumWindows: bindOptional(
        user32Lib,
        'bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)'
      ),
      MoveWindow: bindOptional(
        user32Lib,
        'bool __stdcall MoveWindow(void *hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint)'
      ),
      GetClassNameW: user32Lib.func(
        'int __stdcall GetClassNameW(void *hWnd, _Out_ uint8_t *lpClassName, int nMaxCount)'
      ),
    };

    // advapi32 只用于读主题/对齐两个可选值。加载失败时保持 user32 可用，
    // 让任务栏歌词照常工作，只是颜色回退为浅色。
    try {
      const advapi32Lib = koffi.load('advapi32.dll');
      advapi32 = {
        RegGetValueW: bindOptional(
          advapi32Lib,
          'int __stdcall RegGetValueW(intptr_t hkey, const char16_t *lpSubKey, const char16_t *lpValue, uint dwFlags, uint *pdwType, _Out_ uint *pvData, uint *pcbData)'
        ),
      };
    } catch {
      advapi32 = null;
    }

    available = true;
  } catch (error) {
    initError = error instanceof Error ? error.message : String(error);
    available = false;
  }

  return available;
}

function asHwnd(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value === 0n ? null : value;
  if (typeof value === 'number') return value === 0 ? null : BigInt(value);
  try {
    const hwnd = BigInt(value);
    return hwnd === 0n ? null : hwnd;
  } catch {
    return null;
  }
}

function readRegDword(subKey, valueName) {
  if (!ensureNative() || !advapi32?.RegGetValueW) return null;
  try {
    const data = koffi.alloc('uint', 1);
    const size = koffi.alloc('uint', 1);
    koffi.encode(size, 'uint', 4);
    const status = advapi32.RegGetValueW(
      HKEY_CURRENT_USER,
      subKey,
      valueName,
      RRF_RT_REG_DWORD,
      null,
      data,
      size
    );
    if (status !== 0) return null;
    return koffi.decode(data, 'uint');
  } catch {
    return null;
  }
}

export function getNativeHwnd(win) {
  if (process.platform !== 'win32') return null;
  try {
    const buf = win.getNativeWindowHandle();
    return buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  } catch {
    return null;
  }
}

export function findTaskbar() {
  if (!ensureNative()) return null;
  try {
    return asHwnd(user32.FindWindowW('Shell_TrayWnd', null));
  } catch {
    return null;
  }
}

export function findTrayNotify(trayHwnd) {
  if (!ensureNative()) return null;
  const tray = asHwnd(trayHwnd);
  if (!tray) return null;
  try {
    return asHwnd(user32.FindWindowExW(tray, null, 'TrayNotifyWnd', null));
  } catch {
    return null;
  }
}

// Win10 的任务栏内容挂在 ReBarWindow32 下（极少数情况下是 WorkerW）；
// Win11 没有这些经典子窗口，调用方只在 Win10 分支里使用。
export function findTaskbarContainer(trayHwnd) {
  if (!ensureNative()) return null;
  const tray = asHwnd(trayHwnd);
  if (!tray) return null;
  try {
    return (
      asHwnd(user32.FindWindowExW(tray, null, 'ReBarWindow32', null)) ??
      asHwnd(user32.FindWindowExW(tray, null, 'WorkerW', null))
    );
  } catch {
    return null;
  }
}

export function findTaskList(containerHwnd) {
  if (!ensureNative()) return null;
  const container = asHwnd(containerHwnd);
  if (!container) return null;
  try {
    return (
      asHwnd(user32.FindWindowExW(container, null, 'MSTaskSwWClass', null)) ??
      asHwnd(user32.FindWindowExW(container, null, 'MSTaskListWClass', null))
    );
  } catch {
    return null;
  }
}

// 主任务栏 + 所有副屏任务栏。副屏类名固定是 Shell_SecondaryTrayWnd。
export function listTaskbars() {
  if (!ensureNative()) return [];
  const taskbars = [];
  try {
    const primary = asHwnd(user32.FindWindowW('Shell_TrayWnd', null));
    if (primary) taskbars.push(primary);

    let after = null;
    while (true) {
      const next = asHwnd(user32.FindWindowExW(null, after, 'Shell_SecondaryTrayWnd', null));
      if (!next) break;
      if (next !== primary) taskbars.push(next);
      after = next;
    }
  } catch {
    // 枚举失败时至少保留已经找到的部分
  }
  return taskbars;
}

export function getWindowMonitor(hwnd) {
  if (!ensureNative() || !user32.MonitorFromWindow) return null;
  const h = asHwnd(hwnd);
  if (!h) return null;
  try {
    return asHwnd(user32.MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST));
  } catch {
    return null;
  }
}

// 任务栏所在显示器的物理矩形。全屏判定必须针对歌词条所在的显示器，
// 不能再用主显示器 bounds（双屏负坐标/不同缩放下会判错）。
export function getMonitorRect(hwnd) {
  if (!ensureNative() || !user32.GetMonitorInfoW) return null;
  const monitor = getWindowMonitor(hwnd);
  if (!monitor) return null;

  try {
    // koffi 对嵌套 _Out_ 结构的回写不可靠，这里用原始缓冲区按 MONITORINFO 布局解码：
    // cbSize@0, rcMonitor.left/top/right/bottom@4/8/12/16, rcWork@20, dwFlags@36。
    const buffer = koffi.alloc('uint8_t', MONITORINFO_SIZE);
    koffi.encode(buffer, 0, 'uint', MONITORINFO_SIZE);
    if (!user32.GetMonitorInfoW(monitor, buffer)) return null;
    return {
      left: koffi.decode(buffer, 4, 'int'),
      top: koffi.decode(buffer, 8, 'int'),
      right: koffi.decode(buffer, 12, 'int'),
      bottom: koffi.decode(buffer, 16, 'int'),
    };
  } catch {
    return null;
  }
}

export function getTaskbarMetrics(trayHwnd) {
  if (!ensureNative()) return null;
  const tray = asHwnd(trayHwnd);
  if (!tray) return null;

  try {
    const windowRect = {};
    if (!user32.GetWindowRect(tray, windowRect)) return null;

    const clientRect = {};
    if (!user32.GetClientRect(tray, clientRect)) return null;

    const origin = { x: 0, y: 0 };
    if (!user32.ClientToScreen(tray, origin)) return null;

    // GetDpiForWindow 在极老的 Win10 上可能不存在；拿不到就按 96 DPI 处理，
    // 不会因为一个可选 API 让整个任务栏歌词不可用。
    let dpi = 96;
    try {
      if (user32.GetDpiForWindow) dpi = Number(user32.GetDpiForWindow(tray)) || 96;
    } catch {
      dpi = 96;
    }
    const clientWidth = clientRect.right - clientRect.left;
    const clientHeight = clientRect.bottom - clientRect.top;
    if (clientWidth <= 0 || clientHeight <= 0) return null;

    return {
      screenLeft: origin.x,
      screenTop: origin.y,
      clientWidth,
      clientHeight,
      vertical: clientHeight > clientWidth,
      dpiScale: dpi / 96,
      // Shell_TrayWnd 的屏幕矩形（物理像素），用于拒绝顶部/侧边任务栏
      windowRect: {
        left: windowRect.left,
        top: windowRect.top,
        right: windowRect.right,
        bottom: windowRect.bottom,
      },
    };
  } catch {
    return null;
  }
}

export function getWindowRect(hwnd) {
  if (!ensureNative()) return null;
  const h = asHwnd(hwnd);
  if (!h) return null;

  try {
    const rect = {};
    if (!user32.GetWindowRect(h, rect)) return null;
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
  } catch {
    return null;
  }
}

export function getForegroundWindow() {
  if (!ensureNative()) return null;
  try {
    return asHwnd(user32.GetForegroundWindow());
  } catch {
    return null;
  }
}

export function getClassName(hwnd) {
  if (!ensureNative()) return '';
  const h = asHwnd(hwnd);
  if (!h) return '';

  try {
    const buf = Buffer.alloc(512);
    const length = user32.GetClassNameW(h, buf, buf.length / 2);
    if (!length || length <= 0) return '';
    return buf.subarray(0, length * 2).toString('utf16le');
  } catch {
    return '';
  }
}

export function isWindowVisible(hwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;
  try {
    return Boolean(user32.IsWindowVisible(h));
  } catch {
    return false;
  }
}

// 原生隐藏：Electron 的 isVisible 对 SetParent 后的子窗口可能不同步，
// 这里保证隐藏确实落到 HWND 上。
export function hideWindow(hwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;
  try {
    user32.ShowWindow(h, 0); // SW_HIDE
    return true;
  } catch {
    return false;
  }
}

export function getWindowParent(hwnd) {
  if (!ensureNative()) return null;
  const h = asHwnd(hwnd);
  if (!h) return null;
  try {
    return asHwnd(user32.GetParent(h));
  } catch {
    return null;
  }
}

// GetAncestor(GA_PARENT) 取的是 parent，不会像 GetParent 那样在 WS_POPUP
// 窗口上返回 owner。参考项目 EmbeddedTaskbarAnchor.Attach 就是用这个验证嵌入。
export function getWindowAncestor(hwnd) {
  if (!ensureNative()) return null;
  const h = asHwnd(hwnd);
  if (!h) return null;
  try {
    return asHwnd(user32.GetAncestor(h, GA_PARENT));
  } catch {
    return null;
  }
}

export function embedWindow(hwnd, trayHwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  const tray = asHwnd(trayHwnd);
  if (!h || !tray) return false;

  try {
    if (isLegacyBuild()) {
      // Win10：SetParent 后的 popup 仍不是 owned/topmost（实测 GetParent=0），
      // 而任务栏是 topmost；任务栏一重绘就会把它盖住（“只闪一下”）。
      // 改成不 SetParent：任务栏只作为 owner，窗口保持顶层，显示后由
      // Electron setAlwaysOnTop 进入 topmost 层。视觉位置仍由任务列表
      // 压缩出的空档决定。
      const owner = Number(tray);
      try {
        if (user32.SetWindowLongPtrW) {
          user32.SetWindowLongPtrW(h, GWLP_HWNDPARENT, owner);
        } else if (user32.SetWindowLongW) {
          user32.SetWindowLongW(h, GWLP_HWNDPARENT, owner);
        }
      } catch {
        // owner 设置失败不影响 topmost overlay；日志里的 windowsParent 会为空。
      }
    } else {
      // 参考 EmbeddedTaskbarAnchor.Attach：Win11 挂 Shell_TrayWnd 并设 WS_CHILD。
      user32.SetParent(h, tray);
    }

    let style = user32.GetWindowLongW(h, GWL_STYLE);
    const frameBits = WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
    if (isLegacyBuild()) {
      style = (style & ~WS_CHILD) | WS_POPUP;
      style &= ~frameBits;
    } else {
      style = (style & ~WS_POPUP) | WS_CHILD;
    }
    user32.SetWindowLongW(h, GWL_STYLE, style);

    let exStyle = user32.GetWindowLongW(h, GWL_EXSTYLE);
    if (isLegacyBuild()) {
      // SPlayer 同款：透明顶层窗显式补 WS_EX_LAYERED / TOOLWINDOW / NOACTIVATE。
      exStyle |= WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    } else {
      // 参考 ApplyChildWindowStyle：Win11 子窗口去掉 WS_EX_TOOLWINDOW。
      exStyle = (exStyle & ~WS_EX_TOOLWINDOW) | WS_EX_NOACTIVATE;
    }
    user32.SetWindowLongW(h, GWL_EXSTYLE, exStyle);

    if (isLegacyBuild()) {
      // 顶层 overlay 不校验 GA_PARENT（现在父窗口是桌面）；owner 失败也能显示。
      return Boolean(user32.IsWindow(h));
    }
    // 参考项目的 ReparentRejected 检查：GA_PARENT，不用 GetParent。
    return asHwnd(user32.GetAncestor(h, GA_PARENT)) === tray;
  } catch {
    return false;
  }
}

// 诊断用：读回嵌入后的原生样式，确认 popup/child、layered、toolwindow 是否符合预期。
// 下次 Win10 日志里能直接看到窗口是不是真的按 popup + layered 挂上去了。
export function getWindowStyleInfo(hwnd) {
  if (!ensureNative()) return null;
  const h = asHwnd(hwnd);
  if (!h) return null;

  try {
    const style = Number(user32.GetWindowLongW(h, GWL_STYLE)) >>> 0;
    const exStyle = Number(user32.GetWindowLongW(h, GWL_EXSTYLE)) >>> 0;
    return {
      style: `0x${style.toString(16)}`,
      exStyle: `0x${exStyle.toString(16)}`,
      popup: (style & WS_POPUP) !== 0,
      child: (style & WS_CHILD) !== 0,
      layered: (exStyle & WS_EX_LAYERED) !== 0,
      topmost: (exStyle & WS_EX_TOPMOST) !== 0,
      toolWindow: (exStyle & WS_EX_TOOLWINDOW) !== 0,
      noActivate: (exStyle & WS_EX_NOACTIVATE) !== 0,
    };
  } catch {
    return null;
  }
}

export function setWindowBounds(hwnd, { x, y, width, height }) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;

  try {
    // 定位不需要改 z-order：Win10 顶层 overlay 的 topmost 由 Electron
    // setAlwaysOnTop 负责，Win11 子窗口由 assertTopChild 负责。
    return Boolean(
      user32.SetWindowPos(h, null, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE)
    );
  } catch {
    return false;
  }
}

// MoveWindow 的坐标对子窗口而言是父窗口客户区坐标；Win10 压缩任务列表时用。
export function moveWindow(hwnd, { x, y, width, height }) {
  if (!ensureNative() || !user32.MoveWindow) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;

  try {
    return Boolean(user32.MoveWindow(h, x, y, width, height, true));
  } catch {
    return false;
  }
}

export function assertTopChild(hwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;

  try {
    return Boolean(
      user32.SetWindowPos(h, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    );
  } catch {
    return false;
  }
}

export function isWindow(hwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;

  try {
    return Boolean(user32.IsWindow(h));
  } catch {
    return false;
  }
}

export function getTaskbarWindowsFingerprint() {
  if (!ensureNative() || !user32.EnumWindows) return null;

  try {
    let sum = 0n;
    let count = 0;

    user32.EnumWindows((hwnd) => {
      try {
        const h = asHwnd(hwnd);
        if (!h) return true;
        if (!user32.IsWindowVisible(h)) return true;

        const exStyle = user32.GetWindowLongW(h, GWL_EXSTYLE) >>> 0;
        if (exStyle & WS_EX_TOOLWINDOW) return true;

        const owner = asHwnd(user32.GetWindow(h, GW_OWNER));
        if (owner !== null && !(exStyle & WS_EX_APPWINDOW)) return true;

        sum = (sum + h * FINGERPRINT_MULTIPLIER) & MASK_64;
        count += 1;
        return true;
      } catch {
        return true;
      }
    }, 0);

    return `${sum.toString(16)}:${count}`;
  } catch {
    return null;
  }
}

export function isFullscreenRect(rect, bounds) {
  if (!rect || !bounds) return false;
  return (
    rect.left <= bounds.x &&
    rect.top <= bounds.y &&
    rect.right >= bounds.x + bounds.width &&
    rect.bottom >= bounds.y + bounds.height
  );
}

export function isFullscreenForeground({ trayHwnd, ownHwnd, bounds } = {}) {
  if (!ensureNative()) return false;

  try {
    const foreground = getForegroundWindow();
    if (!foreground) return false;
    if (foreground === asHwnd(ownHwnd) || foreground === asHwnd(trayHwnd)) return false;
    if (IGNORED_FOREGROUND_CLASSES.has(getClassName(foreground))) return false;
    if (!bounds) return false;

    const rect = getWindowRect(foreground);
    return rect ? isFullscreenRect(rect, bounds) : false;
  } catch {
    return false;
  }
}

export function readSystemUsesLightTheme() {
  const value = readRegDword(
    'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
    'SystemUsesLightTheme'
  );
  return value === null ? null : value === 1;
}

export function readTaskbarAlignment() {
  return readRegDword(
    'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced',
    'TaskbarAl'
  );
}

export function getOsBuild() {
  return Number(os.release().split('.')[2] || 0);
}

// Win10（build < 22000）的经典任务栏与 Win11 的 XAML 任务栏在窗口嵌入上
// 行为不同，embedWindow 需要按系统选择窗口样式策略。
export function isLegacyBuild() {
  const build = getOsBuild();
  return build > 0 && build < 22000;
}

export function getNativeInitError() {
  ensureNative();
  return initError;
}

// 全局快捷键回调里区分左右 Ctrl/Alt：Electron 的 globalShortcut 不提供修饰键信息。
// 多数键盘布局里 AltGr 就是右侧 Ctrl+Alt，这里在右侧 Ctrl/Alt 按下时忽略这次切换，
// 避免用户用 AltGr 输入字符时误开/误关任务栏歌词。拿不到状态时返回 false（放行）。
const VK_RCONTROL = 0xa3;
const VK_RMENU = 0xa5;

export function isRightAltOrCtrlDown() {
  if (!ensureNative() || !user32.GetAsyncKeyState) return false;
  try {
    const rightCtrl = user32.GetAsyncKeyState(VK_RCONTROL);
    const rightAlt = user32.GetAsyncKeyState(VK_RMENU);
    return (rightCtrl & 0x8000) !== 0 || (rightAlt & 0x8000) !== 0;
  } catch {
    return false;
  }
}
