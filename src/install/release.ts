/**
 * 本地 release 构建（LOOP-008）
 *
 * 将当前源码编译到 ~/.yondermesh/releases/<version>/ 下，
 * 生成一个可直接运行的 ymesh.js 启动脚本。
 *
 * release 目录是不可变的：每次构建一个新版本，不覆盖旧版本。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  RELEASES_DIR,
  releaseDir,
  releaseEntry,
  ENTRY_SYMLINK,
  BIN_DIR,
  CURRENT_SYMLINK,
  PREVIOUS_SYMLINK,
} from './paths.js';

/** release 构建结果 */
export interface ReleaseResult {
  version: string;
  releasePath: string;
  entryPath: string;
  builtAt: number;
}

/** 读取 package.json 版本号 */
function readVersion(projectRoot: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
  return pkg.version as string;
}

/**
 * 构建一个本地 release
 *
 * @param projectRoot 项目根目录（含 src/、package.json）
 * @param force 是否覆盖已存在的同名 release
 */
export function buildRelease(projectRoot: string, force = false): ReleaseResult {
  const version = readVersion(projectRoot);
  const target = releaseDir(version);

  if (fs.existsSync(target) && !force) {
    throw new Error(
      `release ${version} 已存在于 ${target}。使用 force=true 覆盖。`,
    );
  }

  // 清理目标目录
  // 清理目标目录（可能因上次失败残留）
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // ENOTEMPTY 偶发：重试一次
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* 仍然失败则忽略，mkdirSync 会处理 */
    }
  }
  fs.mkdirSync(target, { recursive: true });

  // 1. 编译 TypeScript
  execSync('npm run build', { cwd: projectRoot, stdio: 'pipe' });

  // 2. 复制 dist 到 release 目录
  const distSrc = path.join(projectRoot, 'dist');
  const distDst = path.join(target, 'dist');
  copyDir(distSrc, distDst);

  // 3. 复制 package.json（只保留必要的 dependencies）
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
  const releasePkg = {
    name: pkg.name,
    version: pkg.version,
    type: 'module',
    dependencies: pkg.dependencies ?? {},
  };
  fs.writeFileSync(
    path.join(target, 'package.json'),
    JSON.stringify(releasePkg, null, 2),
  );

  // 4. 生成 ymesh.js 启动脚本
  const entryPath = releaseEntry(target);
  const entryContent = `#!/usr/bin/env node
// yondermesh ${version} — 自动生成的启动脚本
import('./dist/bin/ymesh.js');
`;
  fs.writeFileSync(entryPath, entryContent, 'utf-8');
  fs.chmodSync(entryPath, 0o755);

  return {
    version,
    releasePath: target,
    entryPath,
    builtAt: Date.now(),
  };
}

/**
 * 安装 release：创建 bin 目录、设置符号链接
 *
 * 如果已有 current，先将 current 保存为 previous。
 */
export function installRelease(release: ReleaseResult): void {
  // 确保 bin 目录存在
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(RELEASES_DIR, { recursive: true });

  // 如果已有 current 符号链接，先保存为 previous
  if (fs.existsSync(CURRENT_SYMLINK) || fs.existsSync(PREVIOUS_SYMLINK)) {
    try {
      const currentTarget = fs.readlinkSync(CURRENT_SYMLINK);
      // 更新 previous 指向旧 current
      removeSymlink(PREVIOUS_SYMLINK);
      fs.symlinkSync(currentTarget, PREVIOUS_SYMLINK, 'dir');
    } catch {
      /* current 不是符号链接或不存在 */
    }
  }

  // 更新 current 指向新 release
  removeSymlink(CURRENT_SYMLINK);
  fs.symlinkSync(release.releasePath, CURRENT_SYMLINK, 'dir');

  // 更新入口符号链接
  removeSymlink(ENTRY_SYMLINK);
  fs.symlinkSync(release.entryPath, ENTRY_SYMLINK, 'file');
}

/**
 * 回退到 previous release
 *
 * @returns 回退后的 release 路径，或 null 如果没有 previous
 */
export function rollbackRelease(): string | null {
  if (!fs.existsSync(PREVIOUS_SYMLINK)) {
    return null;
  }

  try {
    const previousTarget = fs.readlinkSync(PREVIOUS_SYMLINK);

    // current → previous
    removeSymlink(CURRENT_SYMLINK);
    fs.symlinkSync(previousTarget, CURRENT_SYMLINK, 'dir');

    // 入口符号链接
    const entry = releaseEntry(previousTarget);
    if (fs.existsSync(entry)) {
      removeSymlink(ENTRY_SYMLINK);
      fs.symlinkSync(entry, ENTRY_SYMLINK, 'file');
    }

    // 清理 previous
    removeSymlink(PREVIOUS_SYMLINK);

    return previousTarget;
  } catch {
    return null;
  }
}

/**
 * 列出所有已安装的 release 版本
 */
export function listReleases(): string[] {
  if (!fs.existsSync(RELEASES_DIR)) return [];
  return fs
    .readdirSync(RELEASES_DIR)
    .filter((name) => name !== 'current' && name !== 'previous')
    .filter((name) => {
      try {
        return fs.statSync(path.join(RELEASES_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse(); // 新版本在前
}

/**
 * 获取当前 release 版本
 */
export function getCurrentRelease(): string | null {
  try {
    const target = fs.readlinkSync(CURRENT_SYMLINK);
    return path.basename(target);
  } catch {
    return null;
  }
}


// ─── 私有辅助 ────────────────────────────────────────────────────────────

/** 安全删除符号链接（不影响目标目录） */
function removeSymlink(linkPath: string): void {
  try {
    fs.unlinkSync(linkPath);
  } catch {
    // 可能不是符号链接或不存在，尝试 rmSync
    try {
      fs.rmSync(linkPath, { force: true });
    } catch {
      /* 不存在 */
    }
  }
}

// ─── 私有辅助 ────────────────────────────────────────────────────────────

/** 递归复制目录 */
function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
