// 任务栏歌词的最小诊断日志。
// 打包后的应用看不到主进程 console；Win10 上“开了没反应”时，日志是唯一线索。
// 只记录嵌入/布局状态，不记录歌曲路径等用户内容。
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 256 * 1024;
let logPath;

function getLogPath() {
  if (logPath !== undefined) return logPath;
  try {
    logPath = path.join(app.getPath('userData'), 'taskbar-lyrics.log');
  } catch {
    logPath = null;
  }
  return logPath;
}

function stringify(details) {
  try {
    return JSON.stringify(details, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
  } catch {
    return '"[unserializable]"';
  }
}

export function logTaskbar(message, details = null) {
  const line = `${new Date().toISOString()} ${message}${details ? ` ${stringify(details)}` : ''}`;
  try {
    console.log(`[taskbar-lyrics] ${line}`);
  } catch {
    // console 不可用时继续写文件
  }

  const file = getLogPath();
  if (!file) return;
  try {
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.writeFileSync(file, '');
    } catch {
      // 文件尚不存在
    }
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // 日志失败不能影响功能
  }
}
