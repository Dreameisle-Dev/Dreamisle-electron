const { contextBridge, ipcRenderer } = require('electron');

// 任务栏歌词条的最小桥接面：只接收主进程下发的配置/文档/播放状态，
// 并把内容宽度回报给主进程用于计算窗口尺寸。
contextBridge.exposeInMainWorld('taskbarApi', {
  onConfig: (callback) => ipcRenderer.on('taskbar:config', (event, config) => callback(config)),
  onDocument: (callback) => ipcRenderer.on('taskbar:document', (event, doc) => callback(doc)),
  onPlayback: (callback) => ipcRenderer.on('taskbar:playback', (event, state) => callback(state)),
  onCover: (callback) => ipcRenderer.on('taskbar:cover', (event, url) => callback(url)),
  reportWidth: (px) => ipcRenderer.send('taskbar:width', px),
  ready: () => ipcRenderer.send('taskbar:ready'),
});
