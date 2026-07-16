/**
 * 进程存活检测 —— 一次 ps 扫描判定所有 session 的进程状态
 *
 * 性能策略：
 *   - 仅调用一次 `ps -eo args=`，不逐 session grep
 *   - 将全部 nativeSessionId 编译为单个正则，一次扫描匹配
 *   - 3 秒超时；ps 失败时返回空 Set，调用方退回 mtime-only 判定
 *
 * 匹配原理：
 *   CLI agent 启动时通常在进程参数中携带 session ID（如 `--resume=<uuid>`）。
 *   只要 nativeSessionId 作为子串出现在任意进程的 args 中，即视为进程存活。
 */

import { execSync } from 'node:child_process';

/** 检查器函数签名：接收 nativeSessionId 列表，返回存活 ID 集合 */
export type ProcessAliveChecker = (nativeSessionIds: string[]) => Set<string>;

/**
 * 检测哪些 nativeSessionId 有对应的运行中进程。
 *
 * @param nativeSessionIds 候选 session ID 列表
 * @returns 存活的 session ID 集合（ps 失败时返回空集，语义为"无法确认存活"）
 */
export function detectAliveProcesses(nativeSessionIds: string[]): Set<string> {
  // 过滤掉过短的 ID（< 8 字符），避免误匹配
  const validIds = nativeSessionIds.filter((id) => id.length >= 8);
  if (validIds.length === 0) return new Set();

  let psOutput: string;
  try {
    // 单次 ps 调用，3 秒超时，最多 4MB 输出
    psOutput = execSync('ps -eo args=', {
      encoding: 'utf-8',
      timeout: 3_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    // ps 失败（权限不足、非 POSIX 系统、超时）→ 返回空集
    return new Set();
  }

  // 编译单条正则：id1|id2|id3|...
  const escaped = validIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'g');

  const alive = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(psOutput)) !== null) {
    alive.add(match[1]!);
    regex.lastIndex = match.index + 1; // 避免重叠匹配的跳过
  }

  return alive;
}
