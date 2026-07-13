/**
 * yondermesh 安装路径管理（LOOP-008）
 *
 * 目录结构：
 *   ~/.yondermesh/
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
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 根数据目录 */
export const DATA_DIR = join(homedir(), '.yondermesh');

/** bin 目录（存放全局入口符号链接） */
export const BIN_DIR = join(DATA_DIR, 'bin');

/** releases 目录 */
export const RELEASES_DIR = join(DATA_DIR, 'releases');

/** 全局入口路径 */
export const ENTRY_SYMLINK = join(BIN_DIR, 'ymesh');

/** 上一个 release 的符号链接（回退用） */
export const PREVIOUS_SYMLINK = join(RELEASES_DIR, 'previous');

/** 当前 release 的符号链接 */
export const CURRENT_SYMLINK = join(RELEASES_DIR, 'current');

/** SQLite 数据库路径 */
export const DB_PATH = join(DATA_DIR, 'yondermesh.db');

/** daemon PID 文件路径 */
export const PID_FILE = join(DATA_DIR, 'daemon.pid');

/** LaunchAgent plist 路径 */
export const LAUNCH_AGENT_LABEL = 'com.yondermesh.daemon';
export const LAUNCH_AGENT_PLIST = join(
  homedir(),
  'Library',
  'LaunchAgents',
  `${LAUNCH_AGENT_LABEL}.plist`,
);

/**
 * 获取某个版本的 release 目录路径
 */
export function releaseDir(version: string): string {
  return join(RELEASES_DIR, version);
}

/**
 * 获取某个 release 的 ymesh 启动脚本路径
 */
export function releaseEntry(releasePath: string): string {
  return join(releasePath, 'ymesh.js');
}
