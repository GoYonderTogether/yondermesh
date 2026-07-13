/**
 * macOS LaunchAgent 管理（LOOP-008）
 *
 * 生成、安装、卸载 ~/Library/LaunchAgents/com.yondermesh.daemon.plist
 * 支持 start / stop / status / isLoaded / isRunning
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  LAUNCH_AGENT_LABEL,
  LAUNCH_AGENT_PLIST,
  ENTRY_SYMLINK,
  DATA_DIR,
} from './paths.js';

/** LaunchAgent 状态 */
export interface ServiceStatus {
  loaded: boolean;
  running: boolean;
  pid: number | null;
  exitStatus: number | null;
}

/**
 * 生成 LaunchAgent plist 内容
 */
export function generatePlist(): string {
  const entry = ENTRY_SYMLINK;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>${entry}</string>
    <string>daemon</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${DATA_DIR}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${DATA_DIR}/daemon.log</string>

  <key>StandardErrorPath</key>
  <string>${DATA_DIR}/daemon.err.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/**
 * 安装 LaunchAgent（生成 plist 并 load）
 *
 * 如果已加载，先 unload 再重新 load。
 */
export function installService(): void {
  // 确保 plist 目录存在
  const dir = path.dirname(LAUNCH_AGENT_PLIST);
  fs.mkdirSync(dir, { recursive: true });

  // 写入 plist
  fs.writeFileSync(LAUNCH_AGENT_PLIST, generatePlist(), 'utf-8');

  // 如果已加载，先 unload
  try {
    execSync(`launchctl unload "${LAUNCH_AGENT_PLIST}"`, { stdio: 'pipe' });
  } catch {
    /* 未加载 */
  }

  // load
  execSync(`launchctl load "${LAUNCH_AGENT_PLIST}"`, { stdio: 'pipe' });
}

/**
 * 卸载 LaunchAgent
 */
export function uninstallService(): void {
  try {
    execSync(`launchctl unload "${LAUNCH_AGENT_PLIST}"`, { stdio: 'pipe' });
  } catch {
    /* 未加载 */
  }
  fs.rmSync(LAUNCH_AGENT_PLIST, { force: true });
}

/**
 * 启动 service（已安装时）
 */
export function startService(): void {
  execSync(`launchctl start ${LAUNCH_AGENT_LABEL}`, { stdio: 'pipe' });
}

/**
 * 停止 service
 */
export function stopService(): void {
  execSync(`launchctl stop ${LAUNCH_AGENT_LABEL}`, { stdio: 'pipe' });
}

/**
 * 查询 service 状态
 */
export function getServiceStatus(): ServiceStatus {
  if (!fs.existsSync(LAUNCH_AGENT_PLIST)) {
    return { loaded: false, running: false, pid: null, exitStatus: null };
  }

  let loaded = false;
  let running = false;
  let pid: number | null = null;
  let exitStatus: number | null = null;

  try {
    const list = execSync(`launchctl list ${LAUNCH_AGENT_LABEL} 2>&1`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    loaded = !list.includes('Could not find');

    const pidMatch = list.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) {
      pid = parseInt(pidMatch[1], 10);
      running = true;
    }

    const exitMatch = list.match(/"LastExitStatus"\s*=\s*(\d+)/);
    if (exitMatch) {
      exitStatus = parseInt(exitMatch[1], 10);
    }
  } catch {
    /* launchctl list 失败表示未加载 */
  }

  return { loaded, running, pid, exitStatus };
}
