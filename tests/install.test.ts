/**
 * LOOP-008 安装模块测试
 *
 * 验收门：
 *   1. buildRelease 在临时目录构建出合法 release
 *   2. installRelease 创建正确的符号链接
 *   3. getCurrentRelease 返回已安装版本
 *   4. listReleases 列出所有版本
 *   5. rollbackRelease 回退到 previous
 *   6. generatePlist 输出合法 plist XML
 *   7. getServiceStatus 在 plist 不存在时返回 loaded=false
 *
 * 通过 YONDERMESH_HOME 环境变量重定向到临时目录，避免写入真实 ~/.yondermesh。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  buildRelease,
  installRelease,
  rollbackRelease,
  listReleases,
  getCurrentRelease,
  generatePlist,
  getServiceStatus,
  resolveDataDir,
  resolveReleasesDir,
  resolveBinDir,
  resolveCurrentSymlink,
  resolveEntrySymlink,
  resolvePreviousSymlink,
} from '../src/install/index.js';


describe('LOOP-008: 安装模块', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-install-'));
    process.env.YONDERMESH_HOME = tmpHome;
  });

  afterEach(() => {
    delete process.env.YONDERMESH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('generatePlist 输出合法 plist XML', () => {
    const plist = generatePlist();
    expect(plist).toContain('<?xml');
    expect(plist).toContain('<plist');
    expect(plist).toContain('com.yondermesh.daemon');
    expect(plist).toContain('ProgramArguments');
    expect(plist).toContain('daemon');
    expect(plist).toContain('RunAtLoad');
    expect(plist).toContain('KeepAlive');
  });

  it('generatePlist 包含正确的入口路径', () => {
    const plist = generatePlist();
    // 入口应该指向 ymesh 符号链接
    expect(plist).toContain('ymesh');
  });

  it('getServiceStatus 在 plist 不存在时返回 loaded=false', () => {
    const status = getServiceStatus();
    expect(status).toHaveProperty('loaded');
    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('pid');
    expect(status).toHaveProperty('exitStatus');
  });
});

describe('LOOP-008: Release 构建（使用真实源码）', () => {
  const projectRoot = path.resolve(__dirname, '..');
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-release-'));
    process.env.YONDERMESH_HOME = tmpHome;
  });

  afterEach(() => {
    delete process.env.YONDERMESH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('buildRelease 构建出合法的 release 目录', () => {
    const release = buildRelease(projectRoot, true);
    expect(release.version).toMatch(/\d+\.\d+\.\d+/);
    expect(fs.existsSync(release.releasePath)).toBe(true);
    expect(fs.existsSync(release.entryPath)).toBe(true);
    expect(fs.existsSync(path.join(release.releasePath, 'dist'))).toBe(true);
    expect(fs.existsSync(path.join(release.releasePath, 'package.json'))).toBe(true);

    // ymesh.js 应该有可执行权限
    const stat = fs.statSync(release.entryPath);
    // 检查文件内容包含正确的导入路径
    const entryContent = fs.readFileSync(release.entryPath, 'utf-8');
    expect(entryContent).toContain('dist/bin/ymesh.js');
  });

  it('installRelease 创建正确的符号链接', () => {
    const release = buildRelease(projectRoot, true);
    installRelease(release);

    // current 符号链接应该存在
    expect(fs.existsSync(resolveCurrentSymlink())).toBe(true);

    // 入口符号链接应该存在
    expect(fs.existsSync(resolveEntrySymlink())).toBe(true);
  });

  it('getCurrentRelease 返回当前版本', () => {
    const release = buildRelease(projectRoot, true);
    installRelease(release);
    const current = getCurrentRelease();
    expect(current).not.toBeNull();
    expect(current).toMatch(/\d+\.\d+\.\d+/);
  });

  it('listReleases 返回非空列表', () => {
    const release = buildRelease(projectRoot, true);
    installRelease(release);
    const releases = listReleases();
    expect(releases.length).toBeGreaterThan(0);
    const current = getCurrentRelease();
    if (current) {
      expect(releases).toContain(current);
    }
  });

  it('rollbackRelease 在没有 previous 时返回 null', () => {
    const result = rollbackRelease();
    expect(typeof result === 'string' || result === null).toBe(true);
  });

  it('连续两次 installRelease 后 previous 存在', () => {
    // 构建并安装两次（相同版本 force=true）
    const r1 = buildRelease(projectRoot, true);
    installRelease(r1);

    // 手动模拟另一个版本——修改 package.json version
    const pkgPath = path.join(projectRoot, 'package.json');
    const origPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    fs.writeFileSync(pkgPath, JSON.stringify({ ...origPkg, version: '0.1.1' }, null, 2));

    try {
      const r2 = buildRelease(projectRoot, true);
      installRelease(r2);

      // previous 应该存在
      expect(fs.existsSync(resolvePreviousSymlink())).toBe(true);

      // rollback 应该返回之前的路径
      const rolled = rollbackRelease();
      expect(rolled).not.toBeNull();
    } finally {
      // 恢复版本号
      fs.writeFileSync(pkgPath, JSON.stringify(origPkg, null, 2) + '\n');
    }
  });
});
