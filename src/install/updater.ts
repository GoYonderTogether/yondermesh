/**
 * Git 源码更新与回退（LOOP-009）
 *
 * 更新流程（类似 hermes agent 的更新方式）：
 *   1. git clone 或 git fetch 最新源码到 staging 目录
 *   2. 在 staging 中构建 release
 *   3. 安装新 release（原子符号链接切换）
 *   4. 健康检查：运行 `ymesh version` 验证
 *   5. 健康检查失败 → 自动回退到 previous release
 *
 * 保护措施：
 *   - 更新锁（文件锁，防止并发更新）
 *   - 构建失败保留旧版本
 *   - 健康检查失败自动回退
 *   - 保留 previous release 供回退
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';

import {
  resolveDataDir,
  resolveReleasesDir,
  resolveCurrentSymlink,
} from './paths.js';
import {
  buildRelease,
  installRelease,
  rollbackRelease,
  getCurrentRelease,
} from './release.js';

/** 更新锁文件路径 */
function updateLockPath(): string {
  return path.join(resolveDataDir(), 'update.lock');
}

/** staging 目录路径（git clone / fetch 的目标） */
function stagingDir(): string {
  return path.join(resolveDataDir(), 'staging');
}

/** 默认 Git 仓库 URL */
const DEFAULT_REPO_URL = 'https://github.com/GoYonderTogether/yondermesh.git';

/** 默认分支 */
const DEFAULT_BRANCH = 'main';

/** 更新结果 */
export interface UpdateResult {
  success: boolean;
  previousVersion: string | null;
  newVersion: string | null;
  rolledBack: boolean;
  error?: string;
}

/** 健康检查函数类型 */
export type HealthCheck = () => boolean;

/**
 * 从 Git 更新到最新版本
 *
 * @param repoUrl Git 仓库 URL（默认官方仓库）
 * @param branch 分支名（默认 main）
 * @param healthCheck 健康检查函数（默认运行 `ymesh version`）
 */
export function updateFromGit(
  repoUrl: string = DEFAULT_REPO_URL,
  branch: string = DEFAULT_BRANCH,
  healthCheck?: HealthCheck,
): UpdateResult {
  const previousVersion = getCurrentRelease();

  // 1. 获取更新锁
  try {
    acquireUpdateLock();
  } catch (err) {
    return {
      success: false,
      previousVersion,
      newVersion: previousVersion,
      rolledBack: false,
      error: `无法获取更新锁: ${String(err)}`,
    };
  }

  try {
    // 2. clone 或 fetch 到 staging
    syncStaging(repoUrl, branch);

    // 2.5 安装依赖（staging 是全新目录，没有 node_modules）
    execSync('npm ci', { cwd: stagingDir(), stdio: 'pipe', timeout: 120_000 });

    // 3. 在 staging 中构建 release
    const release = buildRelease(stagingDir(), true);

    // 4. 安装新 release
    installRelease(release);

    // 5. 健康检查
    const check = healthCheck ?? defaultHealthCheck;
    if (!check()) {
      // 健康检查失败 → 回退
      const rolledBackPath = rollbackRelease();
      return {
        success: false,
        previousVersion,
        newVersion: release.version,
        rolledBack: true,
        error: rolledBackPath
          ? `健康检查失败，已回退到 ${path.basename(rolledBackPath)}`
          : '健康检查失败，但没有 previous release 可回退',
      };
    }

    return {
      success: true,
      previousVersion,
      newVersion: release.version,
      rolledBack: false,
    };
  } catch (err) {
    // 构建或安装失败 → 尝试回退
    try {
      const rolled = rollbackRelease();
      return {
        success: false,
        previousVersion,
        newVersion: null,
        rolledBack: rolled !== null,
        error: `更新失败: ${String(err)}`,
      };
    } catch {
      return {
        success: false,
        previousVersion,
        newVersion: null,
        rolledBack: false,
        error: `更新失败且回退也失败: ${String(err)}`,
      };
    }
  } finally {
    releaseUpdateLock();
  }
}

/**
 * 默认健康检查：运行新安装的 ymesh version
 */
const defaultHealthCheck: HealthCheck = (): boolean => {
  try {
    // 使用 current 符号链接运行 version
    const entry = path.join(resolveCurrentSymlink(), 'ymesh.js');
    if (!existsSync(entry)) return false;
    execSync(`node "${entry}" version`, {
      stdio: 'pipe',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Clone 或 fetch 到 staging 目录
 */
function syncStaging(repoUrl: string, branch: string): void {
  mkdirSync(resolveReleasesDir(), { recursive: true });

  const staging = stagingDir();
  if (existsSync(path.join(staging, '.git'))) {
    // staging 已有 git 仓库 → fetch + reset
    execSync('git fetch origin', { cwd: staging, stdio: 'pipe' });
    execSync(`git reset --hard origin/${branch}`, { cwd: staging, stdio: 'pipe' });
  } else {
    // 全新 clone
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(path.dirname(staging), { recursive: true });
    execSync(
      `git clone --depth 1 --branch ${branch} ${repoUrl} "${staging}"`,
      { stdio: 'pipe', timeout: 60_000 },
    );
  }
}

// ─── 更新锁 ──────────────────────────────────────────────────────────────

/**
 * 获取更新锁（文件锁）
 */
function acquireUpdateLock(): void {
  const lockPath = updateLockPath();
  if (existsSync(lockPath)) {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    if (pid && isProcessAlive(pid)) {
      throw new Error(`另一个更新正在进行中 (PID ${pid})`);
    }
    // 旧锁文件但进程已退出——清理
  }
  writeFileSync(lockPath, String(process.pid), 'utf-8');
}

/**
 * 释放更新锁
 */
function releaseUpdateLock(): void {
  try {
    const lockPath = updateLockPath();
    if (existsSync(lockPath)) {
      const content = fs.readFileSync(lockPath, 'utf-8').trim();
      if (parseInt(content, 10) === process.pid) {
        unlinkSync(lockPath);
      }
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 检查进程是否存活
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
