const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dreamApi', {
  importFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  loadSavedMusic: () => ipcRenderer.invoke('app:loadSavedMusic'),
  savePlaybackState: (state) => ipcRenderer.invoke('app:savePlaybackState', state),
  loadPlaybackState: () => ipcRenderer.invoke('app:loadPlaybackState'),
  syncFolder: () => ipcRenderer.invoke('app:syncFolder'),

  getCover: async (path) => {
    const res = await ipcRenderer.invoke('app:getCover', path);
    if (res && res.buffer) {
      const blob = new Blob([res.buffer], { type: res.format });
      return URL.createObjectURL(blob);
    }
    return null;
  },

  getLyrics: (path) => ipcRenderer.invoke('app:getLyrics', path),

  onWindowVisibilityChanged: (callback) => ipcRenderer.on('window-visibility-changed', (event, isVisible) => callback(isVisible)),
  onTrayPlayPause: (callback) => ipcRenderer.on('tray-play-pause', () => callback()),
  onTrayNext: (callback) => ipcRenderer.on('tray-next', () => callback()),
  onTrayPrev: (callback) => ipcRenderer.on('tray-prev', () => callback()),

  toggleMiniMode: () => ipcRenderer.invoke('app:toggleMiniMode'),
  onWindowModeChanged: (callback) => ipcRenderer.on('window-mode-changed', (event, mode) => callback(mode)),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  getPlatform: () => process.platform
});
