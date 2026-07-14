/**
 * yondermesh 安装模块入口（LOOP-008）
 */

export {
  buildRelease,
  installRelease,
  rollbackRelease,
  listReleases,
  getCurrentRelease,
} from './release.js';
export type { ReleaseResult } from './release.js';

export {
  generatePlist,
  installService,
  uninstallService,
  startService,
  stopService,
  getServiceStatus,
} from './launcher.js';
export type { ServiceStatus } from './launcher.js';

export {
  DATA_DIR,
  BIN_DIR,
  RELEASES_DIR,
  ENTRY_SYMLINK,
  CURRENT_SYMLINK,
  PREVIOUS_SYMLINK,
  DB_PATH,
  PID_FILE,
  LAUNCH_AGENT_LABEL,
  LAUNCH_AGENT_PLIST,
  releaseDir,
  releaseEntry,
  resolveDataDir,
  resolveBinDir,
  resolveReleasesDir,
  resolveEntrySymlink,
  resolvePreviousSymlink,
  resolveCurrentSymlink,
  resolveDbPath,
  resolvePidFile,
  resolveLaunchAgentPlist,
} from './paths.js';

// 更新与回退（LOOP-009）
export { updateFromGit } from './updater.js';
export type { UpdateResult, HealthCheck } from './updater.js';

// Git 版本计算
export { resolveVersion, describeVersion, gitShortHash, gitBranch } from './version.js';
