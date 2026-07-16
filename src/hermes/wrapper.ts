/**
 * Hermes CLI 链式 wrapper（核心创新）
 *
 * HermesController 封装 hermes CLI 的链式调用能力：
 *   - launch: 通过 hermes chat -q 启动新 session
 *   - inject: 通过 hermes chat --resume 中途注入消息到正在运行的 session
 *   - interrupt: 中断正在运行的 session（Hermes CLI 无直接命令，通过进程信号）
 *   - getStream: 实时读取 session 消息流（轮询 state.db 或 tail JSONL）
 *   - listSessions: 列出所有 session
 *   - extractSession: 提取 session 完整内容为中性格式
 *   - transferSession: 将 session 转换为可转交给其他 agent 的 handoff 包
 *
 * 真实 CLI 能力（实测 2026-07）：
 *   - hermes chat -q "prompt" --pass-session-id -Q：非交互单次查询，输出含 session id
 *   - hermes chat --resume <sessionId> -q "msg" -Q：恢复 session 并注入消息
 *   - hermes chat --continue [name]：按名称恢复最近 session
 *   - 无独立 hermes interrupt / hermes inject 命令（回退到主 help）
 *   - hermes sessions list/stats/export：session 管理子命令
 *   - --output stream-json：流式 JSON 输出（任务描述提及，实测 -Q quiet 模式更稳定）
 *
 * 中途介入机制：
 *   - Hermes 内部有 _interrupt_requested 标志（agent loop 每轮检查）
 *   - CLI 层面：对 hermes chat 进程发 SIGINT 可触发优雅中断
 *   - 注入消息：hermes chat --resume 是恢复已结束 session 的方式；
 *     对正在运行的 session，Hermes 通过 gateway 平台 API 实时注入（非 CLI）
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** 默认 Hermes home 目录 */
const DEFAULT_HERMES_HOME = path.join(os.homedir(), '.hermes');

/** hermes CLI 二进制名 */
const HERMES_BIN = 'hermes';

/** 启动选项 */
export interface LaunchOptions {
  /** 模型（如 glm-5.2、claude-opus-4-7），默认用 Hermes 配置 */
  model?: string;
  /** provider（如 custom/openai/auto） */
  provider?: string;
  /** 预加载 skill 列表 */
  skills?: string[];
  /** 工作目录 */
  cwd?: string;
  /** 超时毫秒，默认 120000 (2min) */
  timeoutMs?: number;
  /** 附加环境变量 */
  env?: Record<string, string>;
}

/** 启动结果 */
export interface LaunchResult {
  /** Hermes session id（如 20260715_103022_a1b2c3） */
  sessionId: string;
  /** assistant 的最终响应文本 */
  response: string;
  /** 完整 stdout */
  stdout: string;
  /** stderr */
  stderr: string;
  /** 退出码 */
  exitCode: number;
}

/** session 摘要（listSessions 用） */
export interface HermesSessionSummary {
  /** session id */
  id: string;
  /** 来源标签（cli/feishu/acp/subagent） */
  source: string | null;
  /** 模型 */
  model: string | null;
  /** 工作目录 */
  cwd: string | null;
  /** 标题 */
  title: string | null;
  /** 父 session id（subagent 时有值） */
  parentSessionId: string | null;
  /** 消息数 */
  messageCount: number;
  /** 开始时间 epoch 毫秒 */
  startedAt: number;
  /** 最近活动 epoch 毫秒 */
  lastActiveAt: number;
  /** 是否 archived */
  archived: boolean;
}

/** 中性消息格式（用于 session 转交） */
export interface NeutralMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

/** session 提取结果（中性格式） */
export interface ExtractedSession {
  /** 来源 CLI */
  source: 'hermes';
  /** Hermes session id */
  sessionId: string;
  /** 模型 */
  model: string | null;
  /** 工作目录 */
  cwd: string | null;
  /** 拓扑 */
  topology: 'root' | 'subagent';
  /** 父 session id */
  parentSessionId: string | null;
  /** 开始时间 epoch 毫秒 */
  startedAt: number;
  /** 消息列表（中性格式） */
  messages: NeutralMessage[];
  /** 元数据 */
  metadata: {
    messageCount: number;
    toolCallCount: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
  };
}

