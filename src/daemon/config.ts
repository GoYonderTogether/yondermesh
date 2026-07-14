/**
 * yondermesh daemon 配置（LOOP-006）
 *
 * v0.1 极简：只管本机 session 采集 + 实时监听。
 * sync / mcp / briefing 留到后续 Loop，此处不展开。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** daemon 配置 */
export interface DaemonConfig {
  /** 数据目录（DB、PID 文件等） */
  dataDir: string;
  /** SQLite 数据库文件路径 */
  dbPath: string;
  /** PID 文件路径（单实例锁） */
  pidFile: string;
  /** 定时 reconcile 间隔（毫秒），默认 1 分钟 */
  reconcileIntervalMs: number;
  /** watch debounce 延迟（毫秒），默认 1 秒 */
  debounceMs: number;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
  /** 是否跳过 cass 全量导入（cass DB 不存在时自动跳过） */
  skipCass?: boolean;
  /** 是否跳过 Claude 实时监听 */
  skipClaude?: boolean;
  /** 是否跳过 Codex 实时监听 */
  skipCodex?: boolean;
}

/** 默认数据目录（支持 YONDERMESH_HOME 环境变量覆盖） */
export function defaultDataDir(): string {
  return process.env.YONDERMESH_HOME ?? join(homedir(), '.yondermesh');
}

/** 默认配置 */
export function defaultDaemonConfig(): DaemonConfig {
  const dataDir = defaultDataDir();
  return {
    dataDir,
    dbPath: join(dataDir, 'yondermesh.db'),
    pidFile: join(dataDir, 'daemon.pid'),
    reconcileIntervalMs: 60 * 1000, // 1 分钟
    debounceMs: 1_000, // 1 秒
  };
}
