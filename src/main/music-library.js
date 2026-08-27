import path from 'path';
import { pathToFileURL } from 'url';
import { parseFile } from 'music-metadata';
import fs from 'fs/promises';

const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.wav', '.ogg', '.m4a'];

// 旧版缓存只有 path/url/title/artist,判断是否需要迁移重扫补充音质规格字段
export function hasLegacyMetadata(playlist) {
  return playlist.length > 0 && playlist.some((s) => s.album === undefined);
}

async function scanDirectory(dirPath) {
  let results = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(await scanDirectory(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.includes(ext)) results.push(fullPath);
      }
    }
  } catch (err) {
    console.error('Scan Error:', err);
  }
  return results;
}

export async function parseAudioFile(filePath) {
  try {
    const metadata = await parseFile(filePath, { skipCovers: true, skipPostHeaders: true });
    const format = metadata.format || {};
    return {
      path: filePath,
      url: pathToFileURL(filePath).href,
      title: metadata.common.title || path.basename(filePath),
      artist: metadata.common.artist || 'Unknown',
      album: metadata.common.album || null,
      bitrate: format.bitrate || null,
      sampleRate: format.sampleRate || null,
      bitsPerSample: format.bitsPerSample || null,
      codec: format.codec || null,
    };
  } catch (e) {
    return {
      path: filePath,
      url: pathToFileURL(filePath).href,
      title: path.basename(filePath),
      artist: 'Unknown',
      album: null,
      bitrate: null,
      sampleRate: null,
      bitsPerSample: null,
      codec: null,
    };
  }
}

// 合并扫描多个文件夹：跨文件夹按路径去重，逐个解析元数据
export async function scanAllFolders(folderPaths) {
  const seen = new Set();
  const playlist = [];
  for (const folderPath of folderPaths) {
    const files = await scanDirectory(folderPath); // 文件夹不存在时返回 []
    for (const filePath of files) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      playlist.push(await parseAudioFile(filePath));
    }
  }
  return playlist;
}

// 收集所有文件夹下的磁盘文件路径：已删除的文件夹跳过
export async function collectDiskPaths(folderPaths) {
  const diskPaths = [];
  for (const folderPath of folderPaths) {
    try {
      await fs.access(folderPath);
    } catch (e) {
      continue;
    } // 已删除的文件夹跳过
    diskPaths.push(...(await scanDirectory(folderPath)));
  }
  return [...new Set(diskPaths)];
}

export async function readCover(filePath) {
  try {
    const metadata = await parseFile(filePath, { skipCovers: false, skipPostHeaders: true });
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0];
      return { buffer: pic.data, format: pic.format };
    }
  } catch (e) {}
  return null;
}

// 优先读取同目录同名 .lrc 文件，其次读取内嵌歌词
export async function readLyrics(audioPath) {
  try {
    const lrcPath = audioPath.substring(0, audioPath.lastIndexOf('.')) + '.lrc';
    await fs.access(lrcPath);
    return await fs.readFile(lrcPath, 'utf-8');
  } catch (e) {}

  try {
    const metadata = await parseFile(audioPath);
    if (metadata.common && metadata.common.lyrics && metadata.common.lyrics.length > 0) {
      return metadata.common.lyrics[0];
    }
  } catch (err) {}
  return null;
}

// 对比缓存路径与磁盘路径，得到新增与消失的文件
export function diffPlaylistPaths(cachedPaths, diskPaths) {
  const cachedSet = new Set(cachedPaths);
  const diskSet = new Set(diskPaths);
  return {
    added: diskPaths.filter((p) => !cachedSet.has(p)),
    removed: cachedPaths.filter((p) => !diskSet.has(p)),
  };
}

// 将同步结果应用到缓存列表：移除消失的歌曲，末尾追加新歌曲
export function applySyncToPlaylist(cachedPlaylist, addedEntries, removedPaths) {
  const removed = new Set(removedPaths);
  return cachedPlaylist.filter((s) => !removed.has(s.path)).concat(addedEntries);
}
