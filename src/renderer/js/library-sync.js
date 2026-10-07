// 曲库重新扫描：把主进程的增量同步结果套用到渲染层状态。
//
// 单独成模块是因为有两个调用方：index.js（启动时自动同步）和 settings.js（手动刷新按钮）。
// index.js 已经 import 了 settings.js，所以 settings.js 不能反过来 import index.js；
// playlists.js 也已经 import 了 playlist.js，同步逻辑同样塞不进 playlist.js。两边都会成环。
import { t } from '../../shared/i18n.js';
import { state } from './state.js';
import { showSyncToast } from './helpers.js';
import { applyPlaylistFromMain } from './playlist.js';
import { prunePlaylistsFromLibrary, renderPlaylistsList } from './playlists.js';

/**
 * 扫描曲库目录，把新增/删除的歌曲套用到当前队列。
 *
 * manual=false（启动时自动同步）：没变化就静默返回，只在发现新歌时提示 ——
 *   否则每次开 app 都要弹一次「已是最新」。
 * manual=true（用户点「重新扫描」）：无论有没有变化都给反馈，
 *   用户主动点的操作静默收场会被当成没反应。
 *
 * @returns {Promise<{added:number, removed:number, playlist:Array}|null>} 主进程返回的同步结果；未配置文件夹时为 null
 */
export async function syncLibrary({ manual = false } = {}) {
  const result = await window.dreamApi.syncFolder();

  if (!result) {
    // 一个音乐文件夹都没有，扫描无从谈起
    if (manual) showSyncToast(t('settings.noFolders'));
    return null;
  }

  const changed = result.added > 0 || result.removed > 0;

  if (changed) {
    if (state.activeQueue.type === 'playlist') {
      // 歌单队列中：只更新曲库缓存，不打断播放；随后清理歌单里已失效的歌曲
      state.librarySongs = [...result.playlist];
      await prunePlaylistsFromLibrary();
    } else {
      applyPlaylistFromMain(result.playlist);
    }
    // 歌单抽屉的「全部歌曲」数量按 librarySongs 渲染，不同步刷新就会停在旧数字 ——
    // prunePlaylistsFromLibrary 只在真清理掉歌时才重渲染，纯新增的情况会漏掉。
    renderPlaylistsList();
  }

  if (manual) {
    showSyncToast(
      changed
        ? t('sync.rescanResult', { added: result.added, removed: result.removed })
        : t('sync.upToDate')
    );
  } else if (result.added > 0) {
    showSyncToast(t('sync.foundNew', { n: result.added }));
  }

  return result;
}
