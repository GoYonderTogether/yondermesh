/**
 * Git 版本号计算测试
 */
import { describe, it, expect } from 'vitest';
import { describeVersion, resolveVersion, gitShortHash, gitBranch } from '../src/install/version.js';
import * as path from 'node:path';
const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('Git 版本号计算', () => {
  it('describeVersion 在 git 仓库中返回非空字符串', () => {
    const v = describeVersion(PROJECT_ROOT);
    expect(v).toBeTruthy();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('describeVersion 在非 git 目录返回 null', () => {
    const v = describeVersion('/tmp');
    expect(v).toBeNull();
  });

  it('resolveVersion 在 git 仓库中返回 git 版本', () => {
    const v = resolveVersion(PROJECT_ROOT);
    expect(v).toBeTruthy();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('resolveVersion 在非 git 目录退化到 0.0.0', () => {
    const v = resolveVersion('/tmp');
    expect(v).toBe('0.0.0');
  });

  it('gitShortHash 在 git 仓库中返回短 hash', () => {
    const hash = gitShortHash(PROJECT_ROOT);
    expect(hash).toBeTruthy();
    expect(hash).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('gitBranch 在 git 仓库中返回分支名', () => {
    const branch = gitBranch(PROJECT_ROOT);
    expect(branch).toBeTruthy();
    expect(branch.length).toBeGreaterThan(0);
  });
});
