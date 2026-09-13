/**
 * cli-path.test.ts — daemon 在 launchd 下找不到 CLI 的问题（同一根因的三处症状）
 *
 * 实测背景：LaunchAgent 给的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
 * 而 CLI 装在 ~/.local/bin、fnm 的 node 目录下。于是：
 *   · which 全部失败 → 「判定未安装」→ 消息投递被跳过
 *   · spawnSync('codex') ENOENT → exit -1
 *   · codex 是 `#!/usr/bin/env node` 脚本 → PATH 里没 node 也起不来
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cliSearchDirs,
  augmentProcessPath,
  findCliBinary,
  resolveCliBinary,
  buildCliEnv,
} from '../src/detect/cli-path.js';

describe('cli-path', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('cliSearchDirs 只返回真实存在的目录，且包含 node 自己的目录', () => {
    const dirs = cliSearchDirs();
    expect(dirs.length).toBeGreaterThan(0);
    // 当前进程的 node 目录必须在内 —— codex 这类 `env node` 脚本靠它
    expect(dirs).toContain(require('node:path').dirname(process.execPath));
    for (const d of dirs) expect(d.startsWith('/')).toBe(true);
  });

  it('augmentProcessPath 把缺失目录补进 PATH，且幂等（不重复叠加）', () => {
    const env = { PATH: '/usr/bin:/bin' };
    const first = augmentProcessPath(env);
    const second = augmentProcessPath(env);
    expect(first).toBe(second);
    expect(first).toContain('/usr/bin:/bin');
    // 叠加一次以后目录不重复出现
    const dirs = first.split(':');
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('findCliBinary：PATH 里能找到就用 PATH 的', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ymesh-clipath-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const fake = join(dir, 'ymesh-fake-cli');
    writeFileSync(fake, '#!/bin/sh\necho ok\n');
    chmodSync(fake, 0o755);

    const old = process.env.PATH;
    process.env.PATH = `${dir}:${old}`;
    cleanups.push(() => {
      process.env.PATH = old;
    });

    expect(findCliBinary('ymesh-fake-cli')).toBe(fake);
  });

  it('findCliBinary：找不到返回 undefined；resolveCliBinary 原样返回名字（让 spawn 报错可诊断）', () => {
    expect(findCliBinary('definitely-not-a-real-cli-xyz')).toBeUndefined();
    expect(resolveCliBinary('definitely-not-a-real-cli-xyz')).toBe('definitely-not-a-real-cli-xyz');
  });

  it('buildCliEnv 子进程 PATH 一定含 node 目录（shebang `env node` 才能跑起来）', () => {
    const env = buildCliEnv({ FOO: 'bar' });
    expect(env.FOO).toBe('bar');
    const nodeDir = require('node:path').dirname(process.execPath);
    expect((env.PATH ?? '').split(':')).toContain(nodeDir);
  });
});
