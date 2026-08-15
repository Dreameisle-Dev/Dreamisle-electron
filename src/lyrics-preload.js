const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyricsApi', {
  onText: (callback) => ipcRenderer.on('lyrics:text', (event, text) => callback(text)),
});
