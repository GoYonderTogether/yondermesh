/**
 * 增量扫描索引 —— 读文件**之前**先判断"这个文件变了吗"。
 *
 * 为什么这是完整扫描最大的优化点（实测）：
 *   claude 111 个文件：stat 全部 **1ms**，读全文 **1809ms**，整轮扫描 **4158ms**。
 *   内容没变时，40%+ 的时间花在**把没变的文件读进来再算哈希**上。
 *
 * 做法：用 `scanned_files` 表按 (path → mtime, size) 记住上次扫到的状态。
 * 只有 mtime 或 size 变了才需要重新读+解析，否则直接计入 unchanged。
 *
 * 为什么用路径而不是 native_session_id 当键：
 *   native_session_id 藏在文件**里面**，必须先读文件才知道 —— 那就失去意义了。
 */

import * as fs from 'node:fs';
import type { SessionStore } from './index.js';

export interface FileState {
  mtime: number;
  size: number;
}

export class IncrementalIndex {
  private known: Map<string, FileState> | null = null;
  private readonly pending: Array<{ path: string; mtime: number; size: number }> = [];
  private readonly primedPaths: string[];

  /**
   * @param store    SessionStore
   * @param paths    本轮将扫描的文件（用于一次性预取状态，避免 N 次查询）
   * @param force    true = 忽略索引，全部重扫（`ymesh scan --force`）
   */
  constructor(
    private readonly store: SessionStore,
    paths: string[],
    private readonly force = false,
  ) {
    this.primedPaths = paths;
  }

  /** 预取（懒执行，第一次用时才查库） */
  private ensurePrimed(): Map<string, FileState> {
    if (this.known === null) {
      this.known = this.force ? new Map() : this.store.getScannedFileStates(this.primedPaths);
    }
    return this.known;
  }

  /**
   * 这个文件自上次扫描以来变了吗？
   * 没有记录（新文件）→ true（必须读）。
   */
  hasChanged(absPath: string, stat: { mtimeMs: number; size: number }): boolean {
    if (this.force) return true;
    const prev = this.ensurePrimed().get(absPath);
    if (!prev) return true;
    return Math.floor(stat.mtimeMs) !== prev.mtime || stat.size !== prev.size;
  }

  /** stat 一个文件；读不到（已删除/无权限）返回 null。 */
  static statFile(absPath: string): { mtimeMs: number; size: number } | null {
    try {
      const st = fs.statSync(absPath);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  /** 记录这个文件已扫到当前状态（延迟到 flush 一次性写）。 */
  mark(absPath: string, stat: { mtimeMs: number; size: number }): void {
    this.pending.push({ path: absPath, mtime: Math.floor(stat.mtimeMs), size: stat.size });
  }

  /** 批量落库（一轮扫描结束时调一次）。 */
  flush(): void {
    if (this.pending.length > 0) this.store.markFilesScanned(this.pending);
    this.pending.length = 0;
  }

  /** 已跳过的文件数（供调用方汇报） */
  static readonly SKIP_REASON = 'mtime+size 未变';
}
