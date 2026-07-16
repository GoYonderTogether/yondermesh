/**
 * WorkBuddy / CodeBuddy CLI wrapper
 *
 * 封装 `cbc` CLI 的非交互调用：版本探测、exec 执行、resume 续接。
 *
 * 实测环境（2026-07）：
 *   - cbc CLI 未安装（~/.codebuddy/ 存在但 cbc 不在 PATH）
 *   - 已知 cbc v2.106.4（腾讯 Tencent，非 ByteDance）
 *   - 配置目录：~/.codebuddy/（models.json 含 GLM-5.2 BYOK，url 须以 /chat/completions 结尾）
 *
 * 推断命令（基于 Claude-Code-like CLI 通用模式，待 cbc 安装后校准）：
 *   cbc --version
 *   cbc exec "prompt" / cbc -p "prompt"     非交互执行
 *   cbc --resume <sessionId>                  续接 session
 *   cbc --cwd <path>                          指定工作目录
 */

import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** CodeBuddy 配置目录 */
export const CODEBUDDY_HOME = path.join(os.homedir(), '.codebuddy');
/** CodeBuddy MCP / 模型配置文件 */
export const CODEBUDDY_MODELS_JSON = path.join(CODEBUDDY_HOME, 'models.json');
/** CodeBuddy skills 目录 */
export const CODEBUDDY_SKILLS_DIR = path.join(CODEBUDDY_HOME, 'skills');
/** CodeBuddy hooks 配置文件 */
export const CODEBUDDY_HOOKS_PATH = path.join(CODEBUDDY_HOME, 'hooks.json');
/** CodeBuddy 全局指令文件 */
export const CODEBUDDY_AGENTS_MD = path.join(CODEBUDDY_HOME, 'AGENTS.md');

/** cbc 二进制名 */
const CBC_BIN = 'cbc';

/** 探测结果 */
export interface CodeBuddyDetect {
  installed: boolean;
  binary?: string;
  version?: string;
  homeExists: boolean;
  modelsJsonExists: boolean;
  modelsJsonEmpty: boolean;
}

/** exec 调用选项 */
export interface CodeBuddyExecOptions {
  /** 工作目录 */
  cwd?: string;
  /** 超时（毫秒），默认 120s */
  timeoutMs?: number;
  /** 透传环境变量 */
  env?: Record<string, string>;
}

/** exec 调用结果 */
export interface CodeBuddyExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 探测本机是否安装 cbc CLI 及其版本。
 * `cbc --version` 输出形如 "2.106.4"。
 */
export function detectCodeBuddy(): CodeBuddyDetect {
  let version: string | undefined;
  let binary: string | undefined;
  let installed = false;
  try {
    const out = execSync(`${CBC_BIN} --version`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    version = m ? m[1] : out;
    binary = CBC_BIN;
    installed = true;
  } catch {
    // 未安装或不在 PATH
  }
  const modelsJsonExists = fs.existsSync(CODEBUDDY_MODELS_JSON);
  let modelsJsonEmpty = false;
  if (modelsJsonExists) {
    try {
      const stat = fs.statSync(CODEBUDDY_MODELS_JSON);
      modelsJsonEmpty = stat.size === 0;
    } catch {
      /* ignore */
    }
  }
  return {
    installed,
    binary,
    version,
    homeExists: fs.existsSync(CODEBUDDY_HOME),
    modelsJsonExists,
    modelsJsonEmpty,
  };
}

/**
 * 非交互执行单条 prompt：`cbc exec "prompt"`。
 * cbc 未安装时返回 exitCode=-1。
 */
export function cbcExec(prompt: string, options: CodeBuddyExecOptions = {}): CodeBuddyExecResult {
  const args = ['exec'];
  if (options.cwd) args.push('--cwd', options.cwd);
  args.push(prompt);

  const result = spawnSync(CBC_BIN, args, {
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

/** 续接已有 session 的参数：`cbc --resume <sessionId>` */
export function cbcResumeArgs(sessionId: string, cwd?: string): string[] {
  const args = ['--resume', sessionId];
  if (cwd) args.push('--cwd', cwd);
  return args;
}

/** inject 调用结果：response 是 agent 回复文本，exitCode 是进程退出码（0=成功） */
export interface CodeBuddyInjectWrapperResult {
  response: string;
  exitCode: number;
}

/**
 * 向已有 cbc session 注入消息并同步取回回复。
 *
 * 实现方式：组合 resume + exec：
 *   spawnSync('cbc', [...cbcResumeArgs(sessionId), 'exec', message])
 *
 * 返回 stdout 作为 response；若 spawnSync 抛错或 exitCode != 0，response 包含 stderr。
 */
export function inject(sessionId: string, message: string): CodeBuddyInjectWrapperResult {
  // 组合 resume + exec 模式
  const args = [...cbcResumeArgs(sessionId), 'exec', message];
  try {
    const result = spawnSync(CBC_BIN, args, {
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
