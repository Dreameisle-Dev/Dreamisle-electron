// 插件系统主进程 IPC 注册：严格走 handleMainIpc / onMainIpc 校验主渲染进程来源。
import { dialog, shell } from 'electron';
import fs from 'node:fs/promises';
import { serializePluginError } from '../../../packages/dreamisle-plugin-sdk/src/index.js';
import { handleMainIpc, onMainIpc } from '../security.js';
import { readPluginArtworkThumbnail } from '../music-library.js';
import { getPluginsRootDir } from './installer.js';
import {
  emitLifecyclePlaybackState,
  emitLifecycleTrackChange,
  emitLifecycleTrackComplete,
  getPluginAlbumTracks,
  getPluginConfigForUi,
  getPluginHome,
  getPluginLogs,
  getPluginPlaylistTracks,
  getPluginPreferences,
  getPluginUserPlaylists,
  installPluginFolder,
  installPluginZip,
  listPluginSummaries,
  pluginAuthFormSubmit,
  pluginAuthGetAccount,
  pluginAuthLogout,
  pluginAuthQrPoll,
  pluginAuthQrStart,
  refreshInstalledPlugins,
  registerSongSnapshots,
  restartPlugin,
  savePluginConfigFromUi,
  searchPluginSource,
  setPluginEnabled,
  uninstallPlugin,
  updateOnlineLyricsFallback,
  updatePreferredQuality,
} from './plugin-manager.js';

async function wrapResult(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: serializePluginError(err) };
  }
}

export function registerPluginIpc() {
  handleMainIpc('plugins:list', () => listPluginSummaries());
  handleMainIpc('plugins:refresh', () => refreshInstalledPlugins({ startEnabled: true }));
  handleMainIpc('plugins:getPreferences', () => getPluginPreferences());
  handleMainIpc('plugins:setPreferredQuality', (_e, quality) => updatePreferredQuality(quality));
  handleMainIpc('plugins:setOnlineLyricsFallback', (_e, enabled) =>
    updateOnlineLyricsFallback(enabled)
  );

  handleMainIpc('plugins:openDir', async () => {
    const dir = getPluginsRootDir();
    await fs.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });

  handleMainIpc('plugins:installFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths?.[0]) return { ok: true, canceled: true };
    return wrapResult(() => installPluginFolder(filePaths[0]));
  });

  handleMainIpc('plugins:installZip', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Dreamisle Plugin Archive', extensions: ['zip', 'dplugin'] }],
    });
    if (canceled || !filePaths?.[0]) return { ok: true, canceled: true };
    return wrapResult(() => installPluginZip(filePaths[0]));
  });

  // 供测试或拖拽本地目录/压缩包路径使用
  handleMainIpc('plugins:installFromPath', async (_e, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath) {
      return { ok: false, error: serializePluginError(new Error('Invalid path')) };
    }
    return wrapResult(async () => {
      const st = await fs.stat(targetPath);
      if (st.isDirectory()) return installPluginFolder(targetPath);
      return installPluginZip(targetPath);
    });
  });

  handleMainIpc('plugins:setEnabled', (_e, pluginId, enabled) =>
    wrapResult(() => setPluginEnabled(pluginId, !!enabled))
  );
  handleMainIpc('plugins:restart', (_e, pluginId) => wrapResult(() => restartPlugin(pluginId)));
  handleMainIpc('plugins:uninstall', (_e, pluginId) => wrapResult(() => uninstallPlugin(pluginId)));
  handleMainIpc('plugins:getLogs', (_e, pluginId) => getPluginLogs(pluginId));

  handleMainIpc('plugins:getConfig', (_e, pluginId) => getPluginConfigForUi(pluginId));
  handleMainIpc('plugins:setConfig', (_e, pluginId, values) =>
    wrapResult(() => savePluginConfigFromUi(pluginId, values))
  );

  handleMainIpc('plugins:authGetAccount', (_e, pluginId) =>
    wrapResult(() => pluginAuthGetAccount(pluginId))
  );
  handleMainIpc('plugins:authLogout', (_e, pluginId) =>
    wrapResult(() => pluginAuthLogout(pluginId))
  );
  handleMainIpc('plugins:authQrStart', (_e, pluginId) =>
    wrapResult(() => pluginAuthQrStart(pluginId))
  );
  handleMainIpc('plugins:authQrPoll', (_e, pluginId, key) =>
    wrapResult(() => pluginAuthQrPoll(pluginId, key))
  );
  handleMainIpc('plugins:authFormSubmit', (_e, pluginId, values) =>
    wrapResult(() => pluginAuthFormSubmit(pluginId, values))
  );

  handleMainIpc('plugins:search', (_e, pluginId, opts) =>
    wrapResult(() => searchPluginSource(pluginId, opts || {}))
  );
  handleMainIpc('plugins:getHome', (_e, pluginId) => wrapResult(() => getPluginHome(pluginId)));
  handleMainIpc('plugins:getUserPlaylists', (_e, pluginId) =>
    wrapResult(() => getPluginUserPlaylists(pluginId))
  );
  handleMainIpc('plugins:getAlbumTracks', (_e, pluginId, albumId) =>
    wrapResult(() => getPluginAlbumTracks(pluginId, albumId))
  );
  handleMainIpc('plugins:getPlaylistTracks', (_e, pluginId, playlistId, page, pageSize) =>
    wrapResult(() => getPluginPlaylistTracks(pluginId, playlistId, page, pageSize))
  );
  handleMainIpc('plugins:getArtworkThumb', (_e, pluginId, artworkUrl, maxSize) =>
    readPluginArtworkThumbnail(pluginId, artworkUrl, maxSize)
  );

  onMainIpc('plugins:registerTracks', (_e, songs) => {
    registerSongSnapshots(songs);
  });
  onMainIpc('plugins:lifecycleTrackChange', (_e, track) => {
    emitLifecycleTrackChange(track);
  });
  onMainIpc('plugins:lifecyclePlaybackState', (_e, payload) => {
    emitLifecyclePlaybackState(payload);
  });
  onMainIpc('plugins:lifecycleTrackComplete', (_e, payload) => {
    emitLifecycleTrackComplete(payload);
  });
}
