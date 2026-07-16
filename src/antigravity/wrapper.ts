/**
 * Antigravity CLI Wrapper（agy v1.1.2）
 *
 * 封装 agy CLI 的任务接入操作。agy v1.1.2 的实际能力（实测）：
 *   - 全局标志：--continue（恢复最近会话）、--conversation <id>（指定会话）
 *   - 子命令：agent / agents / changelog / help / install / models / plugin / plugins / update
 *   - 无 sessions 子命令（与规格不同，已修正）
 *
 * 因此 wrapper 采用：
 *   - launch：不带 --continue / --conversation 启动新会话（agy <prompt>）
 *   - inject：--conversation <id> 续跑指定会话
 *   - resumeLast：--continue 恢复最近会话
 *   - listSessions：直接读 conversation_summaries.db（agy CLI 无 list 子命令）
 *   - exportSession：直接读 transcript.jsonl（agy CLI 无 export 子命令）
 *
 * 设计原则：
 *   - 零外部依赖，使用 node:child_process spawnSync
 *   - 默认非交互（print 模式），交互式需调用方显式指定
 *   - GLM-5.2 ❌：Antigravity 硬绑 Google OAuth，wrapper 无法切换模型；
 *     但 session 可被提取用于 handoff（见 exportSession）。
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** Wrapper 配置 */
export interface AntigravityWrapperOptions {
  /** agy 可执行文件路径，默认从 PATH 查找 'agy' */
  agyBin?: string;
  /** 默认工作目录 */
  cwd?: string;
  /** 额外环境变量 */
  env?: Record<string, string>;
  /** 超时毫秒，默认 120000（2 分钟） */
  timeoutMs?: number;
  /** conversation_summaries.db 路径（用于 listSessions） */
  dbPath?: string;
}

/** 命令执行结果 */
export interface AgyResult<T = unknown> {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  data?: T;
  error?: string;
}

/** launch 新会话输入 */
export interface AgyLaunchInput {
  /** 初始指令；提供时用 agy <prompt> 非交互执行 */
  initialPrompt?: string;
  /** 工作目录，默认 wrapper cwd */
  cwd?: string;
  /** agent 名称（agy agents 列出可选 agent） */
  agent?: string;
}

/** launch 新会话结果 */
export interface AgyLaunchedSession {
  /** agy 输出（非交互模式）或空（交互模式） */
  output: string;
  /** 是否为交互式启动 */
  interactive: boolean;
}

/** 简化会话列表项 */
export interface AgySessionListItem {
  conversationId: string;
  title: string | null;
  status: string | null;
  agentName: string | null;
  lastModified: number | null;
  parentConversationId: string | null;
  nestingDepth: number | null;
}

/** 解析 agy bin 路径 */
function resolveAgyBin(opts: AntigravityWrapperOptions): string {
  return opts.agyBin ?? process.env.AGY_BIN ?? 'agy';
}

/** 解析 conversation_summaries.db 路径 */
function resolveDbPath(opts: { dbPath?: string }): string {
  if (opts.dbPath) return opts.dbPath;
  const dataDir = process.env.ANTIGRAVITY_DATA_DIR ?? path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Google',
    'Antigravity',
  );
  return path.join(dataDir, 'conversation_summaries.db');
}

/**
 * Antigravity CLI wrapper。
 *
 * 用法：
 *   const cli = new AntigravityCliWrapper({ cwd: '/repo' });
 *   await cli.launch({ initialPrompt: 'hello' });
 */
export class AntigravityCliWrapper {
  private readonly agyBin: string;
  private readonly defaultCwd?: string;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly dbPath: string;

  constructor(options: AntigravityWrapperOptions = {}) {
    this.agyBin = resolveAgyBin(options);
    this.defaultCwd = options.cwd;
    this.env = options.env ?? {};
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.dbPath = resolveDbPath({ dbPath: options.dbPath });
  }

  /**
   * 启动一个新会话。
   * - 提供 initialPrompt：用 `agy <prompt>` 非交互执行（agy 默认 print 模式）
   * - 未提供：用 `agy` 启动交互式（spawnSync 不等待输入）
   *
   * 注意：Antigravity 硬绑 Google OAuth，启动前需先 agy install / agy login
   * （OAuth 流程由用户在 IDE 内完成，wrapper 不处理鉴权）。
   */
  launch(input: AgyLaunchInput): AgyResult<AgyLaunchedSession> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    const cwd = input.cwd ?? this.defaultCwd;
    const args: string[] = [];

    if (input.agent) {
      args.push('--agent', input.agent);
    }

