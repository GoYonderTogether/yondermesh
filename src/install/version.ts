/**
 * 基于 Git 元数据的版本号计算
 *
 * 版本格式（semver 兼容）：
 *   - 精确命中 tag：    0.1.0
 *   - tag 之后有提交：  0.1.0+3.g581557f
 *   - 有未提交修改：    0.1.0+3.g581557f.dirty
 *   - 无 tag：          0.0.0+10.g581557f
 *
 * 计算来源：git describe --tags --long --always --dirty
 * 退化来源：package.json version（非 git 仓库时）
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 在指定目录运行 git 命令，返回 stdout（trim 后）。失败返回 null。
 */
function git(cwd: string, ...args: string[]): string | null {
  try {
    return execSync(['git', ...args].join(' '), {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 基于 git describe 计算语义版本号。
 *
 * @param projectRoot 项目根目录（含 .git）
 * @returns 版本号字符串；git 不可用时返回 null
 */
export function describeVersion(projectRoot: string): string | null {
  if (!git(projectRoot, 'rev-parse', '--is-inside-work-tree')) return null;

  const describe = git(
    projectRoot,
    'describe', '--tags', '--long', '--always', '--dirty',
  );
  if (!describe) return null;

  // v0.1.0-3-g581557f / v0.1.0-0-g581557f / v0.1.0-3-g581557f-dirty / 581557f / 581557f-dirty
  const tagged = describe.match(/^(.+)-(\d+)-g([0-9a-f]+)(-dirty)?$/);

  if (tagged) {
    const tag = tagged[1]!.replace(/^v/, '');
    const count = parseInt(tagged[2]!, 10);
    const hash = tagged[3]!;
    const dirty = tagged[4] === '-dirty';

    if (count === 0 && !dirty) return tag;
    let version = `${tag}+${count}.g${hash}`;
    if (dirty) version += '.dirty';
    return version;
  }

  // 无 tag — 用 commit 总数作为 build 元数据
  const shortHash = describe.replace(/-dirty$/, '');
  const isDirty = describe.endsWith('-dirty');
  const totalCommits = git(projectRoot, 'rev-list', '--count', 'HEAD');

  let version = `0.0.0+${totalCommits ?? '0'}.g${shortHash}`;
  if (isDirty) version += '.dirty';
  return version;
}

/**
 * 获取版本号：优先 git describe，退化到 package.json version。
 */
export function resolveVersion(projectRoot: string): string {
  // 环境变量覆盖（测试 / 自定义构建场景）
  if (process.env.YONDERMESH_FORCE_VERSION) {
    return process.env.YONDERMESH_FORCE_VERSION;
  }

  const gitVersion = describeVersion(projectRoot);
  if (gitVersion) return gitVersion;

  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'),
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 获取 git short hash（用于元数据记录） */
export function gitShortHash(projectRoot: string): string | null {
  return git(projectRoot, 'rev-parse', '--short', 'HEAD');
}

/** 获取当前分支名 */
export function gitBranch(projectRoot: string): string | null {
  return git(projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD');
}
