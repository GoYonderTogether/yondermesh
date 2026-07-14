/**
 * yondermesh 安装路径管理（LOOP-008）
 *
 * 目录结构：
 *   $YONDERMESH_HOME/ (默认 ~/.yondermesh/)
 *   ├── yondermesh.db            — SQLite 数据库
 *   ├── daemon.pid               — daemon PID 文件
 *   ├── bin/
 *   │   └── ymesh -> ../releases/<current>/ymesh.js   — 全局入口符号链接
 *   └── releases/
 *       ├── 0.1.0/               — 不可变 release 目录
 *       │   ├── dist/            — 编译产物
 *       │   ├── node_modules/    — 依赖
 *       │   ├── package.json
 *       │   └── ymesh.js         — 启动脚本
 *       └── previous             — 上一个 release 的符号链接（回退用）
 *
 * 所有路径均通过 resolveDataDir() 动态计算，支持 YONDERMESH_HOME
 * 环境变量覆盖（用于测试和自定义安装路径）。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 解析根数据目录。
 *
 * 优先级：YONDERMESH_HOME 环境变量 > ~/.yondermesh
 *
 * 每次调用都会重新读取环境变量，确保运行时切换生效。
 */
export function resolveDataDir(): string {
  return process.env.YONDERMESH_HOME ?? join(homedir(), '.yondermesh');
}

/** bin 目录（存放全局入口符号链接） */
export function resolveBinDir(): string {
  return join(resolveDataDir(), 'bin');
}

/** releases 目录 */
export function resolveReleasesDir(): string {
  return join(resolveDataDir(), 'releases');
}

/** 全局入口路径 */
export function resolveEntrySymlink(): string {
  return join(resolveBinDir(), 'ymesh');
}

/** 上一个 release 的符号链接（回退用） */
export function resolvePreviousSymlink(): string {
  return join(resolveReleasesDir(), 'previous');
}

/** 当前 release 的符号链接 */
export function resolveCurrentSymlink(): string {
  return join(resolveReleasesDir(), 'current');
}

/** SQLite 数据库路径 */
export function resolveDbPath(): string {
  return join(resolveDataDir(), 'yondermesh.db');
}

/** daemon PID 文件路径 */
export function resolvePidFile(): string {
  return join(resolveDataDir(), 'daemon.pid');
}

/** LaunchAgent plist 路径 */
export const LAUNCH_AGENT_LABEL = 'com.yondermesh.daemon';

/**
 * 获取 LaunchAgent plist 路径。
 *
 * 注意：plist 始终在 ~/Library/LaunchAgents/ 下，
 * 不受 YONDERMESH_HOME 影响（macOS 约定）。
 */
export function resolveLaunchAgentPlist(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

// ── 向后兼容的常量导出（在模块加载时计算，用于不支持运行时覆盖的场景） ──
// 新代码应优先使用 resolve*() 函数。

export const DATA_DIR = resolveDataDir();
export const BIN_DIR = resolveBinDir();
export const RELEASES_DIR = resolveReleasesDir();
export const ENTRY_SYMLINK = resolveEntrySymlink();
export const PREVIOUS_SYMLINK = resolvePreviousSymlink();
export const CURRENT_SYMLINK = resolveCurrentSymlink();
export const DB_PATH = resolveDbPath();
export const PID_FILE = resolvePidFile();
export const LAUNCH_AGENT_PLIST = resolveLaunchAgentPlist();

/**
 * 获取某个版本的 release 目录路径
 */
export function releaseDir(version: string): string {
  return join(resolveReleasesDir(), version);
}

/**
 * 获取某个 release 的 ymesh 启动脚本路径
 */
export function releaseEntry(releasePath: string): string {
  return join(releasePath, 'ymesh.js');
}
