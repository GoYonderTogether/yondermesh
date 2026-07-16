/**
 * Continue CLI Wrapper
 *
 * 封装 Continue CLI（@continuedev/cli，二进制 `cn`，v1.5.47）的任务接入操作：
 *   - launch / inject / fork：通过 `cn` 启动、续跑、分叉会话
 *   - extractSession：从 ~/.continue/sessions/<uuid>.json 提取 session 入库
 *   - transferSession：把 Continue session 转交给目标 agent（中心化 store 即可读）
 *
 * cn CLI 关键参数（实测 cn --help）：
 *   cn [prompt]                          交互式新会话
 *   cn -p / --print <prompt>             非交互打印模式（适合管道）
 *   cn --format json                     headless 模式输出 JSON（需配合 -p）
 *   cn --silent                          去除 <think> 标签与多余空白（headless）
 *   cn --resume                          恢复最近会话
 *   cn --fork <sessionId>                从某 session id 分叉
 *   cn --config <path|slug>              指定配置
 *   cn --model <slug>                    指定模型（OpenAI 兼容 endpoint）
 *   cn --rule <path|slug|content>        追加 rule（可多次）
 *   cn --mcp <slug>                      追加 MCP server（owner/package slug）
 *   cn --allow / --ask / --exclude <tool> 工具权限覆盖
 *   cn --readonly                        plan mode（只读工具）
 *   cn --auto                            全部工具放行
 *   cn --agent <slug>                    加载 hub agent
 *   cn ls [--json]                       列出最近 session
 *
 * 设计原则：
 *   - 零外部依赖，使用 node:child_process spawnSync
 *   - 默认非交互（-p / --print），交互式需调用方显式指定
 *   - 与 goose/wrapper.ts 风格一致
 *   - GLM-5.2 通过 config.yaml models 段或 --model 参数接入（不在 wrapper 注入）
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultDataDir } from '../daemon/config.js';
import { SessionStore } from '../store/session-store.js';
import { ContinueImporter, CONTINUE_SESSIONS_DIR } from './importer.js';

/** ymesh 管理的事件日志（审计 / 活跃度统计） */
export const CONTINUE_EVENTS_FILE = path.join(defaultDataDir(), 'cli-events.ndjsonl');

/** Wrapper 配置 */
export interface ContinueWrapperOptions {
  /** cn 可执行文件路径，默认从 PATH 查找 'cn'（可由 CONTINUE_BIN 环境变量覆盖） */
  cnBin?: string;
  /** 默认工作目录 */
  cwd?: string;
  /** 额外环境变量 */
  env?: Record<string, string>;
  /** 超时毫秒，默认 120000（2 分钟） */
  timeoutMs?: number;
}

/** 命令执行结果 */
export interface ContinueCliResult<T = unknown> {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 解析后的数据（若适用） */
  data?: T;
  error?: string;
}

/** launch 新会话输入 */
export interface ContinueLaunchInput {
  /** 初始指令；提供时用 `cn -p` 非交互执行，否则启动交互式 */
  initialPrompt?: string;
  /** 模型 slug（如 glm-4.6 的 hub slug），通过 --model 注入 */
  model?: string;
  /** 额外 rule（数组，每个对应一次 --rule） */
  rules?: string[];
  /** 额外 MCP server slug（数组，每个对应一次 --mcp） */
  mcpSlugs?: string[];
  /** 工作目录，默认 wrapper cwd */
  cwd?: string;
  /** 是否只读模式（plan mode） */
  readonly?: boolean;
  /** 是否自动放行所有工具 */
  auto?: boolean;
  /** headless 模式输出格式（仅 initialPrompt 时有效，默认 'text'） */
  format?: 'text' | 'json';
  /** 是否去除 <think> 标签（仅 headless 模式有效） */
  silent?: boolean;
}

/** launch 新会话结果 */
export interface ContinueLaunchedSession {
  /** cn 输出（非交互模式）或空（交互模式） */
  output: string;
  /** 是否为交互式启动 */
  interactive: boolean;
}

/** inject（续跑）输入 */
export interface ContinueInjectInput {
  /** 续跑消息内容 */
  message: string;
  /** 工作目录，默认 wrapper cwd */
  cwd?: string;
  /** 是否交互式续跑（true=--resume 交互；false=-p --resume 非交互） */
  interactive?: boolean;
  /** headless 输出格式（仅非交互式有效） */
  format?: 'text' | 'json';
  /** 是否去除 <think> 标签（仅 headless 有效） */
  silent?: boolean;
}

/** 单个 session 摘要（来自 `cn ls --json`） */
export interface ContinueSessionListItem {
  id: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  workspacePath?: string;
  model?: string;
  provider?: string;
}

/** 提取单个 session 的结果 */
export interface ContinueExtractResult {
  /** ymesh 内部 session id（已入库则返回） */
  sessionId?: string;
  /** native continue session id */
  nativeSessionId: string;
  /** 提取到的消息数 */
  messageCount: number;
  /** 是否新创建（首次入库 true） */
  created: boolean;
}

