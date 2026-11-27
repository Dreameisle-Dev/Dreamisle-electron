import { ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getMainWindow } from './window.js';
import {
  isTrackUri,
  parseTrackUri,
  formatMediaUrl,
} from '../../packages/dreamisle-plugin-sdk/src/index.js';

export { isTrackUri as isPluginTrackUri, parseTrackUri as parsePluginTrackUri };

export const AUDIO_EXTENSIONS = [
  '.mp3',
  '.flac',
  '.wav',
  '.wave',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.m4b',
  '.aac',
  '.weba',
  '.mka',
];

const MAX_PATH_LENGTH = 4096;
const MAIN_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../renderer/index.html'
);

function normalizePathForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeFileUrlToPath(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return null;
    return normalizePathForCompare(fileURLToPath(parsed));
  } catch {
    return null;
  }
}

/**
 * Harden a BrowserWindow's webContents against navigation to untrusted pages,
 * popup windows, and webview attachment.
 */
export function hardenWebContents(webContents, allowedHtmlPath) {
  const expectedPath = normalizePathForCompare(allowedHtmlPath);

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  webContents.on('will-navigate', (event, navigationUrl) => {
    const targetPath = normalizeFileUrlToPath(navigationUrl);
    if (targetPath !== expectedPath) {
      event.preventDefault();
    }
  });

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

/**
 * Verify that an IPC event originated from the main window's primary frame
 * running the expected renderer document.
 */
export function isMainRendererSender(event) {
  const main = getMainWindow();
  if (!main || main.isDestroyed() || !event || event.sender !== main.webContents) {
    return false;
  }
  const expectedPath = normalizePathForCompare(MAIN_HTML_PATH);
  const frame = event.senderFrame;
  if (frame) {
    if (frame !== main.webContents.mainFrame) return false;
    if (normalizeFileUrlToPath(frame.url) !== expectedPath) return false;
  } else if (normalizeFileUrlToPath(main.webContents.getURL()) !== expectedPath) {
    return false;
  }
  return true;
}

export function handleMainIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isMainRendererSender(event)) {
      throw new Error(`Unauthorized IPC sender for ${channel}`);
    }
    return handler(event, ...args);
  });
}

export function onMainIpc(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    if (!isMainRendererSender(event)) return;
    handler(event, ...args);
  });
}

/**
 * Reject non-strings, null bytes, relative paths, and network/UNC paths.
 */
export function isSafeLocalPath(targetPath) {
  if (
    typeof targetPath !== 'string' ||
    targetPath.length === 0 ||
    targetPath.length > MAX_PATH_LENGTH
  ) {
    return false;
  }
  if (targetPath.includes('\0')) return false;
  // Reject UNC / network shares (\\server\share, //server/share, \\?\UNC\...)
  if (
    targetPath.startsWith('\\\\') ||
    targetPath.startsWith('//') ||
    /^\\\\\?\\unc\\/i.test(targetPath)
  ) {
    return false;
  }
  return path.isAbsolute(targetPath);
}

function isWithinBaseDir(baseDir, candidate) {
  const baseNorm = normalizePathForCompare(baseDir);
  const targetNorm = normalizePathForCompare(candidate);
  const rel = path.relative(baseNorm, targetNorm);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isAllowedAudioPathSync(targetPath, musicFolders) {
  if (!isSafeLocalPath(targetPath)) return false;
  const ext = path.extname(targetPath).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) return false;
  if (!Array.isArray(musicFolders)) return false;

  return musicFolders.some(
    (folder) => isSafeLocalPath(folder) && isWithinBaseDir(folder, targetPath)
  );
}

/**
 * Check whether a song identifier is either an allowed local audio file or a valid `dream-track://` URI.
 */
export function isAllowedSongIdSync(songId, musicFolders) {
  if (isTrackUri(songId)) return parseTrackUri(songId) !== null;
  return isAllowedAudioPathSync(songId, musicFolders);
}

export function sanitizeSongUrl(songId) {
  const parsed = parseTrackUri(songId);
  if (parsed) return formatMediaUrl(parsed.pluginId, parsed.trackId);
  return sanitizeAudioUrl(songId);
}

/**
 * Verify targetPath is an audio file within configured musicFolders and resolve
 * symlinks so a link inside a music folder cannot read outside files.
 */
export async function resolveAllowedLibraryFile(
  targetPath,
  musicFolders,
  { allowLrcSibling = false } = {}
) {
  if (!isSafeLocalPath(targetPath)) return null;
  const ext = path.extname(targetPath).toLowerCase();
  const validExt = allowLrcSibling
    ? ext === '.lrc' || AUDIO_EXTENSIONS.includes(ext)
    : AUDIO_EXTENSIONS.includes(ext);
  if (!validExt || !Array.isArray(musicFolders)) return null;

  const matchingFolders = musicFolders.filter(
    (folder) => isSafeLocalPath(folder) && isWithinBaseDir(folder, targetPath)
  );
  if (matchingFolders.length === 0) return null;

  let realTarget;
  try {
    realTarget = await fs.realpath(targetPath);
  } catch {
    return null;
  }

  for (const folder of matchingFolders) {
    try {
      const realFolder = await fs.realpath(folder);
      if (isWithinBaseDir(realFolder, realTarget)) {
        return realTarget;
      }
    } catch {
      // Skip inaccessible folder
    }
  }
  return null;
}

export function sanitizeAudioUrl(audioPath) {
  if (!isSafeLocalPath(audioPath)) return '';
  return pathToFileURL(path.resolve(audioPath)).href;
}
