import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_APPWINDOW = 0x40000;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;
const SWP_FRAMECHANGED = 0x20;
const GW_OWNER = 4;
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

function ensureNative() {
  if (initialized) return available;
  initialized = true;
  if (process.platform !== 'win32') return false;

  try {
    koffi = require('koffi');
    const user32Lib = koffi.load('user32.dll');
    const advapi32Lib = koffi.load('advapi32.dll');

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
      GetDpiForWindow: user32Lib.func('uint __stdcall GetDpiForWindow(void *hWnd)'),
      SetParent: user32Lib.func('void * __stdcall SetParent(void *hWndChild, void *hWndNewParent)'),
      GetParent: user32Lib.func('void * __stdcall GetParent(void *hWnd)'),
      GetWindowLongW: user32Lib.func('long __stdcall GetWindowLongW(void *hWnd, int nIndex)'),
      SetWindowLongW: user32Lib.func(
        'long __stdcall SetWindowLongW(void *hWnd, int nIndex, long dwNewLong)'
      ),
      SetWindowPos: user32Lib.func(
        'bool __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'
      ),
      ShowWindow: user32Lib.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)'),
      IsWindow: user32Lib.func('bool __stdcall IsWindow(void *hWnd)'),
      IsWindowVisible: user32Lib.func('bool __stdcall IsWindowVisible(void *hWnd)'),
      GetForegroundWindow: user32Lib.func('void * __stdcall GetForegroundWindow()'),
      GetAsyncKeyState: user32Lib.func('short __stdcall GetAsyncKeyState(int vKey)'),
      GetWindow: user32Lib.func('void * __stdcall GetWindow(void *hWnd, uint uCmd)'),
      EnumWindows: user32Lib.func(
        'bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)'
      ),
      GetClassNameW: user32Lib.func(
        'int __stdcall GetClassNameW(void *hWnd, _Out_ uint8_t *lpClassName, int nMaxCount)'
      ),
    };

    advapi32 = {
      RegGetValueW: advapi32Lib.func(
        'int __stdcall RegGetValueW(intptr_t hkey, const char16_t *lpSubKey, const char16_t *lpValue, uint dwFlags, uint *pdwType, _Out_ uint *pvData, uint *pcbData)'
      ),
    };

    available = true;
  } catch {
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
  if (!ensureNative()) return null;
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

    const dpi = user32.GetDpiForWindow(tray);
    const clientWidth = clientRect.right - clientRect.left;
    const clientHeight = clientRect.bottom - clientRect.top;

    // 仅支持横排任务栏；竖排时客户区宽度不会大于高度，按不支持处理
    if (clientWidth <= clientHeight) return null;

    return {
      screenLeft: origin.x,
      screenTop: origin.y,
      clientWidth,
      clientHeight,
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

export function embedWindow(hwnd, trayHwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  const tray = asHwnd(trayHwnd);
  if (!h || !tray) return false;

  try {
    user32.SetParent(h, tray);

    const style = (user32.GetWindowLongW(h, GWL_STYLE) & ~WS_POPUP) | WS_CHILD;
    user32.SetWindowLongW(h, GWL_STYLE, style);

    const exStyle = user32.GetWindowLongW(h, GWL_EXSTYLE) | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    user32.SetWindowLongW(h, GWL_EXSTYLE, exStyle);

    return asHwnd(user32.GetParent(h)) === tray;
  } catch {
    return false;
  }
}

export function setWindowBounds(hwnd, { x, y, width, height }) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;

  try {
    return Boolean(
      user32.SetWindowPos(h, null, x, y, width, height, SWP_NOACTIVATE | SWP_FRAMECHANGED)
    );
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
  if (!ensureNative()) return null;

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

// 全局快捷键回调里区分左右 Ctrl/Alt：Electron 的 globalShortcut 不提供修饰键信息。
// 多数键盘布局里 AltGr 就是右侧 Ctrl+Alt，这里在右侧 Ctrl/Alt 按下时忽略这次切换，
// 避免用户用 AltGr 输入字符时误开/误关任务栏歌词。拿不到状态时返回 false（放行）。
const VK_RCONTROL = 0xa3;
const VK_RMENU = 0xa5;

export function isRightAltOrCtrlDown() {
  if (!ensureNative()) return false;
  try {
    const rightCtrl = user32.GetAsyncKeyState(VK_RCONTROL);
    const rightAlt = user32.GetAsyncKeyState(VK_RMENU);
    return (rightCtrl & 0x8000) !== 0 || (rightAlt & 0x8000) !== 0;
  } catch {
    return false;
  }
}
