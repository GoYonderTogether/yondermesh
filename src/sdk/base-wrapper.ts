/**
 * yondermesh Adapter SDK —— BaseWrapper 抽象基类
 *
 * 提供 CLI 链式 wrapper 的通用能力：CLI 子进程管理（同步/异步）、超时处理、
 * session 转交格式（NeutralSession → handoffPrompt）生成。
 *
 * 子类实现 agent-specific 的 launch / inject / interrupt / getStream /
 * listSessions / extractSession；transferSession 由基类提供（调用 extractSession
 * + buildHandoffPrompt）。
 *
 * 参考实现：src/hermes/wrapper.ts（HermesController）。
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import type {
  InjectResult,
  LaunchOptions,
  LaunchResult,
  NeutralSession,
  SessionSummary,
  StreamEvent,
  TransferPackage,
  Wrapper,
} from './types.js';

/**
 * BaseWrapper —— 通用 CLI wrapper 抽象基类。
 *
 * 用法：
 *   class MyWrapper extends BaseWrapper {
 *     readonly sourceCli = 'mycli';
 *     readonly cliBinary = 'mycli';
 *     async launch(prompt, opts) { /* spawnCliSync + extractSessionId *\/ }
 *     // ...
 *   }
 */
export abstract class BaseWrapper implements Wrapper {
  /** 正在运行的 CLI 进程：sessionId → ChildProcess（供 interrupt 用） */
  protected readonly runningProcesses = new Map<string, ChildProcess>();

  /** 来源 CLI 标识（如 'hermes'） */
  abstract readonly sourceCli: string;
  /** CLI 二进制名（如 'hermes'） */
  abstract readonly cliBinary: string;

  abstract launch(prompt: string, opts?: LaunchOptions): Promise<LaunchResult>;
  abstract inject(sessionId: string, message: string): Promise<InjectResult>;
  abstract interrupt(sessionId: string): Promise<void>;
  abstract getStream(sessionId: string): AsyncIterable<StreamEvent>;
  abstract listSessions(): SessionSummary[];
  abstract extractSession(sessionId: string): NeutralSession;

  /**
   * 转交 session 到目标 CLI：提取 + 生成 handoff 提示词。
   * 子类通常无需重写；若目标 CLI 需要特殊 handoff 格式可重写。
   */
  transferSession(sessionId: string, targetCli: string): TransferPackage {
    const session = this.extractSession(sessionId);
    return {
      sourceCli: this.sourceCli,
      targetCli,
      session,
      handoffPrompt: this.buildHandoffPrompt(session, targetCli),
      generatedAt: Date.now(),
    };
  }

  // ─── 子类可复用的受保护助手 ──────────────────────────────────────────

  /**
   * 同步启动 CLI 子进程并等待完成。适合短任务 / 一次性查询。
   * 返回归一化的 {stdout, stderr, exitCode}。
   */
  protected spawnCliSync(
    args: readonly string[],
    opts: LaunchOptions = {},
  ): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync(this.cliBinary, args, this.toSpawnSyncOptions(opts));
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status ?? -1,
    };
  }

  /**
   * 异步启动 CLI 子进程，返回 {process, promise}。
   * 适合长任务：调用方可注册 runningProcess 后用 getStream 轮询，用 interrupt 中断。
   * promise 在进程退出时 resolve（含完整 stdout/stderr/exitCode）。
   */
  protected spawnCliAsync(
    args: readonly string[],
    opts: LaunchOptions = {},
  ): { process: ChildProcess; promise: Promise<{ stdout: string; stderr: string; exitCode: number }> } {
    const child = spawn(this.cliBinary, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeoutMs = opts.timeoutMs ?? 120_000;
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const promise = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        stderr += `\n[spawn error] ${err.message}`;
        resolve({ stdout, stderr, exitCode: -1 });
      });
    });

    return { process: child, promise };
  }

  /**
   * 注册一个正在运行的进程（sessionId → ChildProcess），供 interruptSession 使用。
   * 进程退出时自动清理映射。
   */
  protected registerRunningProcess(sessionId: string, child: ChildProcess): void {
    this.runningProcesses.set(sessionId, child);
    child.on('close', () => {
      this.runningProcesses.delete(sessionId);
    });
  }

  /** 按 sessionId 中断正在运行的进程（发 SIGINT）。无映射返回 false。 */
  protected killRunningProcess(sessionId: string, signal: NodeJS.Signals = 'SIGINT'): boolean {
    const child = this.runningProcesses.get(sessionId);
    if (!child || child.pid === undefined) return false;
    try {
      process.kill(child.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 从 CLI 输出中提取 session id（用正则匹配）。
   * 子类提供具体 pattern（如 /\b(\d{8}_\d{6}_[0-9a-f]+)\b/）。
   */
  protected extractByPattern(stdout: string, stderr: string, pattern: RegExp): string | null {
    const combined = `${stdout}\n${stderr}`;
    const match = combined.match(pattern);
    return match ? (match[1] ?? match[0]) : null;
  }

  /**
   * 构建 handoff 提示词：把 NeutralSession 的历史消息浓缩为一段文本，
   * 目标 agent 接收后可接续任务。格式见 specs/adapter-spec.md §3.2。
   */
  protected buildHandoffPrompt(session: NeutralSession, targetCli: string): string {
    const lines: string[] = [];
    lines.push(`# Session Handoff: ${this.sourceCli} → ${targetCli}`);
    lines.push('');
    lines.push('## Session Metadata');
    lines.push(`- Source: ${this.sourceCli}`);
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
    lines.push('## Conversation History');
    lines.push('');
    for (const msg of session.messages) {
      const ts = msg.timestamp ? new Date(msg.timestamp).toISOString().slice(0, 19) : '';
      lines.push(`### ${msg.role.toUpperCase()}${ts ? ` (${ts})` : ''}`);
      lines.push(msg.content);
      lines.push('');
    }
    lines.push('## Task Continuation');
    lines.push(
      `You are taking over a task from ${this.sourceCli}. The conversation above is the full context.`,
    );
    lines.push(`Continue the task as the user's assistant. Do not re-introduce yourself.`);
    lines.push('');
    return lines.join('\n');
  }

  // ─── 内部实现 ────────────────────────────────────────────────────────

  private toSpawnSyncOptions(opts: LaunchOptions): SpawnSyncOptionsWithStringEncoding {
    return {
      cwd: opts.cwd ?? process.cwd(),
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 120_000,
      env: { ...process.env, ...opts.env },
      maxBuffer: 10 * 1024 * 1024,
    };
  }
}
