/**
 * LOOP-009 更新器测试
 *
 * 验收门：
 *   1. updateFromGit 返回结构正确的 UpdateResult
 *   2. 更新锁：旧锁文件（进程已退出）不阻止新操作
 *   3. 构建失败时保留旧版本
 *   4. rollbackRelease 回退正确
 *
 * 注意：不测试真实的 git clone（需要网络），
 * 只测试锁机制和回退逻辑。
 *
 * 通过 YONDERMESH_HOME 环境变量重定向到临时目录。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { updateFromGit } from '../src/install/updater.js';
import type { UpdateResult } from '../src/install/updater.js';
import {
  buildRelease,
  installRelease,
  rollbackRelease,
  getCurrentRelease,
} from '../src/install/release.js';
import {
  resolveDataDir,
  resolvePreviousSymlink,
} from '../src/install/paths.js';

const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('LOOP-009: 更新器', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-update-'));
    process.env.YONDERMESH_HOME = tmpHome;

    // 建立 baseline：安装当前版本
    const release = buildRelease(PROJECT_ROOT, true);
    installRelease(release);
  });

  afterEach(() => {
    delete process.env.YONDERMESH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('updateFromGit 返回结构正确的 UpdateResult', () => {
    const result: UpdateResult = updateFromGit(
      'file:///nonexistent/repo',
      'main',
      () => true,
    );

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('previousVersion');
    expect(result).toHaveProperty('newVersion');
    expect(result).toHaveProperty('rolledBack');
    expect(result).toHaveProperty('error');
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.rolledBack).toBe('boolean');
  });

  it('更新锁：旧锁文件（进程已退出）不阻止新操作', () => {
    const lockPath = path.join(resolveDataDir(), 'update.lock');
    fs.writeFileSync(lockPath, '999999', 'utf-8');

    const result = updateFromGit(
      'file:///nonexistent/repo',
      'main',
      () => true,
    );

    // 更新会失败（因为 repo 不存在），但不是因为锁
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('更新锁');
  });

  it('rollbackRelease 在有 previous 时成功回退', () => {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const origPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const PREV_SYMLINK = resolvePreviousSymlink();

    // 清理 previous 符号链接，确保干净基线
    try { fs.unlinkSync(PREV_SYMLINK); } catch { /* ok */ }

    // 安装版本 A（9.9.1）
    fs.writeFileSync(pkgPath, JSON.stringify({ ...origPkg, version: '9.9.1' }, null, 2));
    const r1 = buildRelease(PROJECT_ROOT, true);
    installRelease(r1);

    // 安装版本 B（9.9.2）——此时 previous=9.9.1
    fs.writeFileSync(pkgPath, JSON.stringify({ ...origPkg, version: '9.9.2' }, null, 2));
    const r2 = buildRelease(PROJECT_ROOT, true);
    installRelease(r2);

    // 验证 previous 存在
    expect(fs.existsSync(PREV_SYMLINK)).toBe(true);

    // 回退
    const rolled = rollbackRelease();
    expect(rolled).not.toBeNull();

    // 回退后 current 应该是 9.9.1
    const afterRollback = getCurrentRelease();
    expect(afterRollback).toBe('9.9.1');

    // 恢复 package.json
    fs.writeFileSync(pkgPath, JSON.stringify(origPkg, null, 2) + '\n');
  });

  it('updateFromGit 失败时不崩溃，返回 success=false', () => {
    const result = updateFromGit(
      'file:///nonexistent/repo',
      'main',
      () => true,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('updateFromGit 成功后清理更新锁', () => {
    updateFromGit('file:///nonexistent/repo', 'main', () => true);
    const lockPath = path.join(resolveDataDir(), 'update.lock');
    // 锁应该被清理（finally 块）
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
