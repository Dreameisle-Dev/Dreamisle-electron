// 插件本地安装、扫描与卸载：支持本地文件夹与 .zip 压缩包（拒绝远程安装），
// 校验 manifest.json、防符号链接越界，并自动识别 GitHub Release 风格的顶层单目录压缩包。
import { app } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isValidPluginId,
  validateManifest,
} from '../../../packages/dreamisle-plugin-sdk/src/index.js';
import { extractZipArchive } from './zip-extract.js';
import { deletePluginData } from './storage.js';

export function getPluginsRootDir() {
  return path.join(app.getPath('userData'), 'plugins');
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isInsideDir(baseDir, candidate) {
  const base = path.resolve(baseDir);
  const target = path.resolve(candidate);
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function readValidatedPluginDir(pluginDir) {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`无法读取或解析 manifest.json: ${err.message}`], manifest: null };
  }

  const check = validateManifest(raw);
  if (!check.valid || !check.value) {
    return { ok: false, errors: check.errors, manifest: null };
  }

  const entryPath = path.resolve(pluginDir, check.value.entry);
  if (!isInsideDir(pluginDir, entryPath)) {
    return { ok: false, errors: ['entry 超出插件目录边界'], manifest: null };
  }

  try {
    const realRoot = await fs.realpath(pluginDir);
    const realEntry = await fs.realpath(entryPath);
    if (!isInsideDir(realRoot, realEntry)) {
      return { ok: false, errors: ['entry 符号链接指向插件目录外部'], manifest: null };
    }
    const st = await fs.stat(realEntry);
    if (!st.isFile()) {
      return { ok: false, errors: ['entry 不是有效文件'], manifest: null };
    }
    return { ok: true, errors: [], manifest: check.value, entryPath: realEntry };
  } catch {
    return {
      ok: false,
      errors: [`入口文件不存在: ${check.value.entry}`],
      manifest: null,
    };
  }
}

export async function scanInstalledPlugins() {
  const root = getPluginsRootDir();
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    const parsed = await readValidatedPluginDir(dir);
    if (parsed.ok) {
      results.push({
        id: parsed.manifest.id,
        dir,
        entryPath: parsed.entryPath,
        manifest: parsed.manifest,
        invalid: false,
        errors: [],
      });
    } else {
      results.push({
        id: entry.name,
        dir,
        entryPath: null,
        manifest: null,
        invalid: true,
        errors: parsed.errors,
      });
    }
  }

  results.sort((a, b) => (a.manifest?.name || a.id).localeCompare(b.manifest?.name || b.id));
  return results;
}

async function copyDirSafe(srcDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.DS_Store') continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isSymbolicLink()) continue; // 拒绝复制符号链接，防止越界读取宿主机文件
    if (entry.isDirectory()) {
      await copyDirSafe(src, dest);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dest);
    }
  }
}

export async function installPluginFromFolder(sourceDir) {
  const parsed = await readValidatedPluginDir(sourceDir);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('；'));
  }

  const pluginId = parsed.manifest.id;
  const root = getPluginsRootDir();
  await fs.mkdir(root, { recursive: true });

  const finalDir = path.join(root, pluginId);
  const stagingDir = path.join(root, `.staging-${pluginId}-${Date.now()}`);

  try {
    await copyDirSafe(sourceDir, stagingDir);
    if (await pathExists(finalDir)) {
      await fs.rm(finalDir, { recursive: true, force: true });
    }
    await fs.rename(stagingDir, finalDir);
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const verified = await readValidatedPluginDir(finalDir);
  if (!verified.ok) {
    await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(verified.errors.join('；'));
  }

  return {
    id: verified.manifest.id,
    dir: finalDir,
    entryPath: verified.entryPath,
    manifest: verified.manifest,
  };
}

export async function installPluginFromZip(zipFilePath) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dreamisle-plugin-zip-'));
  try {
    await extractZipArchive(zipFilePath, tempRoot);

    // 兼容两种常见压缩结构：根目录直接有 manifest.json，或仅包裹了一层子目录
    let candidateDir = tempRoot;
    if (!(await pathExists(path.join(tempRoot, 'manifest.json')))) {
      const entries = (await fs.readdir(tempRoot, { withFileTypes: true })).filter(
        (e) => !e.name.startsWith('.') && e.name !== '__MACOSX'
      );
      if (entries.length === 1 && entries[0].isDirectory()) {
        candidateDir = path.join(tempRoot, entries[0].name);
      }
    }

    return await installPluginFromFolder(candidateDir);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function uninstallPluginFiles(pluginId, { clearData = true } = {}) {
  if (!isValidPluginId(pluginId)) return;
  const targetDir = path.join(getPluginsRootDir(), pluginId);
  await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
  if (clearData) {
    await deletePluginData(pluginId);
  }
}
