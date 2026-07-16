/**
 * Vibe CLI wrapper
 *
 * 封装 `vibe` CLI 的非交互调用：版本探测、programmatic 模式执行、resume 续接。
 *
 * 实测命令（vibe v2.19.1，Mistral AI）：
 *   vibe --version                            → "vibe 2.19.1"
 *   vibe -p "prompt"                          programmatic 模式（输出后退出）
 *   vibe -p "prompt" --output json            JSON 输出
 *   vibe -p "prompt" --max-turns N            限制最大轮次
 *   vibe -c / --resume [SESSION_ID]           续接 session
 *   vibe --workdir DIR                        指定工作目录
 *   vibe --auto-approve / --yolo              自动批准工具调用
 */

import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';

/** Vibe 配置目录 */
export const VIBE_HOME = path.join(os.homedir(), '.vibe');
/** Vibe sessions 目录 */
export const VIBE_SESSIONS_DIR = path.join(VIBE_HOME, 'logs', 'session');
/** Vibe 配置文件 */
export const VIBE_CONFIG_PATH = path.join(VIBE_HOME, 'config.toml');
/** Vibe hooks 配置 */
export const VIBE_HOOKS_PATH = path.join(VIBE_HOME, 'hooks.toml');
/** Vibe skills 目录 */
export const VIBE_SKILLS_DIR = path.join(VIBE_HOME, 'skills');
/** Vibe 全局指令文件 */
export const VIBE_AGENTS_MD = path.join(VIBE_HOME, 'AGENTS.md');

/** vibe 二进制名 */
const VIBE_BIN = 'vibe';

/** 探测结果 */
export interface VibeDetect {
  installed: boolean;
  binary?: string;
  version?: string;
  homeExists: boolean;
  sessionsDirExists: boolean;
}

/** programmatic 调用选项 */
export interface VibeExecOptions {
  /** 工作目录 */
  cwd?: string;
  /** 输出格式：text / json / streaming */
  output?: 'text' | 'json' | 'streaming';
  /** 最大轮次 */
  maxTurns?: number;
  /** 自动批准工具调用 */
  autoApprove?: boolean;
  /** 超时（毫秒），默认 120s */
  timeoutMs?: number;
  /** 透传环境变量 */
  env?: Record<string, string>;
}

/** programmatic 调用结果 */
export interface VibeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 探测本机是否安装 vibe CLI 及其版本。
 * `vibe --version` 输出形如 "vibe 2.19.1"。
 */
export function detectVibe(): VibeDetect {
  let version: string | undefined;
  let binary: string | undefined;
  let installed = false;
  try {
    const out = execSync(`${VIBE_BIN} --version`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // "vibe 2.19.1" → 取版本号
    const m = out.match(/(\d+\.\d+\.\d+)/);
    version = m ? m[1] : out;
    binary = VIBE_BIN;
    installed = true;
  } catch {
    // 未安装或不在 PATH
  }
  return {
    installed,
    binary,
    version,
    homeExists: fs.existsSync(VIBE_HOME),
    sessionsDirExists: fs.existsSync(VIBE_SESSIONS_DIR),
  };
}

/**
 * programmatic 模式执行单条 prompt：`vibe -p "prompt"`。
 * 适合 yondermesh 发起测试 session 验证 importer。
 */
export function vibeExec(prompt: string, options: VibeExecOptions = {}): VibeExecResult {
  const args = ['-p', prompt];
  if (options.output) args.push('--output', options.output);
  if (options.maxTurns !== undefined) args.push('--max-turns', String(options.maxTurns));
  if (options.autoApprove) args.push('--auto-approve');
  if (options.cwd) args.push('--workdir', options.cwd);

  const result = spawnSync(VIBE_BIN, args, {
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
 * 续接已有 session 的参数：`vibe --resume <sessionId>`。
 */
export function vibeResumeArgs(sessionId: string, cwd?: string): string[] {
  const args = ['--resume', sessionId];
  if (cwd) args.push('--workdir', cwd);
  return args;
}

/** inject 调用结果：response 是 agent 回复文本，exitCode 是进程退出码（0=成功） */
export interface VibeInjectWrapperResult {
  response: string;
  exitCode: number;
}

/**
 * 向已有 vibe session 注入消息并同步取回回复。
 *
 * 实现方式：组合 resume + -p：
 *   spawnSync('vibe', [...vibeResumeArgs(sessionId), '-p', message])
 *
 * 返回 stdout 作为 response；若 spawnSync 抛错或 exitCode != 0，response 包含 stderr。
 */
export function inject(sessionId: string, message: string): VibeInjectWrapperResult {
  // 组合 resume + -p 模式
  const args = [...vibeResumeArgs(sessionId), '-p', message];
  try {
    const result = spawnSync(VIBE_BIN, args, {
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
 * 列出本机 Vibe sessions 目录下的 session 目录名（session_<date>_<time>_<hex>）。
 */
export function listVibeSessionDirs(): string[] {
  const ids: string[] = [];
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(VIBE_SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('session_')) {
      ids.push(e.name);
    }
  }
  ids.sort();
  return ids;
}