/** 转交包（transferSession 输出） */
export interface TransferPackage {
  /** 源 CLI 标识 */
  sourceCli: 'hermes';
  /** 目标 CLI 标识 */
  targetCli: string;
  /** session 提取内容 */
  session: ExtractedSession;
  /** 转交提示词（可直接喂给目标 CLI） */
  handoffPrompt: string;
  /** 生成时间 */
  generatedAt: number;
}

/** Hermes home 目录解析 */
export function resolveHermesHome(hermesHome?: string): string {
  return hermesHome ?? DEFAULT_HERMES_HOME;
}

/**
 * HermesController —— Hermes CLI 链式 wrapper。
 *
 * 用法：
 *   const ctrl = new HermesController();
 *   const result = await ctrl.launch("写一个 hello world");
 *   await ctrl.inject(result.sessionId, "改成 TypeScript");
 *   const session = ctrl.extractSession(result.sessionId);
 *   const pkg = ctrl.transferSession(result.sessionId, 'codex');
 */
export class HermesController {
  private readonly hermesHome: string;
  private readonly dbPath: string;
  /** 正在运行的 hermes 进程：sessionId → ChildProcess */
  private readonly runningProcesses = new Map<string, ChildProcess>();

  constructor(opts: { hermesHome?: string; dbPath?: string } = {}) {
    this.hermesHome = resolveHermesHome(opts.hermesHome);
    this.dbPath = opts.dbPath ?? path.join(this.hermesHome, 'state.db');
  }

  /**
   * 启动一个新 Hermes session：通过 hermes chat -q 非交互单次查询。
   * --pass-session-id 使 session id 出现在输出中；-Q quiet 模式只输出最终响应。
   * 返回 session id 与响应。
   */
  launch(prompt: string, opts: LaunchOptions = {}): LaunchResult {
    const args = ['chat', '-q', prompt, '--pass-session-id', '-Q'];
    if (opts.model) {
      args.push('-m', opts.model);
    }
    if (opts.provider) {
      args.push('--provider', opts.provider);
    }
    if (opts.skills && opts.skills.length > 0) {
      args.push('-s', opts.skills.join(','));
    }

    const result = spawnSync(HERMES_BIN, args, {
      cwd: opts.cwd ?? process.cwd(),
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 120_000,
      env: { ...process.env, ...opts.env },
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const exitCode = result.status ?? -1;

    // 从输出中提取 session id（格式：YYYYMMDD_HHMMSS_<hex>）
    const sessionId = this.extractSessionIdFromOutput(stdout, stderr);

    return {
      sessionId,
      response: stdout.trim(),
      stdout,
      stderr,
      exitCode,
    };
  }

  /**
   * 异步启动 session（返回 ChildProcess，可用于流式读取输出或后续 interrupt）。
   * 适合长任务：launch 后可用 getStream 轮询，用 interrupt 中断。
   */
  launchAsync(prompt: string, opts: LaunchOptions = {}): { process: ChildProcess; promise: Promise<LaunchResult> } {
    const args = ['chat', '-q', prompt, '--pass-session-id', '-Q'];
    if (opts.model) args.push('-m', opts.model);
    if (opts.provider) args.push('--provider', opts.provider);
    if (opts.skills && opts.skills.length > 0) args.push('-s', opts.skills.join(','));

    const child = spawn(HERMES_BIN, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeoutMs = opts.timeoutMs ?? 120_000;
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const promise = new Promise<LaunchResult>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        const sessionId = this.extractSessionIdFromOutput(stdout, stderr);
        // 从 runningProcesses 中清理
        if (sessionId) this.runningProcesses.delete(sessionId);
        resolve({
          sessionId,
          response: stdout.trim(),
          stdout,
          stderr,
          exitCode: code ?? -1,
        });
      });
    });

