/**
 * Aider CLI 命令构造器（wrapper）
 *
 * Aider 无 MCP / Skills / Hooks，所有上下文注入与一次性交互都靠 CLI 参数。
 * 本模块把「跑一条 aider 消息」封装为可复用的 argv + env 构造，供：
 *   - 转交器（session-bridge）把前序 session 摘要作为 --message 喂给 aider
 *   - 自动化脚本以非交互模式驱动 aider
 *
 * GLM-5.2 接入（已验证可用）：
 *   OPENAI_API_KEY=<key> OPENAI_API_BASE=http://127.0.0.1:15721/v1 \
 *     aider --model openai/glm-5.2 --message "..." --no-git ...
 *
 * 关键开关（D1-D10 限制下的稳定非交互姿势）：
 *   --no-auto-commits   不自动 commit（避免污染仓库）
 *   --no-pretty         关闭 fancy 输出（dumb terminal 友好，解析稳定）
 *   --no-stream         不流式输出（一次性拿到完整回复）
 *   --yes-always        跳过所有交互确认
 *   --no-check-update   跳过更新检查
 *   --no-show-model-warnings  跳过未知模型告警
 *   --no-gitignore      可选：跳过 .gitignore 检查
 */

import { spawnSync } from 'node:child_process';

/** GLM-5.2 经 OpenAI 兼容协议接入时的默认 model 名（aider litellm 形式） */
export const GLM_MODEL_ARG = 'openai/glm-5.2';

/** GLM-5.2 本地代理默认 base url（与 trae-cli / 其他 agent 一致） */
export const GLM_DEFAULT_BASE_URL = 'http://127.0.0.1:15721/v1';

/** 构造 aider 命令的输入 */
export interface BuildAiderCommandOptions {
  /** 用户消息（一次性 --message 模式；与 interactive 二选一） */
  message?: string;
  /** 是否进入交互模式（不加 --message）。默认 false（非交互一次性） */
  interactive?: boolean;
  /** 模型 litellm 名，默认 openai/glm-5.2 */
  model?: string;
  /** 工作目录（aider 在该目录运行，决定 .aider.chat.history.md 落点） */
  cwd?: string;
  /** 只读注入文件（CONVENTIONS.md 等），通过 --read 传入 */
  readFiles?: string[];
  /** 是否禁用 git 操作（--no-git = 既不自动 commit 也不读 git 状态）。默认 true */
  noGit?: boolean;
  /** 附加 raw 参数（透传给 aider，不做校验） */
  extraArgs?: string[];
}

/** 构造结果 */
export interface AiderCommand {
  /** argv（不含 node / aider 可执行本身） */
  args: string[];
  /** 需要注入的环境变量（GLM-5.2 经 OpenAI 兼容协议） */
  env: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
}

/**
 * 构造一条 aider 命令。
 *
 * 默认姿势：非交互、GLM-5.2、关闭 git/pretty/stream/更新检查、跳过确认。
 * 调用方负责 spawn 并把 env 合并进 process.env。
 */
export function buildAiderCommand(opts: BuildAiderCommandOptions = {}): AiderCommand {
  const args: string[] = [];
  const env: Record<string, string> = {};

  // 模型：默认 GLM-5.2（OpenAI 兼容协议）
  const model = opts.model ?? GLM_MODEL_ARG;
  args.push('--model', model);

  // GLM-5.2 走 OpenAI 兼容协议时需 provider 前缀 openai/ + base url
  if (model.startsWith('openai/')) {
    env.OPENAI_API_BASE = process.env.OPENAI_API_BASE ?? GLM_DEFAULT_BASE_URL;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }

  // 只读注入文件
  if (opts.readFiles && opts.readFiles.length > 0) {
    for (const f of opts.readFiles) {
      args.push('--read', f);
    }
  }

  // 非交互一次性消息 vs 交互模式
  if (!opts.interactive) {
    const msg = opts.message ?? '';
    args.push('--message', msg);
  }

  // 稳定非交互开关
  args.push('--no-auto-commits', '--no-pretty', '--no-stream');
  args.push('--yes-always', '--no-check-update', '--no-show-model-warnings');

  // git 操作
  if (opts.noGit ?? true) {
    args.push('--no-git', '--no-gitignore');
  }

  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  return { args, env, cwd: opts.cwd };
}

/** inject 调用结果：response 是 agent 回复文本，exitCode 是进程退出码（0=成功） */
export interface AiderInjectResult {
  response: string;
  exitCode: number;
}

/**
 * 向 aider session 注入消息并同步取回回复。
 *
 * Aider 没有 session id 概念，session 连续性靠 cwd 下的 .aider.chat.history.md，
 * 因此 sessionId 参数实际不被使用，但保持签名一致以便统一调度。
 *
 * 实现方式：用 buildAiderCommand({ message }) 构造命令 + spawnSync 执行。
 * 返回 stdout 作为 response；若 spawnSync 抛错或 exitCode != 0，response 包含 stderr。
 */
export function inject(sessionId: string, message: string): AiderInjectResult {
  // aider 无 session id 概念，sessionId 仅用于签名一致
  void sessionId;

  const cmd = buildAiderCommand({ message });
  try {
    const result = spawnSync('aider', cmd.args, {
      encoding: 'utf-8',
      cwd: cmd.cwd,
      env: { ...process.env, ...cmd.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
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
