import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { app, nativeImage, protocol } from 'electron';
import { parseFile } from 'music-metadata';
import fs from 'fs/promises';
import { AUDIO_EXTENSIONS, resolveAllowedLibraryFile } from './security.js';
import { decodeLyricsBuffer, repairMojibakeText } from '../shared/lyrics-decode.js';

const MAX_LRC_BYTES = 2 * 1024 * 1024;
// 只存 58 字节的稳定协议 URL 字符串（dream-thumb://cover/<sha1>.jpg），800 条总计仅约 48KB 内存，零 Buffer 常驻
const MAX_COVER_THUMB_CACHE = 800;
// 主界面黑胶封面最大边长（即使 2x 高分屏圆标也清晰锐利，同时比原图 3000px PNG 解码快 15 倍以上）
const MAIN_COVER_MAX_SIZE = 768;
// 磁盘缩略图目录上限：超过高水位时按 mtime 淘汰最旧文件，避免改名/删歌后长期堆积孤儿文件
const MAX_DISK_THUMB_FILES = 1500;
const DISK_THUMB_KEEP_FILES = 1000;
const DISK_THUMB_TOUCH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_THUMB_FILE_RE = /^[0-9a-f]{40}\.jpg$/;
const VALID_THUMB_DISK_RE = /^[0-9a-f]{40}\.(jpg|none)$/;

// 主进程封面缩略图 URL 映射缓存（含无封面的负缓存 null）
const coverThumbCache = new Map();
const coverThumbInflight = new Map();
let thumbDirPromise = null;
let diskThumbWriteCount = 0;
let diskThumbPruneInFlight = false;

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

// 后台按修改时间淘汰超限磁盘缩略图；只在写入累积一定次数后触发，不阻塞正常读图
function scheduleDiskThumbPrune(force = false) {
  if (diskThumbPruneInFlight) return;
  if (!force && ++diskThumbWriteCount < 40) return;
  diskThumbWriteCount = 0;
  diskThumbPruneInFlight = true;

  (async () => {
    try {
      const thumbDir = await getThumbDir();
      if (!thumbDir) return;
      const entries = (await fs.readdir(thumbDir)).filter((name) => VALID_THUMB_DISK_RE.test(name));
      if (entries.length <= MAX_DISK_THUMB_FILES) return;

      const withMtime = [];
      for (const name of entries) {
        try {
          const full = path.join(thumbDir, name);
          const st = await fs.stat(full);
          withMtime.push({ full, mtimeMs: st.mtimeMs });
        } catch (e) {}
      }
      if (withMtime.length <= MAX_DISK_THUMB_FILES) return;

      withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const deleteCount = Math.max(0, withMtime.length - DISK_THUMB_KEEP_FILES);
      for (let i = 0; i < deleteCount; i++) {
        await fs.unlink(withMtime[i].full).catch(() => {});
      }
    } catch (e) {
    } finally {
      diskThumbPruneInFlight = false;
    }
  })();
}

function touchDiskThumbIfOld(filePath) {
  fs.stat(filePath)
    .then((st) => {
      if (Date.now() - st.mtimeMs > DISK_THUMB_TOUCH_AGE_MS) {
        const now = new Date();
        return fs.utimes(filePath, now, now);
      }
    })
    .catch(() => {});
}