    if (input.initialPrompt !== undefined) {
      // 非交互：直接传 prompt
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

    // 交互式：agy 无参数启动
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
   * 向已存在会话注入消息（续跑）。
   * 用 `agy --conversation <id> <prompt>` 续跑指定会话。
   */
  inject(conversationId: string, message: string, opts: { cwd?: string } = {}): AgyResult {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    const cwd = opts.cwd ?? this.defaultCwd;
    const args = ['--conversation', conversationId, message];
    return this.runSync(args, cwd, env);
  }

  /** 恢复最近会话（agy --continue） */
  resumeLast(opts: { cwd?: string } = {}): AgyResult {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    const cwd = opts.cwd ?? this.defaultCwd;
    return this.runSync(['--continue'], cwd, env);
  }

  /**
   * 列出所有会话。
   * agy CLI v1.1.2 无 sessions 子命令，直接读 conversation_summaries.db。
   * 只读访问，绝不写入。
   */
  listSessions(): AgyResult<AgySessionListItem[]> {
    if (!fs.existsSync(this.dbPath)) {
      return {
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: `conversation_summaries.db 不存在: ${this.dbPath}`,
        error: 'db not found',
      };
    }
    let db: DatabaseSyncType;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
    } catch (e) {
      return {
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: `打开 DB 失败: ${e instanceof Error ? e.message : String(e)}`,
        error: 'db open failed',
      };
    }
    try {
      const stmt = db.prepare(
        `SELECT conversation_id, title, status, agent_name, last_modified_time,
                parent_conversation_id, nesting_depth
         FROM conversation_summaries
         ORDER BY last_modified_time DESC`,
      );
      const rawRows = stmt.all() as Array<Record<string, unknown>>;
      // 映射 snake_case → camelCase
      const rows: AgySessionListItem[] = rawRows.map((r) => ({
        conversationId: String(r.conversation_id ?? ''),
        title: (r.title as string | null) ?? null,
        status: (r.status as string | null) ?? null,
        agentName: (r.agent_name as string | null) ?? null,
        lastModified: (r.last_modified_time as number | null) ?? null,
        parentConversationId: (r.parent_conversation_id as string | null) ?? null,
        nestingDepth: (r.nesting_depth as number | null) ?? null,
      }));
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify(rows),
        stderr: '',
        data: rows,
      };
    } catch (e) {
      return {
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: `查询失败: ${e instanceof Error ? e.message : String(e)}`,
        error: 'query failed',
      };
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 导出会话为 handoff 包（transcript.jsonl 原文 + DB 元数据）。
   * 用于跨 agent 转交——把 Antigravity session 提取后交给其他支持 GLM-5.2 的 agent。
   *
   * 注意：Antigravity 硬绑 Google OAuth，无法在 wrapper 内切换 GLM-5.2；
   * 但 session 内容可被提取，交由 OpenHands/Goose/Claude Code 接力。
   */
  exportSession(conversationId: string): AgyResult<{
    conversationId: string;
    transcript: string;
    transcriptPath: string | null;
    metadata: Record<string, unknown> | null;
  }> {
    // 1. 从 DB 读元数据
    let db: DatabaseSyncType | null = null;
    let metadata: Record<string, unknown> | null = null;
    let appDataDir: string | null = null;
    if (fs.existsSync(this.dbPath)) {
      try {
        db = new DatabaseSync(this.dbPath, { readOnly: true });
        const row = db
          .prepare(
            `SELECT * FROM conversation_summaries WHERE conversation_id = ?`,
          )
          .get(conversationId) as Record<string, unknown> | undefined;
        if (row) {
          metadata = row;
          appDataDir = (row.app_data_dir as string | null) ?? null;
        }
      } catch {
        /* 忽略，仍尝试读 transcript */
      } finally {
        try {
          db?.close();
        } catch {
          /* ignore */
        }
      }
    }

    // 2. 读 transcript.jsonl
    let transcript = '';
    let transcriptPath: string | null = null;
    if (appDataDir) {
      const p = path.join(appDataDir, 'transcript.jsonl');
      if (fs.existsSync(p)) {
        try {
          transcript = fs.readFileSync(p, 'utf-8');
          transcriptPath = p;
        } catch {
          /* 忽略 */
        }
      }
    }

    if (!metadata && !transcript) {
      return {
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: `会话 ${conversationId} 既无 DB 元数据也无 transcript`,
        error: 'session not found',
      };
    }

    return {
      ok: true,
      exitCode: 0,
      stdout: transcript,
      stderr: '',
      data: { conversationId, transcript, transcriptPath, metadata },
    };
  }

  /** 列出可用 agents（agy agents） */
  listAgents(): AgyResult<string[]> {
    const res = this.runSync(['agents'], this.defaultCwd, { ...process.env, ...this.env });
    if (!res.ok) return res as AgyResult<string[]>;
    // 按行分割，去空行
    const agents = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return { ...res, data: agents };
  }

  /** 列出可用 models（agy models） */
  listModels(): AgyResult<string[]> {
    const res = this.runSync(['models'], this.defaultCwd, { ...process.env, ...this.env });
    if (!res.ok) return res as AgyResult<string[]>;
    const models = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return { ...res, data: models };
  }

  /** 探测 agy CLI 是否可用 */
  ping(): boolean {
    const res = this.runSync(['--version'], this.defaultCwd, { ...process.env, ...this.env });
    return res.ok;
  }

  // ─── 内部 ─────────────────────────────────────────────────────────────

  /** 同步执行 agy 命令；stdin 可选 */
  private runSync(
    args: string[],
    cwd: string | undefined,
    env: NodeJS.ProcessEnv,
    stdin?: string,
  ): AgyResult {
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
      const res = spawnSync(this.agyBin, args, opts);
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
