// 配置文件兜底。
//
// store 是在 store.js 的模块顶层构造的，而 conf 在 config.json 不是合法 JSON 时会直接
// 抛 SyntaxError —— 这个异常从 import 阶段逃出去，主进程在 app ready 之前就整个死掉：
// 没有窗口、没有提示、没有办法自救。而那个坏文件里往往还留着可以手工抢救的歌单和播放统计。
//
// 所以坏文件不能只是「跳过」，得先备份再继续启动：conf 的 clearInvalidConfig 只是在
// 读取时返回空对象，磁盘上的坏内容会一直保留到第一次写入才被覆盖 —— 不备份就等于把
// 用户数据丢掉。
import fs from 'fs';

// 判断异常是否真的是「配置文件坏了」。JSON.parse 失败只会是 SyntaxError；
// 权限、目录不可写之类的错误跟文件内容无关，那种情况下把用户的有效配置改名备份
// 才是真的在毁数据，所以要原样抛给调用方。
function isCorruptConfigError(error) {
  return error?.name === 'SyntaxError';
}

// 把坏文件改名成 config.json.corrupt-<时间戳>。备份失败（文件被占用、权限不足）
// 不能挡启动，此时返回 null —— 后续靠 clearInvalidConfig 兜住。
export function backupCorruptConfig(configPath, { rename = fs.renameSync, now = Date.now } = {}) {
  const backupPath = `${configPath}.corrupt-${now()}`;
  try {
    rename(configPath, backupPath);
    return backupPath;
  } catch (e) {
    return null;
  }
}

// 构造配置：成功就正常返回；只有配置文件损坏时才走备份 + 重建。
// 重试一律带上 clearInvalidConfig：备份成功时原文件已经不在、这个选项不起作用，
// 备份失败时则要靠它让 conf 自己吞掉那个 SyntaxError，否则启动照旧失败。
export function openStoreWithRecovery({
  configPath,
  createStore,
  rename = fs.renameSync,
  now = Date.now,
}) {
  try {
    return { store: createStore(), recovered: false, backupPath: null, error: null };
  } catch (error) {
    if (!isCorruptConfigError(error)) throw error;

    const backupPath = backupCorruptConfig(configPath, { rename, now });
    const store = createStore({ clearInvalidConfig: true });
    return { store, recovered: true, backupPath, error };
  }
}
