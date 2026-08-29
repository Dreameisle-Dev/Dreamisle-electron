const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dreamApi', {
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
  updateDesktopLyrics: (text) => ipcRenderer.invoke('app:updateDesktopLyrics', text),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setLanguage: (lang) => ipcRenderer.invoke('settings:setLanguage', lang),
  setLyricsStyle: (style) => ipcRenderer.invoke('settings:setLyricsStyle', style),
  setLyricsTranslation: (visible) => ipcRenderer.invoke('settings:setLyricsTranslation', visible),
  addFolder: () => ipcRenderer.invoke('folders:add'),
  removeFolder: (folderPath) => ipcRenderer.invoke('folders:remove', folderPath),

  onWindowVisibilityChanged: (callback) =>
    ipcRenderer.on('window-visibility-changed', (event, isVisible) => callback(isVisible)),
  onTrayPlayPause: (callback) => ipcRenderer.on('tray-play-pause', () => callback()),
  onTrayNext: (callback) => ipcRenderer.on('tray-next', () => callback()),
  onTrayPrev: (callback) => ipcRenderer.on('tray-prev', () => callback()),

  toggleMiniMode: () => ipcRenderer.invoke('app:toggleMiniMode'),
  onWindowModeChanged: (callback) =>
    ipcRenderer.on('window-mode-changed', (event, mode) => callback(mode)),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  playlists: {
    list: () => ipcRenderer.invoke('playlists:list'),
    create: (name) => ipcRenderer.invoke('playlists:create', name),
    rename: (id, name) => ipcRenderer.invoke('playlists:rename', id, name),
    delete: (id) => ipcRenderer.invoke('playlists:delete', id),
    addSong: (id, song) => ipcRenderer.invoke('playlists:addSong', id, song),
    removeSong: (id, path) => ipcRenderer.invoke('playlists:removeSong', id, path),
    reorder: (id, from, to) => ipcRenderer.invoke('playlists:reorder', id, from, to),
    prune: (validPaths) => ipcRenderer.invoke('playlists:prune', validPaths),
  },
  getPlatform: () => process.platform,
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getStats: () => ipcRenderer.invoke('stats:get'),
  recordPlay: (path, kind) => ipcRenderer.invoke('stats:recordPlay', path, kind),
});
