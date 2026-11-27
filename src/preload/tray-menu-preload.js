const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayMenuApi', {
  onState: (callback) => ipcRenderer.on('tray-menu:state', (_event, state) => callback(state)),
  onShown: (callback) => ipcRenderer.on('tray-menu:shown', (_event, seq) => callback(seq)),
  ready: (metrics) => ipcRenderer.send('tray-menu:ready', metrics),
  action: (name) => ipcRenderer.send('tray-menu:action', name),
  close: () => ipcRenderer.send('tray-menu:close'),
});
