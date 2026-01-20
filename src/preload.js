const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dreamApi', {
  importFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  loadSavedMusic: () => ipcRenderer.invoke('app:loadSavedMusic'),
  savePlaybackState: (state) => ipcRenderer.invoke('app:savePlaybackState', state),
  loadPlaybackState: () => ipcRenderer.invoke('app:loadPlaybackState'),

  // 窗口控制
  onWindowVisibilityChanged: (callback) => ipcRenderer.on('window-visibility-changed', (event, isVisible) => callback(isVisible)),

  // 托盘控制
  onTrayPlayPause: (callback) => ipcRenderer.on('tray-play-pause', () => callback()),
  onTrayNext: (callback) => ipcRenderer.on('tray-next', () => callback()),
  onTrayPrev: (callback) => ipcRenderer.on('tray-prev', () => callback())
});