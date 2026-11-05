// 文件夹分组：纯逻辑，Windows / Unix 路径都按最后一个分隔符切分。
// 渲染进程不能直接用 node:path，主进程返回的路径字符串在这里统一处理。

export function folderPathOf(filePath) {
  if (typeof filePath !== 'string') return '';
  const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (i < 0) return '';
  if (i === 0) return filePath.slice(0, 1); // Unix 根目录
  return filePath.slice(0, i);
}

export function folderNameOf(dirPath) {
  if (!dirPath) return '';
  const trimmed = dirPath.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = i >= 0 ? trimmed.slice(i + 1) : trimmed;
  return name || trimmed || dirPath;
}

// 统一成 / 分隔、去掉末尾斜杠，便于跨平台比较
export function normalizeFolder(dirPath) {
  const value = String(dirPath || '').replace(/\\/g, '/');
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

// 按歌曲所在目录分组，返回 [{ path, name, songs }]，按文件夹名排序。
// 没有配置曲库根目录时作为降级视图使用。
export function groupSongsByFolder(songs) {
  const map = new Map();
  for (const song of Array.isArray(songs) ? songs : []) {
    const path = folderPathOf(song && song.path);
    if (!map.has(path)) map.set(path, []);
    map.get(path).push(song);
  }

  return Array.from(map, ([path, items]) => ({
    path,
    name: folderNameOf(path),
    songs: items,
  })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function compareNames(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

// 以配置的曲库根目录为树根构建文件夹树：
// 父文件夹的 songs 包含其所有子文件夹的歌曲（“根文件夹包含子文件夹”）。
export function buildFolderTree(songs, roots) {
  const list = Array.isArray(songs) ? songs : [];
  const rootList = Array.from(
    new Set((Array.isArray(roots) ? roots : []).map(normalizeFolder).filter(Boolean))
  );

  // 没有配置根目录：降级为按直接父目录分组
  if (rootList.length === 0) {
    return groupSongsByFolder(list).map((group) => ({
      path: normalizeFolder(group.path),
      name: group.name,
      directSongs: group.songs,
      songs: group.songs,
      children: [],
    }));
  }

  const nodes = new Map(); // 统一化绝对路径 -> { path, name, directSongs, children: Map, parent }

  const ensureNode = (path) => {
    const key = normalizeFolder(path);
    if (!nodes.has(key)) {
      nodes.set(key, {
        path: key,
        name: folderNameOf(key),
        directSongs: [],
        children: new Map(),
        parent: null,
      });
    }
    return nodes.get(key);
  };

  for (const root of rootList) ensureNode(root);

  for (const song of list) {
    const dir = normalizeFolder(folderPathOf(song && song.path));
    if (!dir) continue;

    // 嵌套配置时取最长的根目录
    let root = null;
    for (const candidate of rootList) {
      if (dir === candidate || dir.startsWith(candidate + '/')) {
        if (!root || candidate.length > root.length) root = candidate;
      }
    }
    if (!root) continue;

    let parent = ensureNode(root);
    if (dir !== root) {
      const segments = dir
        .slice(root.length)
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean);
      let current = root;
      for (const segment of segments) {
        current = `${current}/${segment}`;
        const node = ensureNode(current);
        if (!parent.children.has(current)) parent.children.set(current, node);
        node.parent = parent.path;
        parent = node;
      }
    }
    parent.directSongs.push(song);
  }

  const finalize = (node) => {
    node.children = Array.from(node.children.values()).sort(compareNames);
    node.songs = [...node.directSongs];
    for (const child of node.children) {
      finalize(child);
      node.songs.push(...child.songs);
    }
    return node;
  };

  return rootList
    .map((root) => finalize(nodes.get(root)))
    .filter((root) => root.songs.length > 0)
    .sort(compareNames);
}

// 某个文件夹及其所有子文件夹下的歌曲（点击文件夹时使用）
export function folderSubtreeSongsOf(songs, folderPath) {
  const root = normalizeFolder(folderPath);
  if (!root) return [];
  return (Array.isArray(songs) ? songs : []).filter((song) => {
    const dir = normalizeFolder(folderPathOf(song && song.path));
    return dir === root || dir.startsWith(root + '/');
  });
}