/** 转交结果 */
export interface ContinueTransferResult {
  /** 源 ymesh session id */
  fromSessionId: string;
  /** 目标 agent 名 */
  toAgent: string;
  /** 转交到的 ymesh 内部 session id（同一 session，仅打 source 标记） */
  toSessionId: string;
  /** 转交的消息数 */
  messageCount: number;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 解析 cn bin 路径 */
function resolveCnBin(opts: ContinueWrapperOptions): string {
  return opts.cnBin ?? process.env.CONTINUE_BIN ?? 'cn';
}

/**
 * Continue CLI wrapper。
 *
 * 用法：
 *   const cli = new ContinueCliWrapper({ cwd: '/repo' });
 *   const res = cli.launch({ initialPrompt: 'hello', format: 'text' });
 */
export class ContinueCliWrapper {
  private readonly cnBin: string;
  private readonly defaultCwd?: string;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: ContinueWrapperOptions = {}) {
    this.cnBin = resolveCnBin(options);
    this.defaultCwd = options.cwd;
    this.env = options.env ?? {};
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /**
   * 启动一个新会话。
   * - 提供 initialPrompt：用 `cn -p <prompt>` 非交互执行（headless）
   * - 未提供：用 `cn` 启动交互式（spawnSync 不等待输入；真正交互需调用方接管 TTY）
   *
   * headless 模式（initialPrompt 提供时）可选：
   *   --format json / --silent / --model / --rule / --mcp / --readonly / --auto
   */
  launch(input: ContinueLaunchInput): ContinueCliResult<ContinueLaunchedSession> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    const cwd = input.cwd ?? this.defaultCwd;

    if (input.initialPrompt !== undefined) {
      // 非交互 headless：cn -p <prompt>
      const args = ['-p'];
      if (input.format === 'json') args.push('--format', 'json');
      if (input.silent) args.push('--silent');
      if (input.model) args.push('--model', input.model);
      if (input.readonly) args.push('--readonly');
      if (input.auto) args.push('--auto');
      for (const r of input.rules ?? []) args.push('--rule', r);
      for (const s of input.mcpSlugs ?? []) args.push('--mcp', s);
      args.push(input.initialPrompt);

      const res = this.runSync(args, cwd, env);
      return {
        ok: res.ok,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        error: res.error,
        data: { output: res.stdout, interactive: false },
      };
    }

    // 交互式：cn [prompt?]
    const args: string[] = [];
    if (input.model) args.push('--model', input.model);
    if (input.readonly) args.push('--readonly');
    if (input.auto) args.push('--auto');
    for (const r of input.rules ?? []) args.push('--rule', r);
    for (const s of input.mcpSlugs ?? []) args.push('--mcp', s);
    // 不传 prompt → 纯交互式启动
    const res = this.runSync(args, cwd, env);
    return {
      ok: res.ok,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      error: res.error,
      data: { output: res.stdout, interactive: true },
    };
  }

  /**
   * 向最近会话注入消息（统一签名）。
   *
   * 实现：spawnSync('cn', ['-p', '--resume', message])
   *   - cn CLI 不支持按 id resume，sessionId 参数仅记录，实际 resume 最近会话
   *   - response = stdout
   *   - exitCode = 子进程退出码
   *   - 超时沿用 wrapper 配置（默认 120s）
   */
  inject(sessionId: string, message: string): { response: string; exitCode: number } {
    void sessionId; // 当前 cn CLI 不支持按 id resume，仅按最近 session
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    // 非交互：cn -p --resume <message>
    const args = ['-p', '--resume', message];
    const res = this.runSync(args, this.defaultCwd, env);
    return { response: res.stdout, exitCode: res.exitCode };
  }

  /**
   * 分叉一个会话（从某 session id 复制为新会话）。
   * cn --fork <sessionId> [prompt?]
   *
   * 提供 prompt → 非交互 headless 分叉并立即发消息；
   * 不提供 prompt → 交互式分叉启动。
   */
  fork(
    sessionId: string,
    opts: {
      prompt?: string;
      cwd?: string;
      format?: 'text' | 'json';
      silent?: boolean;
      model?: string;
    } = {},
  ): ContinueCliResult {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    const cwd = opts.cwd ?? this.defaultCwd;
    const args: string[] = [];

    if (opts.prompt !== undefined) {
      args.push('-p');
      if (opts.format === 'json') args.push('--format', 'json');
      if (opts.silent) args.push('--silent');
    }
    if (opts.model) args.push('--model', opts.model);
    args.push('--fork', sessionId);
    if (opts.prompt !== undefined) args.push(opts.prompt);

    return this.runSync(args, cwd, env);
  }

  /**
   * 列出所有会话（cn ls --json）。
   * 返回解析后的 session 摘要数组；CLI 不可用 / 输出非 JSON → 返回空数组。
   */
  listSessions(): ContinueCliResult<ContinueSessionListItem[]> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    const res = this.runSync(['ls', '--json'], this.defaultCwd, env);
    if (!res.ok) return { ...res, data: [] };