    // 暂存进程，便于后续 interrupt（session id 在完成前未知，用 pid 临时标识）
    return { process: child, promise };
  }

  /**
   * 中途注入消息到 session：通过 hermes chat --resume 恢复并追加查询。
   * 注意：对已结束的 session 恢复追加；对正在运行的 session，
   * Hermes 通过 gateway 平台 API 实时注入（CLI 层无直接 inject 命令）。
   */
  inject(sessionId: string, message: string, opts: { timeoutMs?: number; cwd?: string } = {}): LaunchResult {
    const args = ['chat', '--resume', sessionId, '-q', message, '-Q'];
    const result = spawnSync(HERMES_BIN, args, {
      cwd: opts.cwd ?? process.cwd(),
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      sessionId,
      response: (result.stdout ?? '').trim(),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status ?? -1,
    };
  }

  /**
   * 中断正在运行的 session。
   * Hermes CLI 无独立 interrupt 命令；通过对 hermes chat 进程发 SIGINT 实现优雅中断
   *（Hermes agent loop 每轮检查 _interrupt_requested 标志）。
   *
   * @param pid hermes 进程的 PID（由 launchAsync 返回的 ChildProcess.pid 获取）
   * @returns 是否成功发送信号
   */
  interrupt(pid: number): boolean {
    try {
      process.kill(pid, 'SIGINT');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 按 session id 中断（需要先用 launchAsync 启动并记录 pid）。
   * 如果 session id 对应的进程在 runningProcesses 中，发 SIGINT。
   */
  interruptSession(sessionId: string): boolean {
    const child = this.runningProcesses.get(sessionId);
    if (!child || child.pid === undefined) return false;
    return this.interrupt(child.pid);
  }

  /**
   * 获取 session 的实时消息流：轮询 state.db 读取该 session 的最新消息。
   * 返回当前全部消息（调用方可对比上次结果检测增量）。
   *
   * Hermes 实时将消息写入 state.db，故轮询 DB 是获取实时流的最可靠方式。
   * JSONL 文件（~/.hermes/sessions/*.jsonl）只对部分 session 存在，作为备选。
   */
  getStream(sessionId: string): NeutralMessage[] {
    if (!fs.existsSync(this.dbPath)) {
      // 回退：尝试读 JSONL 文件
      return this.readJsonlFile(sessionId);
    }
    return this.readMessagesFromDb(sessionId);
  }

  /**
   * 列出所有 session：优先读 state.db（权威源），无 DB 时回退扫描 JSONL 目录。
   */
  listSessions(): HermesSessionSummary[] {
    if (fs.existsSync(this.dbPath)) {
      return this.listSessionsFromDb();
    }
    return this.listSessionsFromJsonl();
  }

  /**
   * 提取 session 完整内容为中性格式：读 state.db 的 session + messages。
   * 中性格式可被 transferSession 转换为任意目标 CLI 的输入。
   */
  extractSession(sessionId: string): ExtractedSession | null {
    if (!fs.existsSync(this.dbPath)) {
      // 回退：读 JSONL 文件
      const messages = this.readJsonlFile(sessionId);
      if (messages.length === 0) return null;
      return {
        source: 'hermes',
        sessionId,
        model: null,
        cwd: null,
        topology: 'root',
        parentSessionId: null,
        startedAt: 0,
        messages,
        metadata: {
          messageCount: messages.length,
          toolCallCount: null,
          inputTokens: null,
          outputTokens: null,
          estimatedCostUsd: null,
        },
      };
    }
    return this.extractSessionFromDb(sessionId);
  }

  /**
   * 将 session 转换为转交包：提取 + 生成 handoff 提示词，可直接喂给目标 CLI。
   *
   * handoffPrompt 格式：包含 session 元数据 + 历史消息摘要 + 任务延续指令，
   * 目标 agent（如 codex/claude）接收后可无缝接续任务。
   */
  transferSession(sessionId: string, targetCli: string): TransferPackage | null {
    const session = this.extractSession(sessionId);
    if (!session) return null;

    const handoffPrompt = this.buildHandoffPrompt(session, targetCli);

    return {
      sourceCli: 'hermes',
      targetCli,
      session,
      handoffPrompt,
      generatedAt: Date.now(),
    };
  }

  /** 注册一个正在运行的进程（sessionId → ChildProcess），供 interruptSession 使用 */
  registerRunningProcess(sessionId: string, child: ChildProcess): void {
    this.runningProcesses.set(sessionId, child);
    child.on('close', () => {
      this.runningProcesses.delete(sessionId);
    });
  }

  // ─── 私有实现 ──────────────────────────────────────────────────────

  /** 从 hermes 输出中提取 session id（格式 YYYYMMDD_HHMMSS_<hex>） */
  private extractSessionIdFromOutput(stdout: string, stderr: string): string {
    const combined = stdout + '\n' + stderr;
    // Hermes --pass-session-id 通常在输出中含 "Session ID:" 或直接是 id 格式
    const idPattern = /\b(\d{8}_\d{6}_[0-9a-f]+)\b/;
    const match = combined.match(idPattern);
    return match ? match[1]! : '';
  }

  /** 从 state.db 读取 session 的消息（中性格式） */
  private readMessagesFromDb(sessionId: string): NeutralMessage[] {
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      const stmt = db.prepare(
        `SELECT role, content, timestamp FROM messages
         WHERE session_id = ? AND active = 1
         ORDER BY timestamp ASC, id ASC`,
      );
      const out: NeutralMessage[] = [];
      for (const row of stmt.all(sessionId) as Array<{ role: string; content: string | null; timestamp: number }>) {
        if (row.role !== 'user' && row.role !== 'assistant') continue;
        if (typeof row.content !== 'string' || row.content.trim().length === 0) continue;
        out.push({
          role: row.role as 'user' | 'assistant',
          content: row.content,
          timestamp: Math.round(row.timestamp * 1000),
        });
      }
      return out;
    } finally {
      db.close();
    }
  }

  /** 从 state.db 提取完整 session（含元数据） */
  private extractSessionFromDb(sessionId: string): ExtractedSession | null {
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      const sessionRow = db.prepare(
        `SELECT id, source, model, cwd, parent_session_id, started_at, ended_at,
                message_count, tool_call_count, input_tokens, output_tokens,
                estimated_cost_usd
         FROM sessions WHERE id = ?`,
      ).get(sessionId) as {
        id: string; source: string | null; model: string | null; cwd: string | null;
        parent_session_id: string | null; started_at: number; ended_at: number | null;
        message_count: number; tool_call_count: number | null;
        input_tokens: number | null; output_tokens: number | null;
        estimated_cost_usd: number | null;
      } | undefined;

      if (!sessionRow) return null;

      const messages = this.readMessagesFromDb(sessionId);
      const topology: 'root' | 'subagent' =
        sessionRow.parent_session_id !== null && sessionRow.parent_session_id.length > 0
          ? 'subagent'
          : 'root';

      return {
        source: 'hermes',
        sessionId: sessionRow.id,
        model: sessionRow.model,
        cwd: sessionRow.cwd,
        topology,
        parentSessionId: sessionRow.parent_session_id,
        startedAt: Math.round(sessionRow.started_at * 1000),
        messages,
        metadata: {
          messageCount: sessionRow.message_count,
          toolCallCount: sessionRow.tool_call_count,
          inputTokens: sessionRow.input_tokens,
          outputTokens: sessionRow.output_tokens,
          estimatedCostUsd: sessionRow.estimated_cost_usd,
        },
      };
    } finally {
      db.close();
    }
  }

  /** 从 state.db 列出所有 session */
  private listSessionsFromDb(): HermesSessionSummary[] {
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      const stmt = db.prepare(
        `SELECT id, source, model, cwd, parent_session_id, started_at, ended_at,
                message_count, title, archived
         FROM sessions
         WHERE archived = 0
         ORDER BY started_at DESC
         LIMIT 500`,
      );
      const out: HermesSessionSummary[] = [];
      for (const row of stmt.all() as Array<{
        id: string; source: string | null; model: string | null; cwd: string | null;
        parent_session_id: string | null; started_at: number; ended_at: number | null;
        message_count: number; title: string | null; archived: number;
      }>) {
        out.push({
          id: row.id,
          source: row.source,
          model: row.model,
          cwd: row.cwd,
          title: row.title,
          parentSessionId: row.parent_session_id,
          messageCount: row.message_count,
          startedAt: Math.round(row.started_at * 1000),
          lastActiveAt: row.ended_at ? Math.round(row.ended_at * 1000) : Math.round(row.started_at * 1000),
          archived: row.archived === 1,
        });
      }
      return out;
    } finally {
      db.close();
    }
  }

  /** 回退：从 JSONL 文件列出 session */
  private listSessionsFromJsonl(): HermesSessionSummary[] {
    const sessionsDir = path.join(this.hermesHome, 'sessions');
    const out: HermesSessionSummary[] = [];
    if (!fs.existsSync(sessionsDir)) return out;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      // 文件名格式：YYYYMMDD_HHMMSS_<hex>.jsonl
      const base = e.name.slice(0, -6); // 去 .jsonl
      const stat = fs.statSync(path.join(sessionsDir, e.name));
      out.push({
        id: base,
        source: 'cli',
        model: null,
        cwd: null,
        title: null,
        parentSessionId: null,
        messageCount: 0,
        startedAt: stat.mtimeMs,
        lastActiveAt: stat.mtimeMs,
        archived: false,
      });
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** 回退：读 JSONL 文件的消息 */
  private readJsonlFile(sessionId: string): NeutralMessage[] {
    const filePath = path.join(this.hermesHome, 'sessions', `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const out: NeutralMessage[] = [];
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { role?: string; content?: string; timestamp?: string };
        if (!obj.role || !obj.content) continue;
        if (obj.role !== 'user' && obj.role !== 'assistant') continue;
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : undefined;
        out.push({
          role: obj.role as 'user' | 'assistant',
          content: obj.content,
          timestamp: ts !== undefined && !isNaN(ts) ? ts : undefined,
        });
      } catch {
        // 脏行跳过
      }
    }
    return out;
  }

  /**
   * 构建 handoff 提示词：把 Hermes session 的历史消息浓缩为一段文本，
   * 目标 agent 接收后可接续任务。格式参考 ymesh handoff 的 compacted summary。
   */
  private buildHandoffPrompt(session: ExtractedSession, targetCli: string): string {
    const lines: string[] = [];
    lines.push(`# Session Handoff: Hermes → ${targetCli}`);
    lines.push('');
    lines.push(`## Session Metadata`);
    lines.push(`- Source: Hermes Agent`);
    lines.push(`- Session ID: ${session.sessionId}`);
    if (session.model) lines.push(`- Model: ${session.model}`);
    if (session.cwd) lines.push(`- Working Directory: ${session.cwd}`);
    lines.push(`- Topology: ${session.topology}`);
    if (session.parentSessionId) lines.push(`- Parent Session: ${session.parentSessionId}`);
    lines.push(`- Messages: ${session.metadata.messageCount}`);
    if (session.metadata.toolCallCount !== null) {
      lines.push(`- Tool Calls: ${session.metadata.toolCallCount}`);
    }
    lines.push('');

    // 历史消息：全部包含（目标 agent 需要完整上下文）
    lines.push(`## Conversation History`);
    lines.push('');
    for (const msg of session.messages) {
      const ts = msg.timestamp ? new Date(msg.timestamp).toISOString().slice(0, 19) : '';
      lines.push(`### ${msg.role.toUpperCase()}${ts ? ` (${ts})` : ''}`);
      lines.push(msg.content);
      lines.push('');
    }

    lines.push(`## Task Continuation`);
    lines.push(`You are taking over a task from Hermes Agent. The conversation above is the full context.`);
    lines.push(`Continue the task as the user's assistant. Do not re-introduce yourself.`);
    lines.push('');

    return lines.join('\n');
  }
}
