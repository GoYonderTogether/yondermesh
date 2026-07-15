/**
 * macOS 菜单栏 app 管理
 *
 * 构建、安装、卸载 YondermeshMenuBar.app（Swift NSStatusItem app）。
 * 与 daemon LaunchAgent 配合使用：daemon 负责后台扫描，menubar app 负责
 * 在系统菜单栏显示状态并提供"退出 ymesh"入口。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolveDataDir } from './paths.js';

export const MENUBAR_AGENT_LABEL = 'com.yondermesh.menubar';
const APP_BUNDLE_NAME = 'YondermeshMenuBar';
const APP_NAME = 'YondermeshMenuBar.app';

/** menubar app bundle 路径（在 data dir 下） */
export function resolveMenuBarAppPath(): string {
  return path.join(resolveDataDir(), APP_NAME);
}

/** menubar 可执行文件路径 */
export function resolveMenuBarExecutable(): string {
  return path.join(resolveMenuBarAppPath(), 'Contents', 'MacOS', APP_BUNDLE_NAME);
}

/** menubar LaunchAgent plist 路径 */
export function resolveMenuBarPlist(): string {
  return path.join(homedir(), 'Library', 'LaunchAgents', `${MENUBAR_AGENT_LABEL}.plist`);
}

/**
 * 生成 menubar LaunchAgent plist
 *
 * 与 daemon 的关键区别：
 * - RunAtLoad=true（登录后自动启动）
 * - 没有 KeepAlive（用户退出后不自动重启）
 */
export function generateMenuBarPlist(): string {
  const execPath = resolveMenuBarExecutable();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MENUBAR_AGENT_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-j</string>
    <string>${execPath}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/** 生成 .app bundle 的 Info.plist */
export function generateMenuBarInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_BUNDLE_NAME}</string>

  <key>CFBundleDisplayName</key>
  <string>yondermesh</string>

  <key>CFBundleIdentifier</key>
  <string>${MENUBAR_AGENT_LABEL}</string>

  <key>CFBundleVersion</key>
  <string>1</string>

  <key>CFBundleShortVersionString</key>
  <string>1.0</string>

  <key>CFBundlePackageType</key>
  <string>APPL</string>

  <key>CFBundleExecutable</key>
  <string>${APP_BUNDLE_NAME}</string>

  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>

  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * 编译 Swift 源码并创建 .app bundle
 *
  * @param swiftSourcePath Swift 源文件路径
  */
export function buildMenuBarApp(swiftSourcePath: string): void {
  const appPath = resolveMenuBarAppPath();
  const contentsDir = path.join(appPath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const execPath = resolveMenuBarExecutable();

  // 清理旧 bundle（幂等重建）
  fs.rmSync(appPath, { recursive: true, force: true });

  // 创建目录结构
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // 编译 Swift（指定 target 版本以匹配当前 macOS，避免 LaunchServices 拒绝运行）
  const target = getSwiftTargetTriple();
  execSync(
    `swiftc ${target} -O -o "${execPath}" -framework Cocoa "${swiftSourcePath}"`,
    { stdio: 'pipe' },
  );

  // 设置可执行权限
  fs.chmodSync(execPath, 0o755);

  // 写入 Info.plist
  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), generateMenuBarInfoPlist(), 'utf-8');
}

/**
 * 安装 menubar app + LaunchAgent
 *
 * @param swiftSourcePath Swift 源文件路径
 */
export function installMenuBarApp(swiftSourcePath: string): void {
  // 构建并安装 .app bundle
  buildMenuBarApp(swiftSourcePath);

  // 安装 LaunchAgent
  const plistPath = resolveMenuBarPlist();
  const plistDir = path.dirname(plistPath);
  fs.mkdirSync(plistDir, { recursive: true });
  fs.writeFileSync(plistPath, generateMenuBarPlist(), 'utf-8');

  // 如果已加载，先 unload
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
  } catch {
    /* 未加载 */
  }

  // load
  execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
}

/** 卸载 menubar app + LaunchAgent */
export function uninstallMenuBarApp(): void {
  // 卸载 LaunchAgent
  const plistPath = resolveMenuBarPlist();
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
  } catch {
    /* 未加载 */
  }
  fs.rmSync(plistPath, { force: true });

  // 终止运行中的 menubar app
  try {
    execSync(`killall ${APP_BUNDLE_NAME} 2>/dev/null || true`, { stdio: 'pipe' });
  } catch {
    /* 未运行 */
  }

  // 移除 .app bundle
  fs.rmSync(resolveMenuBarAppPath(), { recursive: true, force: true });
}

/** 启动 menubar app */
export function startMenuBarApp(): void {
  execSync(`open -j "${resolveMenuBarAppPath()}"`, { stdio: 'pipe' });
}

/** 停止 menubar app */
export function stopMenuBarApp(): void {
  try {
    execSync(`killall ${APP_BUNDLE_NAME} 2>/dev/null || true`, { stdio: 'pipe' });
  } catch {
    /* 未运行 */
  }
}

/**
 * 获取 swiftc 编译目标三元组（匹配当前 macOS 版本）
 *
 * swiftc 默认编译目标可能是 SDK 最高版本（如 macOS 28.0），
 * 但当前系统可能还在 27.0，导致 LaunchServices 拒绝启动（error -10825）。
 * 这里动态读取系统版本，确保二进制 minOS <= 当前系统版本。
 */
function getSwiftTargetTriple(): string {
  try {
    const ver = execSync('sw_vers -productVersion', { encoding: 'utf-8' }).trim();
    const major = parseInt(ver.split('.')[0], 10);
    if (major > 0) {
      return `-target arm64-apple-macos${major}.0`;
    }
  } catch {
    /* sw_vers 不可用 */
  }
  return '';
}
