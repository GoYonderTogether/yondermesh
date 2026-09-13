/**
 * CLI 可执行文件解析 + 子进程 PATH 兜底
 *
 * 为什么需要（实测踩到的三连坑）：
 *   1. daemon 由 LaunchAgent 托管，launchd 给的 PATH 只有
 *      `/usr/bin:/bin:/usr/sbin:/sbin`。而 CLI 装在 `~/.local/bin`、fnm 的
 *      `node-versions/<ver>/installation/bin` 这些地方 —— `which claude` 全部失败，
 *      于是「判定未安装」→ 消息投递被跳过、mount 失败。
 *   2. `spawnSync('codex', ...)` 用裸命令名 → ENOENT → exit -1（投递日志里
 *      那串「投递失败: exit -1」就是这么来的）。
 *   3. 就算路径给对了也不行：codex 是 `#!/usr/bin/env node` 脚本，PATH 里没有
 *      node 一样起不来。所以必须同时补子进程的 PATH。
 *
 * 做法：把常见安装目录补进 process.env.PATH（进程级，一次），再用绝对路径
 * 直接 spawn。两件事都做，是因为第三方 wrapper 仍在用裸命令名 spawn。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

/**
 * 常见 CLI 安装目录（按可信度排序，实际不存在的会被过滤掉）。
 *
 * 包含 fnm 的 node 目录：CLI 自己（或它的 shebang）需要 node，
 * 而 daemon 的 PATH 里往往没有 nvm/fnm 注入的那一份。
 */
export function cliSearchDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.yondermesh', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  // fnm：把每个已安装版本都放进来（node 是 CLI 的运行时依赖）
  const fnmRoot = path.join(home, '.local', 'share', 'fnm', 'node-versions');
  try {
    for (const v of fs.readdirSync(fnmRoot)) {
      dirs.push(path.join(fnmRoot, v, 'installation', 'bin'));
    }
  } catch {
    // 没装 fnm：忽略
  }

  // nvm：取当前 default 之外的版本目录（best-effort）
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvmRoot)) {
      dirs.push(path.join(nvmRoot, v, 'bin'));
    }
  } catch {
    // 没装 nvm：忽略
  }

  // 当前进程自己的 node 目录（最可靠的一份）
  if (process.execPath) dirs.unshift(path.dirname(process.execPath));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    try {
      if (fs.existsSync(d)) out.push(d);
    } catch {
      // 权限之类的问题：跳过
    }
  }
  return out;
}

/** 进程级 PATH 兜底（幂等）。返回补完之后的 PATH。 */
export function augmentProcessPath(env: NodeJS.ProcessEnv = process.env): string {
  const current = (env.PATH ?? '').split(':').filter(Boolean);
  const have = new Set(current);
  const missing = cliSearchDirs().filter((d) => !have.has(d));
  const merged = [...missing, ...current].join(':');
  env.PATH = merged;
  return merged;
}

/**
 * 按名字找可执行文件的绝对路径；找不到返回 undefined。
 * 先信 PATH（用户自己配的优先），再回退到常见安装目录。
 */
export function findCliBinary(name: string): string | undefined {
  try {
    const found = execSync(`which ${name} 2>/dev/null`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (found) return found;
  } catch {
    // PATH 里没有，继续找常见位置
  }
  for (const dir of cliSearchDirs()) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 不存在或不可执行：继续
    }
  }
  return undefined;
}

/**
 * 解析可执行文件绝对路径；找不到时**原样返回** name
 * （让 spawn 报出可诊断的错误，而不是静默变成 undefined）。
 */
export function resolveCliBinary(name: string): string {
  return findCliBinary(name) ?? name;
}

/**
 * 给要 spawn 的 CLI 构造 env：PATH 里带上常见目录，
 * 这样 `#!/usr/bin/env node` 这类脚本才能找到自己的运行时。
 */
export function buildCliEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  augmentProcessPath(env);
  return { ...env, ...(extra ?? {}) };
}
