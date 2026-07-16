/**
 * Goose CLI Wrapper
 *
 * 封装 goose CLI（v1.43.0，Block）的任务接入操作：
 *   - launch / inject / resume / fork：通过 `goose session` 与 `goose run`
 *   - session 列表：`goose session list`
 *   - session 导出/导入：`goose session export` / `import`（用于跨 agent 转交）
 *
 * goose CLI 关键参数：
 *   goose session                    交互式新会话
 *   goose session --resume           恢复最近会话
 *   goose session --resume --name N  恢复具名会话
 *   goose session --resume --session-id ID  恢复指定 id
 *   goose session --fork             从某会话分叉（需 --resume）
 *   goose session --name N           以具名启动新会话
 *   goose run -<instruction>         从指令文件/stdin 执行（非交互）
 *   goose session list               列出所有会话
 *   goose session export <id>        导出会话为 JSON
 *
 * 设计原则：
 *   - 零外部依赖，使用 node:child_process spawnSync/execFileSync
 *   - 默认非交互（--print / run），交互式需调用方显式指定
 *   - GLM-5.2 通过 goose provider 配置（zhipu + ZHIPU_BASE_URL），不在 wrapper 注入
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

/** Wrapper 配置 */
export interface GooseWrapperOptions {
  /** goose 可执行文件路径，默认从 PATH 查找 'goose' */
  gooseBin?: string;
  /** 默认工作目录 */
  cwd?: string;
  /** 额外环境变量 */
  env?: Record<string, string>;
  /** 超时毫秒，默认 120000（2 分钟） */
  timeoutMs?: number;
}

/** 命令执行结果 */
export interface CliResult<T = unknown> {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 解析后的数据（若适用） */
  data?: T;
  error?: string;
}

/** launch 新会话输入 */
export interface GooseLaunchInput {
  /** 初始指令；提供时用 goose run 非交互执行，否则启动交互式 session */
  initialPrompt?: string;
  /** 具名会话 */
  name?: string;
  /** 工作目录，默认 wrapper cwd */
  cwd?: string;
  /** 模型 provider（如 zhipu），通过环境变量 GOOSE_MODEL 注入 */
  model?: string;
}

/** launch 新会话结果 */
export interface GooseLaunchedSession {
  /** goose run 输出（非交互模式）或空（交互模式） */
  output: string;
  /** 是否为交互式启动 */
  interactive: boolean;
}

/** 解析 goose bin 路径 */
function resolveGooseBin(opts: GooseWrapperOptions): string {
  return opts.gooseBin ?? process.env.GOOSE_BIN ?? 'goose';
}

/**
 * Goose CLI wrapper。
 *
 * 用法：
 *   const cli = new GooseCliWrapper({ cwd: '/repo' });
 *   await cli.launch({ initialPrompt: 'hello', model: 'zhipu' });
 */
export class GooseCliWrapper {
  private readonly gooseBin: string;
  private readonly defaultCwd?: string;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: GooseWrapperOptions = {}) {
    this.gooseBin = resolveGooseBin(options);
    this.defaultCwd = options.cwd;
    this.env = options.env ?? {};
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /**
   * 启动一个新会话。
   * - 提供 initialPrompt：用 `goose run -`（stdin 传入指令）非交互执行
   * - 未提供：用 `goose session --name` 启动交互式（spawnSync 不等待输入，
   *   仅返回启动状态；真正的交互需调用方接管 TTY）
   */
  launch(input: GooseLaunchInput): CliResult<GooseLaunchedSession> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    if (input.model) env.GOOSE_MODEL = input.model;
    const cwd = input.cwd ?? this.defaultCwd;

    if (input.initialPrompt !== undefined) {
      // 非交互：goose run -s（从 stdin 读指令）
      // goose run 支持 -t/--text 直接传指令；此处用 stdin 避免参数过长
      const args = ['run', '-s'];
      if (input.name) args.push('--name', input.name);
      const res = this.runSync(args, cwd, env, input.initialPrompt);
      return {
        ok: res.ok,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        error: res.error,
        data: { output: res.stdout, interactive: false },
      };
    }

    // 交互式：goose session --name N
    const args = ['session'];
    if (input.name) args.push('--name', input.name);
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
   * 向已存在会话注入消息（非交互续跑）。
   * 用 `goose session --resume --session-id ID` + stdin 指令。
   * 真正的交互式续跑需调用方接管 TTY；此处提供非交互形态。
   */
  inject(sessionId: string, message: string, opts: { cwd?: string; interactive?: boolean } = {}): CliResult {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    const cwd = opts.cwd ?? this.defaultCwd;
    if (opts.interactive) {
      const args = ['session', '--resume', '--session-id', sessionId];
      const res = this.runSync(args, cwd, env);
      return res;
    }
    // 非交互：用 run 带 --session-id（goose run 支持 --resume 语义）
    const args = ['run', '-s', '--resume', '--session-id', sessionId];
    const res = this.runSync(args, cwd, env, message);
    return res;
  }

  /** 恢复最近会话（交互式启动） */
  resumeLast(opts: { name?: string } = {}): CliResult {
    const args = ['session', '--resume'];
    if (opts.name) args.push('--name', opts.name);
    return this.runSync(args, this.defaultCwd, { ...process.env, ...this.env });
  }

  /**
   * 分叉一个会话（复制全部消息为新会话）。
   * goose session --fork --resume --session-id ID
   */
  fork(sessionId: string, opts: { name?: string; cwd?: string } = {}): CliResult {
    const args = ['session', '--fork', '--resume', '--session-id', sessionId];
    if (opts.name) args.push('--name', opts.name);
    return this.runSync(args, opts.cwd ?? this.defaultCwd, { ...process.env, ...this.env });
  }

  /**
   * 列出所有会话（goose session list）。
   * 返回原始 stdout（goose 输出表格/列表）。
   */
  listSessions(): CliResult {
    return this.runSync(['session', 'list'], this.defaultCwd, { ...process.env, ...this.env });
  }

  /**
   * 导出会话为 JSON（goose session export <id>）。
   * 用于跨 agent 转交——把 goose session 导出后交给其他 agent。
   */
  exportSession(sessionId: string): CliResult<unknown> {
    const res = this.runSync(
      ['session', 'export', sessionId],
      this.defaultCwd,
      { ...process.env, ...this.env },
    );
    if (!res.ok) return res;
    let data: unknown = undefined;
    try {
      data = JSON.parse(res.stdout);
    } catch {
      data = res.stdout;
    }
    return { ...res, data };
  }

  /** 探测 goose CLI 是否可用 */
  ping(): boolean {
    const res = this.runSync(['--version'], this.defaultCwd, { ...process.env, ...this.env });
    return res.ok;
  }

  // ─── 内部 ─────────────────────────────────────────────────────────────

  /** 同步执行 goose 命令；stdin 可选 */
  private runSync(
    args: string[],
    cwd: string | undefined,
    env: NodeJS.ProcessEnv,
    stdin?: string,
  ): CliResult {
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
      const res = spawnSync(this.gooseBin, args, opts);
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
