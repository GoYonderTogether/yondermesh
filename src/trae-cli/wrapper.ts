/**
 * trae-cli 命令构造器（wrapper）
 *
 * trae-cli（trae-agent v0.1.0）子命令：
 *   - run [TASK]           主执行命令（一次性任务）
 *   - interactive          交互式会话
 *   - show-config          显示配置
 *   - tools                显示可用工具
 *
 * GLM-5.2 接入（已验证）：config.yaml provider=openai + base_url，或 CLI 参数：
 *   trae-cli run "<task>" -p openai -m glm-5.2 \
 *     --model-base-url http://127.0.0.1:15721/v1 -t <trajectory.json> -w <cwd>
 *
 * 关键参数：
 *   -p, --provider TEXT        LLM provider（openai / anthropic / ...）
 *   -m, --model TEXT           模型名
 *   --model-base-url TEXT      模型 API base url
 *   -k, --api-key TEXT         API key（或 env）
 *   -t, --trajectory-file TEXT trajectory 输出路径（决定 session 落点）
 *   -w, --working-dir TEXT     工作目录
 *   --config-file TEXT         配置文件路径（~/.trae-cli/config.yaml）
 *   -f, --file TEXT            从文件读 task 描述
 *   --max-steps INTEGER        最大步数
 *   -mp, --must-patch          是否必须 patch
 */

import { spawnSync } from 'node:child_process';

/** GLM-5.2 经 OpenAI 兼容协议接入时的默认值 */
export const GLM_DEFAULT_PROVIDER = 'openai';
export const GLM_DEFAULT_MODEL = 'glm-5.2';
export const GLM_DEFAULT_BASE_URL = 'http://127.0.0.1:15721/v1';

/** 构造 trae-cli run 命令的输入 */
export interface BuildTraeCliRunOptions {
  /** 任务描述（位置参数；与 file 二选一） */
  task?: string;
  /** 从文件读 task 描述（-f） */
  taskFile?: string;
  /** LLM provider，默认 openai */
  provider?: string;
  /** 模型名，默认 glm-5.2 */
  model?: string;
  /** 模型 API base url，默认 GLM 本地代理 */
  modelBaseUrl?: string;
  /** API key（或通过 env TRAE_API_KEY / OPENAI_API_KEY） */
  apiKey?: string;
  /** trajectory 输出路径（-t；决定 session 落点，转交器必填） */
  trajectoryFile?: string;
  /** 工作目录（-w） */
  workingDir?: string;
  /** 配置文件路径（--config-file） */
  configFile?: string;
  /** 最大步数 */
  maxSteps?: number;
  /** 是否必须 patch */
  mustPatch?: boolean;
  /** 控制台类型 simple|rich */
  consoleType?: 'simple' | 'rich';
  /** 附加 raw 参数 */
  extraArgs?: string[];
}

/** 构造结果 */
export interface TraeCliCommand {
  /** 可执行名（trae-cli） */
  bin: string;
  /** argv */
  args: string[];
  /** 需注入的环境变量 */
  env: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
}

/**
 * 构造 `trae-cli run` 命令。
 * 默认姿势：GLM-5.2 经 OpenAI 兼容协议、写出 trajectory 文件、非交互一次性。
 */
export function buildTraeCliRunCommand(opts: BuildTraeCliRunOptions = {}): TraeCliCommand {
  const args: string[] = ['run'];
  const env: Record<string, string> = {};

  // task 位置参数 or -f
  if (opts.task !== undefined) {
    args.push(opts.task);
  } else if (opts.taskFile) {
    args.push('-f', opts.taskFile);
  } else {
    args.push(''); // 无 task（interactive 场景调用方应改用 buildTraeCliInteractiveCommand）
  }

  const provider = opts.provider ?? GLM_DEFAULT_PROVIDER;
  const model = opts.model ?? GLM_DEFAULT_MODEL;
  const baseUrl = opts.modelBaseUrl ?? GLM_DEFAULT_BASE_URL;
  args.push('-p', provider, '-m', model, '--model-base-url', baseUrl);

  if (opts.apiKey) {
    args.push('-k', opts.apiKey);
  } else if (process.env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }

  if (opts.trajectoryFile) {
    args.push('-t', opts.trajectoryFile);
  }
  if (opts.workingDir) {
    args.push('-w', opts.workingDir);
  }
  if (opts.configFile) {
    args.push('--config-file', opts.configFile);
  }
  if (opts.maxSteps !== undefined) {
    args.push('--max-steps', String(opts.maxSteps));
  }
  if (opts.mustPatch) {
    args.push('--must-patch');
  }
  if (opts.consoleType) {
    args.push('--console-type', opts.consoleType);
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  return { bin: 'trae-cli', args, env, cwd: opts.workingDir };
}

/** 构造 `trae-cli interactive` 命令（交互模式） */
export function buildTraeCliInteractiveCommand(
  opts: Omit<BuildTraeCliRunOptions, 'task' | 'taskFile' | 'mustPatch'> = {},
): TraeCliCommand {
  const args = ['interactive'];
  const env: Record<string, string> = {};

  const provider = opts.provider ?? GLM_DEFAULT_PROVIDER;
  const model = opts.model ?? GLM_DEFAULT_MODEL;
  const baseUrl = opts.modelBaseUrl ?? GLM_DEFAULT_BASE_URL;
  args.push('-p', provider, '-m', model, '--model-base-url', baseUrl);

  if (opts.apiKey) {
    args.push('-k', opts.apiKey);
  } else if (process.env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  if (opts.trajectoryFile) args.push('-t', opts.trajectoryFile);
  if (opts.configFile) args.push('--config-file', opts.configFile);
  if (opts.maxSteps !== undefined) args.push('--max-steps', String(opts.maxSteps));
  if (opts.consoleType) args.push('--console-type', opts.consoleType);

  return { bin: 'trae-cli', args, env, cwd: opts.workingDir };
}

/** inject 调用结果：response 是 agent 回复文本，exitCode 是进程退出码（0=成功） */
export interface TraeCliInjectResult {
  response: string;
  exitCode: number;
}

/**
 * 向 trae-cli session 注入消息并同步取回回复。
 *
 * trae-cli 没有 resume 命令，只有 run [TASK] / interactive。
 * 实现方式：spawnSync('trae-cli', ['run', message])，每次 run 新建 trajectory，
 * sessionId 参数仅作记录，不用于 resume。
 *
 * 返回 stdout 作为 response；若 spawnSync 抛错或 exitCode != 0，response 包含 stderr。
 */
export function inject(sessionId: string, message: string): TraeCliInjectResult {
  // trae-cli 无 resume 概念，sessionId 仅记录不使用
  void sessionId;

  const args = ['run', message];
  try {
    const result = spawnSync('trae-cli', args, {
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
