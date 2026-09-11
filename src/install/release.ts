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
  resolveReleasesDir,
  resolveEntrySymlink,
  resolveBinDir,
  resolveCurrentSymlink,
  resolvePreviousSymlink,
  releaseDir,
  releaseEntry,
} from './paths.js';

import { resolveVersion, gitShortHash, gitBranch } from './version.js';

/** release 构建结果 */
export interface ReleaseResult {
  version: string;
  releasePath: string;
  entryPath: string;
  builtAt: number;
}

/**
 * 构建一个本地 release
 *
 * @param projectRoot 项目根目录（含 src/、package.json）
 * @param force 是否覆盖已存在的同名 release
 */
export function buildRelease(projectRoot: string, force = false): ReleaseResult {
  const version = resolveVersion(projectRoot);
  const target = releaseDir(version);

  // ── 预检：必须是「源码树」才能构建 ─────────────────────────────────
  // 为什么：从已安装的 release 里跑 `ymesh install` 时，resolveProjectRoot()
  // 会把 release 目录当成项目根（它有 package.json 但没有 src/tsconfig），
  // 于是 `npm run build` 必然失败——而旧实现在此之前**已经删掉了目标 release**，
  // 结果把正在使用的安装毁掉（CLI 直接 command not found），且无回滚。
  // 现在：先检查，早失败，且**不碰任何文件**。
  const isSourceTree =
    fs.existsSync(path.join(projectRoot, 'tsconfig.json')) &&
    fs.existsSync(path.join(projectRoot, 'src')) &&
    fs.existsSync(path.join(projectRoot, 'package.json'));
  if (!isSourceTree) {
    throw new Error(
      [
        `不是 yondermesh 源码树，拒绝构建: ${projectRoot}`,
        `  （缺少 src/ 或 tsconfig.json —— 你大概是在"已安装的 release"里跑 install）`,
        ``,
        `  请改用源码目录运行：`,
        `    cd <yondermesh 源码> && npm run dev -- install --force`,
        `  或指定源码路径：`,
        `    YONDERMESH_DEV_ROOT=<源码目录> ymesh install --force`,
        ``,
        `  已中止：你的现有安装未被改动。`,
      ].join('\n'),
    );
  }

  if (fs.existsSync(target) && !force) {
    throw new Error(
      `release ${version} 已存在于 ${target}。使用 force=true 覆盖。`,
    );
  }

  // ── 原子构建：先建到暂存目录，全部成功后才替换正式目录 ─────────────
  // 为什么：旧实现是「先 rmSync 正式目录 → 再 npm build →
  // 失败就留下空目录」，而 bin/ymesh 与 releases/current 可能正指向它
  //（版本号不变时必然如此）→ 安装被毁。暂存 + rename 保证：
  // 构建过程中，正在运行的安装始终完好；失败则原样保留。
  const staging = `${target}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  // 1. 编译 TypeScript（在源码目录里构建，绝不改 CWD 到 release）
  try {
    execSync('npm run build', { cwd: projectRoot, stdio: 'pipe' });
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `构建失败，已中止且**未改动现有安装**。\n  ${String(err).split('\n')[0]}`,
    );
  }

  // 以下所有产物都写进 staging；全部就绪后才在末尾原子替换到 target。

  // 2. 复制 dist
  const distSrc = path.join(projectRoot, 'dist');
  const distDst = path.join(staging, 'dist');
  copyDir(distSrc, distDst);

  // 2.5 复制 skills 到 release 目录（skill 随版本发布）
  const skillsSrc = path.join(projectRoot, 'skills');
  if (fs.existsSync(skillsSrc)) {
    const skillsDst = path.join(staging, 'skills');
    copyDir(skillsSrc, skillsDst);
  }

  // 3. 复制 package.json（只保留必要的 dependencies）
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
  const releasePkg = {
    name: pkg.name,
    version,
    type: 'module',
    dependencies: pkg.dependencies ?? {},
    // git 元数据：用于溯源
    gitHash: gitShortHash(projectRoot) ?? undefined,
    gitBranch: gitBranch(projectRoot) ?? undefined,
  };
  fs.writeFileSync(
    path.join(staging, 'package.json'),
    JSON.stringify(releasePkg, null, 2),
  );

  // 4. 生成 ymesh.js 启动脚本
  const entryPath = releaseEntry(staging);
  const entryContent = `#!/usr/bin/env node
// yondermesh ${version} — 自动生成的启动脚本
import('./dist/bin/ymesh.js');
`;
  fs.writeFileSync(entryPath, entryContent, 'utf-8');
  fs.chmodSync(entryPath, 0o755);

  // 5. 原子替换：暂存目录就绪后，才动正式目录
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);

  return {
    version,
    releasePath: target,
    entryPath: releaseEntry(target),
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
  fs.mkdirSync(resolveBinDir(), { recursive: true });
  fs.mkdirSync(resolveReleasesDir(), { recursive: true });

  // 如果已有 current 符号链接，先保存为 previous
  const currentSymlink = resolveCurrentSymlink();
  const previousSymlink = resolvePreviousSymlink();
  if (fs.existsSync(currentSymlink) || fs.existsSync(previousSymlink)) {
    try {
      const currentTarget = fs.readlinkSync(currentSymlink);
      // 更新 previous 指向旧 current
      removeSymlink(previousSymlink);
      fs.symlinkSync(currentTarget, previousSymlink, 'dir');
    } catch {
      /* current 不是符号链接或不存在 */
    }
  }

  // 更新 current 指向新 release
  removeSymlink(currentSymlink);
  fs.symlinkSync(release.releasePath, currentSymlink, 'dir');

  // 更新入口符号链接
  const entrySymlink = resolveEntrySymlink();
  removeSymlink(entrySymlink);
  fs.symlinkSync(release.entryPath, entrySymlink, 'file');
}

/**
 * 回退到 previous release
 *
 * @returns 回退后的 release 路径，或 null 如果没有 previous
 */
export function rollbackRelease(): string | null {
  const previousSymlink = resolvePreviousSymlink();
  if (!fs.existsSync(previousSymlink)) {
    return null;
  }

  try {
    const previousTarget = fs.readlinkSync(previousSymlink);

    // current → previous
    const currentSymlink = resolveCurrentSymlink();
    removeSymlink(currentSymlink);
    fs.symlinkSync(previousTarget, currentSymlink, 'dir');

    // 入口符号链接
    const entry = releaseEntry(previousTarget);
    if (fs.existsSync(entry)) {
      const entrySymlink = resolveEntrySymlink();
      removeSymlink(entrySymlink);
      fs.symlinkSync(entry, entrySymlink, 'file');
    }

    // 清理 previous
    removeSymlink(previousSymlink);

    return previousTarget;
  } catch {
    return null;
  }
}

/**
 * 列出所有已安装的 release 版本
 */
export function listReleases(): string[] {
  const releasesDir = resolveReleasesDir();
  if (!fs.existsSync(releasesDir)) return [];
  return fs
    .readdirSync(releasesDir)
    .filter((name) => name !== 'current' && name !== 'previous')
    .filter((name) => {
      try {
        return fs.statSync(path.join(releasesDir, name)).isDirectory();
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
    const target = fs.readlinkSync(resolveCurrentSymlink());
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
