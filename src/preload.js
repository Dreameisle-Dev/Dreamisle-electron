const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dreamApi', {
  importFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  loadSavedMusic: () => ipcRenderer.invoke('app:loadSavedMusic'),
  savePlaybackState: (state) => ipcRenderer.invoke('app:savePlaybackState', state),
  loadPlaybackState: () => ipcRenderer.invoke('app:loadPlaybackState')
});