// 注册只读缩略图协议：严格限定 userData/cover-thumbs/ 下的 40 位 hex.jpg，零路径穿越、零二进制 IPC 拷贝
export function registerCoverThumbProtocol() {
  // 启动后延迟做一次磁盘缩略图上限巡检，不阻塞冷启动也不阻止进程退出
  setTimeout(() => scheduleDiskThumbPrune(true), 15000).unref();

  protocol.handle('dream-thumb', async (request) => {
    try {
      const parsed = new URL(request.url);
      if (parsed.hostname !== 'cover') return new Response(null, { status: 400 });
      const fileName = parsed.pathname.replace(/^\/+/, '');
      if (!VALID_THUMB_FILE_RE.test(fileName)) return new Response(null, { status: 400 });
      const thumbDir = await getThumbDir();
      if (!thumbDir) return new Response(null, { status: 404 });
      const data = await fs.readFile(path.join(thumbDir, fileName));
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
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

// 主播放界面封面读取：复用磁盘 + 内存缓存与 dream-thumb:// 稳定协议 URL（768px 高清 JPEG），
// 避免每次切歌重扫大音频文件、跨 IPC 拷贝数 MB 原始图以及重复创建/销毁 Blob URL。
export async function readCover(filePath, allowedFolders) {
  return readCoverThumbnail(filePath, allowedFolders, MAIN_COVER_MAX_SIZE);
}

function setCoverThumbCache(cacheKey, value) {
  coverThumbCache.delete(cacheKey);
  coverThumbCache.set(cacheKey, value);
  if (coverThumbCache.size > MAX_COVER_THUMB_CACHE) {
    const oldestKey = coverThumbCache.keys().next().value;
    coverThumbCache.delete(oldestKey);
  }
}

// 统一封面缩略图/主封面读取：返回稳定协议 URL（dream-thumb://cover/<sha1>.jpg），零 Buffer 驻留、零 Blob 泄漏
export async function readCoverThumbnail(filePath, allowedFolders, maxSize = 320) {
  const safePath = await resolveAllowedLibraryFile(filePath, allowedFolders);
  if (!safePath) return null;

  const targetSize = Math.max(128, Math.min(1024, Math.round(Number(maxSize) || 320)));
  const jpegQuality = targetSize >= 512 ? 88 : 82;
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
      let thumbUrl = null;
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
          thumbUrl = `dream-thumb://cover/${hash}.jpg`;

          try {
            await fs.access(diskJpgPath);
            touchDiskThumbIfOld(diskJpgPath);
            setCoverThumbCache(cacheKey, thumbUrl);
            return thumbUrl;
          } catch (e) {}

          try {
            await fs.access(diskNonePath);
            touchDiskThumbIfOld(diskNonePath);
            setCoverThumbCache(cacheKey, null);
            return null;
          } catch (e) {}
        } catch (e) {}
      }

      const metadata = await parseFile(safePath, { skipCovers: false, skipPostHeaders: true });
      const pic = metadata.common.picture && metadata.common.picture[0];
      if (!pic || !pic.data) {
        setCoverThumbCache(cacheKey, null);
        if (diskNonePath) {
          fs.writeFile(diskNonePath, '')
            .then(() => scheduleDiskThumbPrune())
            .catch(() => {});
        }
        return null;
      }

      const rawBuf = Buffer.isBuffer(pic.data) ? pic.data : Buffer.from(pic.data);
      const img = nativeImage.createFromBuffer(rawBuf);
      if (img.isEmpty()) return null;

      const { width, height } = img.getSize();
      let resized = img;
      if (width > targetSize || height > targetSize) {
        resized =
          width >= height
            ? img.resize({ width: targetSize, quality: 'good' })
            : img.resize({ height: targetSize, quality: 'good' });
      }

      const jpegBuf = resized.toJPEG(jpegQuality);
      if (!jpegBuf || jpegBuf.length === 0) return null;

      if (diskJpgPath && thumbUrl) {
        await fs.writeFile(diskJpgPath, jpegBuf);
        scheduleDiskThumbPrune();
        setCoverThumbCache(cacheKey, thumbUrl);
        return thumbUrl;
      }

      return { buffer: jpegBuf, format: 'image/jpeg' };
    } catch (e) {
      return null;
    } finally {
      coverThumbInflight.delete(cacheKey);
    }
  })();

  coverThumbInflight.set(cacheKey, job);
  return job;
}

function normalizeEmbeddedLyrics(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return repairMojibakeText(raw);
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return decodeLyricsBuffer(raw);
  if (typeof raw === 'object') {
    if (raw.type === 'Buffer' && Array.isArray(raw.data)) {
      return decodeLyricsBuffer(raw.data);
    }
    const copy = { ...raw };
    if (typeof copy.text === 'string') {
      copy.text = repairMojibakeText(copy.text);
    }
    if (Array.isArray(copy.syncText) && copy.syncText.length > 0) {
      copy.syncText = copy.syncText.map((item) =>
        item && typeof item.text === 'string'
          ? { ...item, text: repairMojibakeText(item.text) }
          : item
      );
    }
    return copy;
  }
  return raw;
}

// 优先读取同目录同名 .lrc 文件（自动识别 UTF-8/UTF-16/GBK/GB18030/Big5/Shift_JIS/EUC-KR/Win1252），其次读取内嵌歌词
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
        const rawBytes = await fs.readFile(safeLrcPath);
        return decodeLyricsBuffer(rawBytes);
      }
    }
  } catch (e) {}

  try {
    const metadata = await parseFile(safeAudioPath, { skipCovers: true });
    if (metadata.common && metadata.common.lyrics && metadata.common.lyrics.length > 0) {
      return normalizeEmbeddedLyrics(metadata.common.lyrics[0]);
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
