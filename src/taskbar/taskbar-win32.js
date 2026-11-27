// Windows 任务栏 Win32 FFI 绑定统一由独立开源子模块 `packages/electron-taskbar-widget` 提供，
// 保留此入口供主进程（如 `isRightAltOrCtrlDown`）引用。
export * from '../../packages/electron-taskbar-widget/src/win32.js';
