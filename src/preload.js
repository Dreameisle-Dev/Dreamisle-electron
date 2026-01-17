const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dreamApi', {
  importFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  loadSavedMusic: () => ipcRenderer.invoke('app:loadSavedMusic')
});