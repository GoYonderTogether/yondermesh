/**
 * Kimi Controller —— Wire 协议 + ACP + CLI 三通道 wrapper
 *
 * Kimi 缺失 D4（无 Skills）和 D10（无 Always-on），但拥有杀手级能力：
 * Wire 协议的 JSONRPCSteerMessage，可在运行中的 conversation 中途注入消息。
 *
 * 三个通道：
 *   1. ACP（Agent Control Protocol）：kimi acp 运行 JSON-RPC over stdio 服务器，
 *      可发送 JSONRPCSteerMessage 实现中途介入
 *   2. Wire 协议：wire.jsonl 记录事件流，JSONRPCSteerMessage 是 wire 协议的
 *      steering 消息类型，可中断/引导正在进行的 turn
 *   3. CLI：kimi -w <dir> --session <id> 启动/继续 session
 *
 * 五个能力：
 *   1. launch(prompt)        —— 通过 CLI 启动新 session
 *   2. inject(sessionId,msg) —— 通过 ACP JSONRPCSteerMessage 中途注入（杀手级）
 *   3. getStream(sessionId)  —— 读取 wire.jsonl 事件流
 *   4. extractSession(id)    —— 读取 context.jsonl 提取消息
 *   5. transferSession(id)   —— 转中性格式供其他 agent 接管
 *
 * 降级策略：ACP 不可用时降级到 CLI（inject 退化为新 turn）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { MessageRole, SessionMessageInput } from '../store/types.js';

/** 默认 Kimi 根目录 */
const DEFAULT_KIMI_DIR = path.join(os.homedir(), '.kimi');
/** 默认 CLI 可执行名 */
const DEFAULT_CLI = 'kimi';
/** sessions 子目录名 */
const SESSIONS_SEGMENT = 'sessions';
/** ACP 请求超时（毫秒） */
const ACP_TIMEOUT_MS = 30_000;

/** wrapper 选项 */
export interface KimiControllerOptions {
  /** Kimi 根目录，默认 ~/.kimi */
  rootPath?: string;
  /** CLI 可执行路径，默认 kimi */
  cliBin?: string;
}

/** launch 结果 */
export interface KimiLaunchResult {
  /** session id（native = sessionUuid） */
  sessionId: string;
  /** 工作目录 */
  workDir: string;
  /** 启动通道 */
  channel: 'cli';
  /** agent 回复 */
  reply?: string;
}

/** Wire 协议事件（从 wire.jsonl 解析） */
export interface WireEvent {
  /** 事件时间戳（epoch 秒，浮点） */
  timestamp: number;
  /** 事件类型（TurnBegin/StepBegin/ContentPart/ToolCall/ToolResult/StatusUpdate） */
  type: string;
  /** 事件负载 */
  payload: unknown;
}

/** JSONRPCSteerMessage 消息（中途注入） */
export interface SteerMessage {
  /** 注入的消息类型 */
  type: 'steer';
  /** 注入的文本 */
  text: string;
  /** 是否中断当前 turn */
  interrupt?: boolean;
}

/** 中性 session 格式 */
export interface KimiTransferredSession {
  source: 'kimi';
  sessionId: string;
  workDir?: string;
  messages: SessionMessageInput[];
}

