const { contextBridge, ipcRenderer } = require('electron');

function resolveCoverResponse(res) {
  if (typeof res === 'string') return res;
  if (res && res.buffer) {
    const blob = new Blob([res.buffer], { type: res.format });
    return URL.createObjectURL(blob);
  }
  return null;
}

contextBridge.exposeInMainWorld('dreamApi', {
  bootstrap: async () => {
    const data = await ipcRenderer.invoke('app:bootstrap');
    if (data && data.initialCover) {
      data.initialCover = {
        songPath: data.initialCover.songPath,
        url: resolveCoverResponse(data.initialCover.value),
      };
    }
    return data;
  },
  loadSavedMusic: () => ipcRenderer.invoke('app:loadSavedMusic'),
  savePlaybackState: (state) => ipcRenderer.invoke('app:savePlaybackState', state),
  loadPlaybackState: () => ipcRenderer.invoke('app:loadPlaybackState'),
  getPlayQueue: () => ipcRenderer.invoke('queue:get'),
  savePlayQueue: (queue) => ipcRenderer.send('queue:set', queue),
  syncFolder: () => ipcRenderer.invoke('app:syncFolder'),

  getCover: async (path, songMeta = null) => {
    return resolveCoverResponse(await ipcRenderer.invoke('app:getCover', path, songMeta));
  },

  getCoverThumb: async (path, maxSize = 320, songMeta = null) => {
    return resolveCoverResponse(
      await ipcRenderer.invoke('app:getCoverThumb', path, maxSize, songMeta)
    );
  },

  getLyrics: (path, songMeta = null) => ipcRenderer.invoke('app:getLyrics', path, songMeta),
  updateDesktopLyrics: (payload) => ipcRenderer.invoke('app:updateDesktopLyrics', payload),
  // 任务栏歌词数据流（fire-and-forget，避免高频 invoke 的 Promise 开销）
  setTaskbarLyricsDocument: (doc) => ipcRenderer.send('app:setTaskbarLyricsDocument', doc),
  updateTaskbarLyricsPlayback: (playback) =>
    ipcRenderer.send('app:updateTaskbarLyricsPlayback', playback),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setLanguage: (lang) => ipcRenderer.invoke('settings:setLanguage', lang),
  setLyricsStyle: (style) => ipcRenderer.invoke('settings:setLyricsStyle', style),
  setDesktopLyricsClickThrough: (enabled) =>
    ipcRenderer.invoke('settings:setDesktopLyricsClickThrough', enabled),
  setDesktopLyricsLines: (lines) => ipcRenderer.invoke('settings:setDesktopLyricsLines', lines),
  setDesktopLyricsEnabled: (enabled) =>
    ipcRenderer.invoke('settings:setDesktopLyricsEnabled', enabled),
  setTaskbarLyricsEnabled: (enabled) =>
    ipcRenderer.invoke('settings:setTaskbarLyricsEnabled', enabled),
  setMenubarLyricsEnabled: (enabled) =>
    ipcRenderer.invoke('settings:setMenubarLyricsEnabled', enabled),
  setTaskbarLyricsStyle: (style) => ipcRenderer.invoke('settings:setTaskbarLyricsStyle', style),
  setEqualizer: (eq) => ipcRenderer.invoke('settings:setEqualizer', eq),
  setLyricsTranslation: (visible) => ipcRenderer.invoke('settings:setLyricsTranslation', visible),
  setThemeMode: (mode) => ipcRenderer.invoke('settings:setThemeMode', mode),
  setPerformanceMode: (enabled) => ipcRenderer.invoke('settings:setPerformanceMode', enabled),
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
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    refresh: () => ipcRenderer.invoke('plugins:refresh'),
    openDir: () => ipcRenderer.invoke('plugins:openDir'),
    installFolder: () => ipcRenderer.invoke('plugins:installFolder'),
    installZip: () => ipcRenderer.invoke('plugins:installZip'),
    installFromPath: (targetPath) => ipcRenderer.invoke('plugins:installFromPath', targetPath),
    setEnabled: (pluginId, enabled) => ipcRenderer.invoke('plugins:setEnabled', pluginId, enabled),
    restart: (pluginId) => ipcRenderer.invoke('plugins:restart', pluginId),
    uninstall: (pluginId) => ipcRenderer.invoke('plugins:uninstall', pluginId),
    getLogs: (pluginId) => ipcRenderer.invoke('plugins:getLogs', pluginId),
    getConfig: (pluginId) => ipcRenderer.invoke('plugins:getConfig', pluginId),
    setConfig: (pluginId, values) => ipcRenderer.invoke('plugins:setConfig', pluginId, values),
    authGetAccount: (pluginId) => ipcRenderer.invoke('plugins:authGetAccount', pluginId),
    authLogout: (pluginId) => ipcRenderer.invoke('plugins:authLogout', pluginId),
    authQrStart: (pluginId) => ipcRenderer.invoke('plugins:authQrStart', pluginId),
    authQrPoll: (pluginId, key) => ipcRenderer.invoke('plugins:authQrPoll', pluginId, key),
    authFormSubmit: (pluginId, values) =>
      ipcRenderer.invoke('plugins:authFormSubmit', pluginId, values),
    search: (pluginId, opts) => ipcRenderer.invoke('plugins:search', pluginId, opts),
    getHome: (pluginId) => ipcRenderer.invoke('plugins:getHome', pluginId),
    getUserPlaylists: (pluginId) => ipcRenderer.invoke('plugins:getUserPlaylists', pluginId),
    getAlbumTracks: (pluginId, albumId) =>
      ipcRenderer.invoke('plugins:getAlbumTracks', pluginId, albumId),
    getPlaylistTracks: (pluginId, playlistId, page, pageSize) =>
      ipcRenderer.invoke('plugins:getPlaylistTracks', pluginId, playlistId, page, pageSize),
    getArtworkThumb: async (pluginId, artworkUrl, maxSize = 320) => {
      return resolveCoverResponse(
        await ipcRenderer.invoke('plugins:getArtworkThumb', pluginId, artworkUrl, maxSize)
      );
    },
    registerTracks: (songs) => ipcRenderer.send('plugins:registerTracks', songs),
    emitTrackChange: (track) => ipcRenderer.send('plugins:lifecycleTrackChange', track),
    emitPlaybackState: (payload) => ipcRenderer.send('plugins:lifecyclePlaybackState', payload),
    emitTrackComplete: (payload) => ipcRenderer.send('plugins:lifecycleTrackComplete', payload),
    onChanged: (callback) => ipcRenderer.on('plugins:changed', (_event, list) => callback(list)),
    onStreamError: (callback) =>
      ipcRenderer.on('plugins:stream-error', (_event, payload) => callback(payload)),
  },
});
