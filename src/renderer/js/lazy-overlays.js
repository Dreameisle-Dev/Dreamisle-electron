// 低频浮层模块按需懒加载代理：避免冷启动阶段解析 albums.js(46KB) / settings.js(39KB) / stats.js(8KB)
// 及其传递依赖；首次触发交互时动态 import 并一次性绑定模块内事件。

let settingsMod = null;
let settingsPromise = null;

function loadSettingsModule() {
  if (settingsMod) return Promise.resolve(settingsMod);
  if (!settingsPromise) {
    settingsPromise = import('./settings.js')
      .then((mod) => {
        mod.bindSettingsEvents();
        settingsMod = mod;
        return mod;
      })
      .catch((error) => {
        settingsPromise = null;
        throw error;
      });
  }
  return settingsPromise;
}

export function toggleSettings() {
  if (settingsMod) return settingsMod.toggleSettings();
  return loadSettingsModule()
    .then((mod) => mod.toggleSettings())
    .catch(() => {});
}

export function closeSettings() {
  if (settingsMod) settingsMod.closeSettings();
}

let albumsMod = null;
let albumsPromise = null;

function loadAlbumsModule() {
  if (albumsMod) return Promise.resolve(albumsMod);
  if (!albumsPromise) {
    albumsPromise = import('./albums.js')
      .then((mod) => {
        mod.bindAlbumsEvents();
        albumsMod = mod;
        return mod;
      })
      .catch((error) => {
        albumsPromise = null;
        throw error;
      });
  }
  return albumsPromise;
}

export function openAlbums() {
  if (albumsMod) return albumsMod.openAlbums();
  return loadAlbumsModule()
    .then((mod) => mod.openAlbums())
    .catch(() => {});
}

export function toggleAlbums() {
  if (albumsMod) return albumsMod.toggleAlbums();
  return loadAlbumsModule()
    .then((mod) => mod.toggleAlbums())
    .catch(() => {});
}

export function closeAlbums() {
  if (albumsMod) albumsMod.closeAlbums();
}

export function isAlbumsOpen() {
  return albumsMod ? albumsMod.isAlbumsOpen() : false;
}

export function handleAlbumsKeydown(e) {
  return albumsMod ? albumsMod.handleAlbumsKeydown(e) : false;
}

let statsMod = null;
let statsPromise = null;

function loadStatsModule() {
  if (statsMod) return Promise.resolve(statsMod);
  if (!statsPromise) {
    statsPromise = import('./stats.js')
      .then((mod) => {
        mod.bindStatsEvents();
        statsMod = mod;
        return mod;
      })
      .catch((error) => {
        statsPromise = null;
        throw error;
      });
  }
  return statsPromise;
}

export function toggleStats() {
  if (statsMod) return statsMod.toggleStats();
  return loadStatsModule()
    .then((mod) => mod.toggleStats())
    .catch(() => {});
}

export function closeStats() {
  if (statsMod) statsMod.closeStats();
}

export function isStatsOpen() {
  return statsMod ? statsMod.isStatsOpen() : false;
}

let onlineMod = null;
let onlinePromise = null;

function loadOnlineModule() {
  if (onlineMod) return Promise.resolve(onlineMod);
  if (!onlinePromise) {
    onlinePromise = import('./online-explore.js')
      .then((mod) => {
        mod.bindOnlineExploreEvents();
        onlineMod = mod;
        return mod;
      })
      .catch((error) => {
        onlinePromise = null;
        throw error;
      });
  }
  return onlinePromise;
}

export function openOnlineExplore() {
  if (onlineMod) return onlineMod.openOnlineExplore();
  return loadOnlineModule()
    .then((mod) => mod.openOnlineExplore())
    .catch(() => {});
}

export function toggleOnlineExplore() {
  if (onlineMod) return onlineMod.toggleOnlineExplore();
  return loadOnlineModule()
    .then((mod) => mod.toggleOnlineExplore())
    .catch(() => {});
}

export function closeOnlineExplore() {
  if (onlineMod) onlineMod.closeOnlineExplore();
}

export function isOnlineExploreOpen() {
  return onlineMod ? onlineMod.isOnlineExploreOpen() : false;
}