    let items: ContinueSessionListItem[] = [];
    try {
      const parsed = JSON.parse(res.stdout);
      if (Array.isArray(parsed)) {
        items = parsed as ContinueSessionListItem[];
      } else if (parsed && Array.isArray((parsed as { sessions?: unknown }).sessions)) {
        items = (parsed as { sessions: ContinueSessionListItem[] }).sessions;
      }
    } catch {
      // 输出非 JSON → 返回空数组
    }
    return { ...res, data: items };
  }

  /** 探测 cn CLI 是否可用 */
  ping(): boolean {
    const res = this.runSync(['--version'], this.defaultCwd, {
      ...process.env,
      ...this.env,
    });
    return res.ok;
  }

  // ─── 内部 ─────────────────────────────────────────────────────────────

  /** 同步执行 cn 命令；stdin 可选 */
  private runSync(
    args: string[],
    cwd: string | undefined,
    env: NodeJS.ProcessEnv,
    stdin?: string,
  ): ContinueCliResult {
    const opts: SpawnSyncOptions = {
      cwd,
      env,
      timeout: this.timeoutMs,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    };
    if (stdin !== undefined) {
      opts.input = stdin;
    }
    try {
      const res = spawnSync(this.cnBin, args, opts);
      const ok = res.status === 0;
      return {
        ok,
        exitCode: res.status ?? -1,
        stdout: (res.stdout as string) ?? '',
        stderr: (res.stderr as string) ?? '',
        error: res.error?.message,
      };
    } catch (err) {
      return {
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * 提取单个 Continue session（按 nativeSessionId）。
 * 触发一次 ContinueImporter.import()（幂等），再从 store 查询目标 id。
 *
 * @param nativeSessionId Continue session id（UUID）
 * @param options 可选：sessions 目录、db 路径、设备 id
 */
export function extractSession(
  nativeSessionId: string,
  options: {
    sessionsDir?: string;
    sessionsIndex?: string;
    dbPath?: string;
    deviceId?: string;
  } = {},
): ContinueExtractResult {
  const dbPath = options.dbPath ?? path.join(defaultDataDir(), 'yondermesh.db');
  const store = new SessionStore(dbPath);
  try {
    const importer = new ContinueImporter(store, {
      sessionsDir: options.sessionsDir,
      sessionsIndex: options.sessionsIndex,
      deviceId: options.deviceId,
    });
    importer.import();
    const sessions = store.querySessions({
      source: 'continue',
      limit: 1_000_000,
    });
    const target = sessions.find((s) => s.nativeSessionId === nativeSessionId);
    return {
      sessionId: target?.id,
      nativeSessionId,
      messageCount: target?.messageCount ?? 0,
      created: target?.currentRevisionId === 1,
    };
  } finally {
    store.close();
  }
}

/**
 * 转交某 Continue session 到目标 agent。
 *
 * ymesh store 是中心化的：目标 agent 只需 query ymesh sessions by source='continue'
 * 即可拿到完整上下文。此函数额外在 events 日志中记录转交意图。
 */
export function transferSession(
  nativeSessionId: string,
  toAgent: string,
  options: {
    dbPath?: string;
    eventsFile?: string;
  } = {},
): ContinueTransferResult {
  const dbPath = options.dbPath ?? path.join(defaultDataDir(), 'yondermesh.db');
  const eventsFile = options.eventsFile ?? CONTINUE_EVENTS_FILE;
  const store = new SessionStore(dbPath);
  try {
    const sessions = store.querySessions({
      source: 'continue',
      limit: 1_000_000,
    });
    const target = sessions.find((s) => s.nativeSessionId === nativeSessionId);
    if (!target) {
      throw new Error(
        `Continue session ${nativeSessionId} 未在 ymesh store 中找到；请先调用 extractSession()`,
      );
    }
    const messages = store.getMessages(target.id);

    try {
      fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
      const line =
        JSON.stringify({
          ts: Date.now(),
          cli: 'continue',
          event: 'transferSession',
          fromSessionId: target.id,
          nativeSessionId,
          toAgent,
          messageCount: messages.length,
        }) + '\n';
      fs.appendFileSync(eventsFile, line, 'utf-8');
    } catch {
      // 写事件失败不阻止转交
    }

    return {
      fromSessionId: target.id,
      toAgent,
      toSessionId: target.id,
      messageCount: messages.length,
    };
  } finally {
    store.close();
  }
}

/** 检测 ~/.continue/ 目录是否存在（用于 wrapper 可用性判断） */
export function isContinueInstalled(): boolean {
  return fs.existsSync(CONTINUE_SESSIONS_DIR) || fs.existsSync(
    path.join(os.homedir(), '.continue'),
  );
}

/** 把未知对象归一化为错误消息（导出供外部使用） */
export { errorMessage as continueErrorMessage };
