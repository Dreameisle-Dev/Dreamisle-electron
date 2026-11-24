import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { app, nativeImage } from 'electron';
import { parseFile } from 'music-metadata';
import fs from 'fs/promises';
import { AUDIO_EXTENSIONS, resolveAllowedLibraryFile } from './security.js';

const MAX_LRC_BYTES = 2 * 1024 * 1024;
const MAX_COVER_THUMB_CACHE = 500;

// 主进程封面缩略图 LRU 缓存（含无封面的负缓存 null），避免滑动回看重复读盘解码大图
const coverThumbCache = new Map();
const coverThumbInflight = new Map();
let thumbDirPromise = null;

function getThumbDir() {
  if (!thumbDirPromise) {
    const dir = path.join(app.getPath('userData'), 'cover-thumbs');
    thumbDirPromise = fs
      .mkdir(dir, { recursive: true })
      .then(() => dir)
      .catch(() => null);
  }
  return thumbDirPromise;
}

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
    const common = metadata.common || {};
    return {
      path: filePath,
      url: pathToFileURL(filePath).href,
      title: common.title || path.basename(filePath),
      artist: common.artist || 'Unknown',
      album: common.album || null,
      trackNo: common.track?.no || null,
      discNo: common.disk?.no || null,
      year: common.year || null,
      duration: Number.isFinite(format.duration) ? Math.round(format.duration) : null,
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
      trackNo: null,
      discNo: null,
      year: null,
      duration: null,
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

export async function readCover(filePath, allowedFolders) {
  try {
    const safePath = await resolveAllowedLibraryFile(filePath, allowedFolders);
    if (!safePath) return null;
    const metadata = await parseFile(safePath, { skipCovers: false, skipPostHeaders: true });
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0];
      return { buffer: pic.data, format: pic.format };
    }
  } catch (e) {}
  return null;
}

function setCoverThumbCache(cacheKey, value) {
  coverThumbCache.delete(cacheKey);
  coverThumbCache.set(cacheKey, value);
  if (coverThumbCache.size > MAX_COVER_THUMB_CACHE) {
    const oldestKey = coverThumbCache.keys().next().value;
    coverThumbCache.delete(oldestKey);
  }
}

// Cover Flow 专用缩略图读取：内存 LRU → userData 磁盘缩略图缓存 → 原生 C++ 缩放落盘（单张 ~20KB，重开/回滑毫秒级命中）
export async function readCoverThumbnail(filePath, allowedFolders, maxSize = 384) {
  const safePath = await resolveAllowedLibraryFile(filePath, allowedFolders);
  if (!safePath) return null;

  const targetSize = Math.max(128, Math.min(768, Math.round(Number(maxSize) || 384)));
  const cacheKey = `${safePath}@${targetSize}`;

  if (coverThumbCache.has(cacheKey)) {
    const hit = coverThumbCache.get(cacheKey);
    setCoverThumbCache(cacheKey, hit);
    return hit;
  }

  if (coverThumbInflight.has(cacheKey)) {
    return coverThumbInflight.get(cacheKey);
  }

  const job = (async () => {
    try {
      let diskJpgPath = null;
      let diskNonePath = null;
      const thumbDir = await getThumbDir();
      if (thumbDir) {
        try {
          const st = await fs.stat(safePath);
          const hash = crypto
            .createHash('sha1')
            .update(`${safePath}|${st.mtimeMs}|${st.size}|${targetSize}`)
            .digest('hex');
          diskJpgPath = path.join(thumbDir, `${hash}.jpg`);
          diskNonePath = path.join(thumbDir, `${hash}.none`);

          try {
            const cachedBuf = await fs.readFile(diskJpgPath);
            if (cachedBuf.length > 0) {
              const hit = { buffer: cachedBuf, format: 'image/jpeg' };
              setCoverThumbCache(cacheKey, hit);
              return hit;
            }
          } catch (e) {}

          try {
            await fs.access(diskNonePath);
            setCoverThumbCache(cacheKey, null);
            return null;
          } catch (e) {}
        } catch (e) {}
      }

      const metadata = await parseFile(safePath, { skipCovers: false, skipPostHeaders: true });
      const pic = metadata.common.picture && metadata.common.picture[0];
      if (!pic || !pic.data) {
        setCoverThumbCache(cacheKey, null);
        if (diskNonePath) fs.writeFile(diskNonePath, '').catch(() => {});
        return null;
      }

      const rawBuf = Buffer.isBuffer(pic.data) ? pic.data : Buffer.from(pic.data);
      const img = nativeImage.createFromBuffer(rawBuf);
      if (img.isEmpty()) {
        const fallback = { buffer: rawBuf, format: pic.format || 'image/jpeg' };
        setCoverThumbCache(cacheKey, fallback);
        return fallback;
      }

      const { width, height } = img.getSize();
      let resized = img;
      if (width > targetSize || height > targetSize) {
        resized =
          width >= height
            ? img.resize({ width: targetSize, quality: 'good' })
            : img.resize({ height: targetSize, quality: 'good' });
      }

      const jpegBuf = resized.toJPEG(82);
      const result =
        jpegBuf && jpegBuf.length > 0
          ? { buffer: jpegBuf, format: 'image/jpeg' }
          : { buffer: rawBuf, format: pic.format || 'image/jpeg' };
      setCoverThumbCache(cacheKey, result);
      if (diskJpgPath && jpegBuf && jpegBuf.length > 0) {
        fs.writeFile(diskJpgPath, jpegBuf).catch(() => {});
      }
      return result;
    } catch (e) {
      return null;
    } finally {
      coverThumbInflight.delete(cacheKey);
    }
  })();

  coverThumbInflight.set(cacheKey, job);
  return job;
}

// 优先读取同目录同名 .lrc 文件，其次读取内嵌歌词
export async function readLyrics(audioPath, allowedFolders) {
  const safeAudioPath = await resolveAllowedLibraryFile(audioPath, allowedFolders);
  if (!safeAudioPath) return null;

  try {
    const ext = path.extname(safeAudioPath);
    const lrcCandidate = safeAudioPath.slice(0, safeAudioPath.length - ext.length) + '.lrc';
    const safeLrcPath = await resolveAllowedLibraryFile(lrcCandidate, allowedFolders, {
      allowLrcSibling: true,
    });
    if (safeLrcPath) {
      const stat = await fs.stat(safeLrcPath);
      if (stat.isFile() && stat.size <= MAX_LRC_BYTES) {
        return await fs.readFile(safeLrcPath, 'utf-8');
      }
    }
  } catch (e) {}

  try {
    const metadata = await parseFile(safeAudioPath, { skipCovers: true });
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
