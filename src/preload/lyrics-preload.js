const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyricsApi', {
  onText: (callback) => ipcRenderer.on('lyrics:text', (event, text) => callback(text)),
  onStyle: (callback) => ipcRenderer.on('lyrics:style', (event, style) => callback(style)),
  onLang: (callback) => ipcRenderer.on('lyrics:lang', (event, lang) => callback(lang)),
});
