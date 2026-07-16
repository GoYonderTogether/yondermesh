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
  resolveLaunchAgentPlist,
  resolveEntrySymlink,
  resolveDataDir,
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
 *
 * 注意：LaunchAgent 不加载 shell rc，PATH 里没有 fnm/nvm 管理的 node。
 * 所以必须用 process.execPath（当前 node 完整路径）而非裸 "node" 命令。
 */
export function generatePlist(): string {
  const entry = resolveEntrySymlink();
  const nodeBin = process.execPath;  // 当前 node 进程的完整路径
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${entry}</string>
    <string>daemon</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${resolveDataDir()}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${resolveDataDir()}/daemon.log</string>

  <key>StandardErrorPath</key>
  <string>${resolveDataDir()}/daemon.err.log</string>

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
  const plistPath = resolveLaunchAgentPlist();
  const dir = path.dirname(plistPath);
  fs.mkdirSync(dir, { recursive: true });

  // 写入 plist
  fs.writeFileSync(plistPath, generatePlist(), 'utf-8');

  // 如果已加载，先 unload
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
  } catch {
    /* 未加载 */
  }

  // load
  execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
}

/**
 * 卸载 LaunchAgent
 */
export function uninstallService(): void {
  const plistPath = resolveLaunchAgentPlist();
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
  } catch {
    /* 未加载 */
  }
  fs.rmSync(plistPath, { force: true });
}

/**
 * 启动 service（已安装时）
 */
export function startService(): void {
  const plistPath = resolveLaunchAgentPlist();
  // 先尝试 load（如果已 loaded，launchctl load 会报错但无害）
  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
  } catch {
    /* 已 loaded */
  }
  execSync(`launchctl start ${LAUNCH_AGENT_LABEL}`, { stdio: 'pipe' });
}

/**
 * 停止 service
 */
export function stopService(): void {
  const plistPath = resolveLaunchAgentPlist();
  // unload 会停止 daemon 并阻止 KeepAlive 重启
  // plist 仍在，下次 login 或 startService 时会重新 load
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
  } catch {
    /* 未加载 */
  }
}

/**
 * 查询 service 状态
 */
export function getServiceStatus(): ServiceStatus {
  const plistPath = resolveLaunchAgentPlist();
  if (!fs.existsSync(plistPath)) {
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
