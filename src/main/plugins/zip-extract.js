// 零依赖纯 Node.js ZIP 解压器：基于内置 node:zlib，跨平台（Win/macOS/Linux）、
// 零子进程命令注入风险，并严格防 Zip-Slip 路径穿越与解压炸弹。
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB

function findEndOfCentralDirectory(buf) {
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) return i;
    }
  }
  return -1;
}

function resolveSafeTarget(destRoot, rawEntryName) {
  const normalized = rawEntryName.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    throw new Error(`Unsafe zip entry path: ${rawEntryName}`);
  }
  const destAbs = path.resolve(destRoot);
  const fullAbs = path.resolve(destAbs, normalized);
  const rel = path.relative(destAbs, fullAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Zip-Slip path traversal blocked: ${rawEntryName}`);
  }
  return { fullAbs, isDir: normalized.endsWith('/') };
}

export async function extractZipArchive(zipFilePath, destDir) {
  const buf = await fs.readFile(zipFilePath);
  const eocdOffset = findEndOfCentralDirectory(buf);
  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP archive: End of Central Directory not found');
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (entryCount > MAX_FILES) {
    throw new Error(`ZIP archive contains too many entries (max ${MAX_FILES})`);
  }

  await fs.mkdir(destDir, { recursive: true });

  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CD_SIG) {
      throw new Error('Corrupt ZIP Central Directory header');
    }

    const compression = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    const entryName = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_BYTES) {
      throw new Error('ZIP archive exceeds maximum allowed uncompressed size (50MB)');
    }

    const { fullAbs, isDir } = resolveSafeTarget(destDir, entryName);
    if (isDir) {
      await fs.mkdir(fullAbs, { recursive: true });
      continue;
    }

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== LOCAL_SIG) {
      throw new Error(`Corrupt local file header for ${entryName}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`Truncated ZIP data for ${entryName}`);
    }

    const compressed = buf.subarray(dataStart, dataEnd);
    let content;
    if (compression === 0) {
      content = compressed;
    } else if (compression === 8) {
      content = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_TOTAL_BYTES });
    } else {
      throw new Error(`Unsupported ZIP compression method ${compression} for ${entryName}`);
    }

    await fs.mkdir(path.dirname(fullAbs), { recursive: true });
    await fs.writeFile(fullAbs, content);
  }
}
