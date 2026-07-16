/**
 * Factory Droid CLI wrapper
 *
 * 封装 `droid` CLI 的非交互调用：版本探测、exec 执行单 prompt、resume 续接 session。
 * 子进程通过 execSync / spawnSync 调用，不引入外部依赖。
 *
 * 实测命令（droid v0.171.0）：
 *   droid --version                          → "0.171.0"
 *   droid exec "prompt"                      非交互执行（stdout 为模型输出）
 *   droid exec -f prompt.txt                 从文件读取 prompt
 *   droid --resume <sessionId>               续接 session
 *   droid --cwd <path>                       指定工作目录
 *   droid --append-system-prompt <text>      追加系统指令
 *   droid mcp                                管理 MCP servers
 */

import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';

/** Factory Droid 配置目录 */
export const FACTORY_HOME = path.join(os.homedir(), '.factory');
/** Factory Droid sessions 目录 */
export const FACTORY_SESSIONS_DIR = path.join(FACTORY_HOME, 'sessions');

/** droid 二进制名 */
const DROID_BIN = 'droid';

/** 探测结果 */
export interface FactoryDroidDetect {
  installed: boolean;
  binary?: string;
  version?: string;
  homeExists: boolean;
  sessionsDirExists: boolean;
}

/** exec 调用选项 */
export interface FactoryExecOptions {
  /** 工作目录 */
  cwd?: string;
  /** 追加系统指令 */
  appendSystemPrompt?: string;
  /** 超时（毫秒），默认 120s */
  timeoutMs?: number;
  /** 透传环境变量 */
  env?: Record<string, string>;
}

/** exec 调用结果 */
export interface FactoryExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 探测本机是否安装 droid CLI 及其版本。
 * 使用 `droid --version` 获取版本号（输出形如 "0.171.0"）。
 */
export function detectFactoryDroid(): FactoryDroidDetect {
  let version: string | undefined;
  let binary: string | undefined;
  let installed = false;
  try {
    const out = execSync(`${DROID_BIN} --version`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // droid --version 输出纯版本号 "0.171.0"
    version = out;
    binary = DROID_BIN;
    installed = true;
  } catch {
    // 未安装或不在 PATH
  }
  const fsNs = fs;
  return {
    installed,
    binary,
    version,
    homeExists: fsNs.existsSync(FACTORY_HOME),
    sessionsDirExists: fsNs.existsSync(FACTORY_SESSIONS_DIR),
  };
}

/**
 * 非交互执行单条 prompt：`droid exec "prompt"`。
 * 适合 yondermesh 发起测试 session 验证 importer。
 */
export function droidExec(prompt: string, options: FactoryExecOptions = {}): FactoryExecResult {
  const args = ['exec'];
  if (options.cwd) {
    args.push('--cwd', options.cwd);
  }
  if (options.appendSystemPrompt) {
    args.push('--append-system-prompt', options.appendSystemPrompt);
  }
  args.push(prompt);

  const result = spawnSync(DROID_BIN, args, {
    encoding: 'utf-8',
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 120_000,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.signal === 'SIGTERM' || !!result.signal,
  };
}

/**
 * 续接已有 session：`droid --resume <sessionId>`。
 * 非交互模式需配合 exec；resume 单独使用进入交互模式（仅做能力探测）。
 */
export function droidResumeArgs(sessionId: string, cwd?: string): string[] {
  const args = ['--resume', sessionId];
  if (cwd) args.push('--cwd', cwd);
  return args;
}

/** inject 调用结果：response 是 agent 回复文本，exitCode 是进程退出码（0=成功） */
export interface FactoryInjectWrapperResult {
  response: string;
  exitCode: number;
}

/**
 * 向已有 droid session 注入消息并同步取回回复。
 *
 * 实现方式：组合 resume + exec 模式：
 *   spawnSync('droid', ['--resume', sessionId, 'exec', message])
 * 若 resume+exec 组合不行，可退而用 ['-p', message] 或直接 [message] 形式。
 *
 * 返回 stdout 作为 response；若 spawnSync 抛错或 exitCode != 0，response 包含 stderr。
 */
export function inject(sessionId: string, message: string): FactoryInjectWrapperResult {
  // 组合 resume + exec 模式
  const args = [...droidResumeArgs(sessionId), 'exec', message];
  try {
    const result = spawnSync(DROID_BIN, args, {
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exitCode = result.status ?? -1;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    if (exitCode !== 0) {
      // 失败时 response 包含 stderr 帮助排查
      return { response: stderr || stdout || '', exitCode };
    }
    return { response: stdout, exitCode };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { response: msg, exitCode: -1 };
  }
}

/**
 * 列出本机 Factory sessions 目录下的 session 文件 uuid（不含扩展名）。
 * 用于 wrapper 与 importer 交叉校验。
 */
export function listFactorySessionIds(): string[] {
  const ids: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        ids.push(e.name.slice(0, -'.jsonl'.length));
      }
    }
  };
  walk(FACTORY_SESSIONS_DIR);
  return ids;
}