/** ACP 客户端（管理 kimi acp 子进程） */
class AcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private readonly cliBin: string;

  constructor(cliBin: string) {
    this.cliBin = cliBin;
  }

  /** 启动 ACP 服务器子进程 */
  start(): void {
    if (this.proc) return;
    this.proc = spawn(this.cliBin, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (data: string) => this.onData(data));
    this.proc.on('error', () => { this.proc = null; });
    this.proc.on('exit', () => { this.proc = null; });
  }

  /** 停止 ACP 服务器 */
  stop(): void {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* noop */ }
      this.proc = null;
    }
  }

  /** 是否可用 */
  isRunning(): boolean {
    return this.proc !== null;
  }

  /** 发送 JSON-RPC 请求 */
  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.proc) this.start();
    if (!this.proc) {
      return Promise.reject(new Error('ACP 服务器不可用'));
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP 超时: ${method}`));
      }, ACP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.proc!.stdin.write(msg + '\n');
    });
  }

  /** 发送 JSONRPCSteerMessage（非请求模式，无需等待响应） */
  steer(sessionId: string, message: SteerMessage): void {
    if (!this.proc) this.start();
    if (!this.proc) return;
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method: 'JSONRPCSteerMessage',
      params: { sessionId, ...message },
    });
    this.proc.stdin.write(msg + '\n');
  }

  /** 处理 stdout 数据（Content-Length 分帧或换行分隔） */
  private onData(data: string): void {
    this.buffer += data;
    // 尝试按换行分隔解析（ACP 可能用 Content-Length 分帧，此处兼容两种）
    let idx: number;
    while ((idx = this.indexOfMessage(this.buffer)) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx);
      this.handleMessage(raw);
    }
  }

  /** 查找下一个完整 JSON 消息的边界 */
  private indexOfMessage(buf: string): number {
    // Content-Length 分帧
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const header = buf.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (match) {
        const len = parseInt(match[1]!, 10);
        const bodyStart = headerEnd + 4;
        if (buf.length >= bodyStart + len) {
          return bodyStart + len;
        }
        return -1; // 数据不完整
      }
    }
    // 换行分隔
    const nl = buf.indexOf('\n');
    return nl !== -1 ? nl + 1 : -1;
  }

  /** 处理单条 JSON-RPC 消息 */
  private handleMessage(raw: string): void {
    // 提取 JSON 部分（跳过 Content-Length 头）
    const headerEnd = raw.indexOf('\r\n\r\n');
    const jsonStr = headerEnd !== -1 ? raw.slice(headerEnd + 4).trim() : raw.trim();
    if (!jsonStr) return;
    try {
      const msg = JSON.parse(jsonStr) as { id?: number; result?: unknown; error?: unknown };
      if (typeof msg.id === 'number') {
        const handler = this.pending.get(msg.id);
        if (handler) {
          this.pending.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(`ACP 错误: ${JSON.stringify(msg.error)}`));
          } else {
            handler.resolve(msg.result);
          }
        }
      }
    } catch {
      // 非 JSON 或解析失败
    }
  }
}

/**
 * Kimi Controller。
 *
 * 用法：
 *   const ctrl = new KimiController({ rootPath });
 *   const { sessionId } = await ctrl.launch("hello", "/path/to/project");
 *   await ctrl.inject(sessionId, "follow-up");  // JSONRPCSteerMessage
 *   const events = ctrl.getStream(sessionId);
 *   const neutral = ctrl.transferSession(sessionId);
 */
export class KimiController {
  private readonly rootPath: string;
  private readonly cliBin: string;
  private readonly acp: AcpClient;

  constructor(options: KimiControllerOptions = {}) {
    this.rootPath = options.rootPath ?? DEFAULT_KIMI_DIR;
    this.cliBin = options.cliBin ?? DEFAULT_CLI;
    this.acp = new AcpClient(this.cliBin);
  }

  // ─── launch ──────────────────────────────────────────────────────────

  /**
   * 启动一个新 session。
   * 通过 CLI kimi -w <workDir> --session <id> -m <prompt> 启动。
   */
  async launch(prompt: string, workDir: string): Promise<KimiLaunchResult> {
    const sessionId = this.generateSessionId();
    let reply: string | undefined;
    try {
      const stdout = execFileSync(
        this.cliBin,
        ['-w', workDir, '--session', sessionId, '-m', prompt],
        { encoding: 'utf8', timeout: 120_000, maxBuffer: 50 * 1024 * 1024 },
      );
      reply = stdout.trim() || undefined;
    } catch {
      // CLI 执行可能超时，但 session 文件已创建
    }
    return { sessionId, workDir, channel: 'cli', reply };
  }

  // ─── inject ──────────────────────────────────────────────────────────

  /**
   * 中途注入消息（杀手级能力）。
   * 通过 ACP JSONRPCSteerMessage 向运行中 session 注入；ACP 不可用时降级到 CLI 新 turn。
   */
  async inject(sessionId: string, message: string, options: { interrupt?: boolean } = {}): Promise<{ channel: 'acp' | 'cli'; ok: boolean }> {
    // 尝试 ACP JSONRPCSteerMessage
    try {
      this.acp.start();
      const steer: SteerMessage = {
        type: 'steer',
        text: message,
        interrupt: options.interrupt ?? false,
      };
      // JSONRPCSteerMessage 是通知（无响应），直接写入
      this.acp.steer(sessionId, steer);
      return { channel: 'acp', ok: true };
    } catch {
      // 降级到 CLI
    }
    // 降级：通过 CLI 继续该 session（新 turn，非中途介入）
    try {
      const workDir = this.findWorkDir(sessionId) ?? process.cwd();
      execFileSync(
        this.cliBin,
        ['-w', workDir, '--session', sessionId, '-m', message],
        { encoding: 'utf8', timeout: 120_000, maxBuffer: 50 * 1024 * 1024 },
      );
      return { channel: 'cli', ok: true };
    } catch {
      return { channel: 'cli', ok: false };
    }
  }

  // ─── getStream ──────────────────────────────────────────────────────

  /**
   * 获取 session 的 Wire 协议事件流（从 wire.jsonl 解析）。
   * Wire 事件包括 TurnBegin/StepBegin/ContentPart/ToolCall/ToolResult/StatusUpdate。
   */
  getStream(sessionId: string): WireEvent[] {
    const wireFile = this.findWireFile(sessionId);
    if (!wireFile) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(wireFile, 'utf8');
    } catch {
      return [];
    }
    const events: WireEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { timestamp?: number; message?: { type?: string; payload?: unknown } };
        // 跳过 metadata 行（无 timestamp）
        if (typeof obj.timestamp !== 'number') continue;
        if (!obj.message) continue;
        events.push({
          timestamp: obj.timestamp,
          type: obj.message.type ?? 'unknown',
          payload: obj.message.payload,
        });
      } catch {
        // 脏行跳过
      }
    }
    return events;
  }

  // ─── extractSession ──────────────────────────────────────────────────

  /**
   * 读取 session 的 context.jsonl 提取消息（只读）。
   */
  extractSession(sessionId: string): SessionMessageInput[] | null {
    const contextFile = this.findContextFile(sessionId);
    if (!contextFile) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(contextFile, 'utf8');
    } catch {
      return null;
    }
    const messages: SessionMessageInput[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { role?: string; content?: unknown };
        if (obj.role !== 'user' && obj.role !== 'assistant') continue;
        const text = extractTextFromContent(obj.content);
        if (text !== null) {
          const role = (obj.role === 'assistant' ? 'assistant' : 'user') as MessageRole;
          messages.push({ role, content: text });
        }
      } catch {
        // 脏行跳过
      }
    }
    return messages;
  }

  // ─── transferSession ─────────────────────────────────────────────────

  /**
   * 转中性格式：提取 session 消息 + 元数据，供其他 agent 接管。
   */
  transferSession(sessionId: string): KimiTransferredSession | null {
    const messages = this.extractSession(sessionId);
    if (!messages) return null;
    const workDir = this.findWorkDir(sessionId) ?? undefined;
    return { source: 'kimi', sessionId, workDir, messages };
  }

  /** 停止 ACP 服务器（清理资源） */
  dispose(): void {
    this.acp.stop();
  }

  // ─── 辅助 ────────────────────────────────────────────────────────────

  /** 查找 session 的 context.jsonl 路径 */
  private findContextFile(sessionId: string): string | null {
    return this.findSessionFile(sessionId, 'context.jsonl');
  }

  /** 查找 session 的 wire.jsonl 路径 */
  private findWireFile(sessionId: string): string | null {
    return this.findSessionFile(sessionId, 'wire.jsonl');
  }

  /**
   * 查找 session 目录下的指定文件。
   * 扫描 sessions/<workDirHash>/<sessionId>/<filename>。
   */
  private findSessionFile(sessionId: string, filename: string): string | null {
    const sessionsDir = path.join(this.rootPath, SESSIONS_SEGMENT);
    let workDirHashes: fs.Dirent[];
    try {
      workDirHashes = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const hashEntry of workDirHashes) {
      if (!hashEntry.isDirectory()) continue;
      const target = path.join(sessionsDir, hashEntry.name, sessionId, filename);
      if (fs.existsSync(target)) return target;
    }
    return null;
  }

  /** 查找 session 对应的工作目录（从 user-history 反查） */
  private findWorkDir(sessionId: string): string | null {
    const sessionsDir = path.join(this.rootPath, SESSIONS_SEGMENT);
    let workDirHashes: fs.Dirent[];
    try {
      workDirHashes = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const hashEntry of workDirHashes) {
      if (!hashEntry.isDirectory()) continue;
      const sessionDir = path.join(sessionsDir, hashEntry.name, sessionId);
      if (fs.existsSync(sessionDir)) {
        // 从 user-history 反查 work_dir
        return this.lookupWorkDir(hashEntry.name);
      }
    }
    return null;
  }

  /** 从 user-history/<hash>.jsonl 反查工作目录 */
  private lookupWorkDir(workDirHash: string): string | null {
    const historyFile = path.join(this.rootPath, 'user-history', `${workDirHash}.jsonl`);
    let raw: string;
    try {
      raw = fs.readFileSync(historyFile, 'utf8');
    } catch {
      return null;
    }
    const lines = raw.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]!) as { work_dir?: string };
        if (typeof obj.work_dir === 'string' && obj.work_dir.length > 0) {
          return obj.work_dir;
        }
      } catch {
        // 脏行跳过
      }
    }
    return null;
  }

  /** 生成 session id */
  private generateSessionId(): string {
    const crypto = require('node:crypto') as { randomUUID: () => string };
    return crypto.randomUUID();
  }
}

/** 从 content 提取可显示文本（复用逻辑） */
function extractTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    if (parts.length === 0) return null;
    const joined = parts.join('\n');
    return joined.trim().length > 0 ? joined : null;
  }
  return null;
}
