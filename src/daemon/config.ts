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
  /** 每来源两次实时扫描之间的最小间隔（防持续写入的目录把事件循环占满） */
  minScanGapMs?: number;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
  /** 是否跳过 cass 全量导入（cass DB 不存在时自动跳过） */
  skipCass?: boolean;
  /** 是否跳过 Claude 实时监听 */
  skipClaude?: boolean;
  /** 是否跳过 Codex 实时监听 */
  skipCodex?: boolean;
  /** 跳过 pi 系（pi / omp / gsd-pi）采集与实时监听 */
  skipPi?: boolean;
  /**
   * 是否在 reconcile 和新 session 检测时自动挂载扩展到已安装的 CLI。
   * 默认 true。设为 false 可关闭 auto-mount 行为（仅手动 `ymesh mount all`）。
   */
  autoMount?: boolean;
  /** 是否启用 briefing 定时生成（每小时）。默认 true。 */
  briefingEnabled?: boolean;
  /** briefing 定时生成间隔（毫秒），默认 1 小时 */
  briefingIntervalMs?: number;
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
    minScanGapMs: 15_000, // 15 秒：实时监听的最小扫描间隔（防热循环饿死 reconcile）
    autoMount: true,
    briefingEnabled: true,
    briefingIntervalMs: 60 * 60 * 1000, // 1 小时
  };
}
