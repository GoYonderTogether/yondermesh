/**
 * OpenClaw Controller —— WebSocket RPC + CLI 双通道 wrapper
 *
 * OpenClaw 无 MCP/Skill/Always-on 挂载能力（D4 ❌ / D10 ❌），但提供：
 *   - Gateway WebSocket RPC（ws://127.0.0.1:18789）：sessions.send / sessions.list /
 *     sessions.history / sessions.spawn 等工具
 *   - CLI（openclaw agent --message / openclaw gateway）
 *
 * 本 wrapper 实现完整接入所需的五个能力：
 *   1. launch(prompt)        —— 通过 RPC sessions.send 或 CLI openclaw agent 启动
 *   2. inject(sessionId,msg) —— 通过 sessions.send RPC 向运行中 session 注入消息
 *   3. getStream(sessionId)  —— 通过 sessions.history RPC 订阅事件流
 *   4. extractSession(id)    —— 读取 session JSONL 文件提取消息
 *   5. transferSession(id)   —— 转中性格式供其他 agent 接管
 *
 * 降级策略：RPC 不可用时自动降级到 CLI（launch/inject），保证无 gateway 也能工作。
 * Node 22+ 提供全局 WebSocket；低版本无 WebSocket 时 RPC 能力不可用但不影响 CLI 通道。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { MessageRole, SessionMessageInput } from '../store/types.js';

/** 默认 OpenClaw 根目录 */
const DEFAULT_OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
/** 默认 Gateway WebSocket 地址 */
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';
/** 默认 CLI 可执行名 */
const DEFAULT_CLI = 'openclaw';
/** RPC 请求超时（毫秒） */
const RPC_TIMEOUT_MS = 30_000;

/** wrapper 选项 */
export interface OpenClawControllerOptions {
  /** OpenClaw 根目录，默认 ~/.openclaw */
  rootPath?: string;
  /** Gateway WebSocket URL，默认 ws://127.0.0.1:18789 */
  gatewayUrl?: string;
  /** CLI 可执行路径，默认 openclaw */
  cliBin?: string;
  /** agent id（多 agent 路由用），默认 main */
  agentId?: string;
}

/** launch 结果 */
export interface LaunchResult {
  /** 启动的 session id（native） */
  sessionId: string;
  /** 启动通道：rpc 或 cli */
  channel: 'rpc' | 'cli';
  /** agent 回复文本（如可同步获取） */
  reply?: string;
}

/** stream 事件 */
export interface StreamEvent {
  /** 事件类型 */
  type: string;
  /** 事件负载 */
  payload: unknown;
  /** 时间戳（epoch 毫秒） */
  timestamp?: number;
}

/** 中性 session 格式（供其他 agent 接管） */
export interface TransferredSession {
  /** 来源 agent */
  source: 'openclaw';
  /** native session id */
  sessionId: string;
  /** 工作目录 */
  cwd?: string;
  /** 模型 */
  model?: string;
  /** 完整消息列表 */
  messages: SessionMessageInput[];
}

/**
 * OpenClaw Controller。
 *
 * 用法：
 *   const ctrl = new OpenClawController({ rootPath, gatewayUrl });
 *   const { sessionId } = await ctrl.launch("hello");
 *   await ctrl.inject(sessionId, "follow-up");
 *   const events = await ctrl.getStream(sessionId);
 *   const neutral = ctrl.transferSession(sessionId);
 */
export class OpenClawController {
  private readonly rootPath: string;
  private readonly gatewayUrl: string;
  private readonly cliBin: string;
  private readonly agentId: string;

  constructor(options: OpenClawControllerOptions = {}) {
    this.rootPath = options.rootPath ?? DEFAULT_OPENCLAW_DIR;
    this.gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
    this.cliBin = options.cliBin ?? DEFAULT_CLI;
    this.agentId = options.agentId ?? 'main';
  }

  // ─── launch ──────────────────────────────────────────────────────────

  /**
   * 启动一个 agent turn。
   * 优先通过 RPC（sessions.send）；RPC 不可用时降级到 CLI（openclaw agent）。
   */
  async launch(prompt: string): Promise<LaunchResult> {
    // 尝试 RPC
    try {
      const result = await this.rpcCall('sessions.send', {
        message: prompt,
        agent: this.agentId,
      });
      const sessionId = (result as { sessionId?: string })?.sessionId
        ?? (result as { id?: string })?.id
        ?? this.generateSessionId();
      return { sessionId, channel: 'rpc', reply: (result as { reply?: string })?.reply };
    } catch {
      // 降级到 CLI
    }
    return this.launchViaCli(prompt);
  }

  /** 通过 CLI openclaw agent --message 启动 */
  private launchViaCli(prompt: string): LaunchResult {
    const sessionId = this.generateSessionId();
    try {
      const stdout = execFileSync(
        this.cliBin,
        ['agent', '--agent', this.agentId, '--session-id', sessionId, '--message', prompt, '--json'],
        { encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
      // 尝试从 JSON 输出提取 reply
      let reply: string | undefined;
      try {
        const parsed = JSON.parse(stdout);
        reply = typeof parsed.reply === 'string' ? parsed.reply : parsed.output;
      } catch {
        reply = stdout.trim() || undefined;
      }
      return { sessionId, channel: 'cli', reply };
    } catch {
      // CLI 执行失败也返回 sessionId（可能 session 文件已创建）
      return { sessionId, channel: 'cli' };
    }
  }

  // ─── inject ──────────────────────────────────────────────────────────

  /**
   * 向运行中 session 注入消息（中途介入）。
   * 通过 sessions.send RPC；RPC 不可用时降级到 CLI agent --session-id。
   */
  async inject(sessionId: string, message: string): Promise<{ channel: 'rpc' | 'cli'; ok: boolean }> {
    try {
      await this.rpcCall('sessions.send', {
        sessionId,
        message,
        agent: this.agentId,
      });
      return { channel: 'rpc', ok: true };
    } catch {
      // 降级到 CLI
    }
    try {
      execFileSync(
        this.cliBin,
        ['agent', '--agent', this.agentId, '--session-id', sessionId, '--message', message],
        { encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
      return { channel: 'cli', ok: true };
    } catch {
      return { channel: 'cli', ok: false };
    }
  }

  // ─── getStream ──────────────────────────────────────────────────────

  /**
   * 获取 session 的事件流。
   * 优先 RPC sessions.history；降级到读取 session JSONL 文件解析事件。
   */
  async getStream(sessionId: string): Promise<StreamEvent[]> {
    try {
      const result = await this.rpcCall('sessions.history', { sessionId });
      const events = (result as { events?: unknown[] })?.events;
      if (Array.isArray(events)) {
        return events as StreamEvent[];
      }
    } catch {
      // 降级
    }
    return this.extractStreamFromFile(sessionId);
  }

  /** 从 session JSONL 文件解析事件流（降级方案） */
  private extractStreamFromFile(sessionId: string): StreamEvent[] {
    const sessionFile = this.findSessionFile(sessionId);
    if (!sessionFile) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(sessionFile, 'utf8');
    } catch {
      return [];
    }
    const events: StreamEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        events.push({
          type: typeof obj.type === 'string' ? obj.type : 'unknown',
          payload: obj,
          timestamp: typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : undefined,
        });
      } catch {
        // 脏行跳过
      }
    }
    return events;
  }

  // ─── extractSession ──────────────────────────────────────────────────

  /**
   * 读取 session JSONL 文件提取消息（只读，不修改）。
   * 扫描 agents/<id>/sessions/<sessionId>.jsonl（含 .reset 旋转文件）。
   */
  extractSession(sessionId: string): SessionMessageInput[] | null {
    const sessionFile = this.findSessionFile(sessionId);
    if (!sessionFile) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(sessionFile, 'utf8');
    } catch {
      return null;
    }
    const messages: SessionMessageInput[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj.type !== 'message') continue;
        const msg = obj.message as { role?: string; content?: unknown } | undefined;
        if (!msg) continue;
        const text = extractTextFromContent(msg.content);
        if (text !== null) {
          const role = (msg.role === 'assistant' ? 'assistant' : 'user') as MessageRole;
          const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : undefined;
          messages.push({ role, content: text, timestamp: Number.isNaN(ts) ? undefined : ts });
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
   * 这是 CLI 命令链接入的关键一环：通过 session 文件读取实现跨 agent 转交。
   */
  transferSession(sessionId: string): TransferredSession | null {
    const sessionFile = this.findSessionFile(sessionId);
    if (!sessionFile) return null;
    const messages = this.extractSession(sessionId);
    if (!messages) return null;
    // 从文件头提取 cwd / model
    let cwd: string | undefined;
    let model: string | undefined;
    try {
      const raw = fs.readFileSync(sessionFile, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (obj.type === 'session') {
            cwd = typeof obj.cwd === 'string' ? obj.cwd : cwd;
          }
          if (obj.type === 'model_change' && typeof obj.modelId === 'string') {
            model = obj.modelId;
          }
          if (cwd && model) break;
        } catch {
          // 脏行跳过
        }
      }
    } catch {
      // 读取失败不掩盖消息提取结果
    }
    return { source: 'openclaw', sessionId, cwd, model, messages };
  }

  // ─── RPC 通信 ────────────────────────────────────────────────────────

  /**
   * 发起一次 WebSocket RPC 调用。
   * Node 22+ 有全局 WebSocket；无全局 WebSocket 时抛错（触发降级）。
   * 协议：JSON-RPC 2.0 over WebSocket。
   */
  private rpcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const WebSocketImpl = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WebSocketImpl) {
      return Promise.reject(new Error('WebSocket 不可用（需要 Node 22+）'));
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(this.gatewayUrl);
      const id = Math.floor(Math.random() * 1e9);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* noop */ }
        reject(new Error(`RPC 超时: ${method}`));
      }, RPC_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
      ws.addEventListener('message', (event: MessageEvent) => {
        try {
          const data = typeof event.data === 'string' ? event.data : '';
          const msg = JSON.parse(data);
          if (msg.id === id) {
            clearTimeout(timer);
            try { ws.close(); } catch { /* noop */ }
            if (msg.error) {
              reject(new Error(`RPC 错误: ${JSON.stringify(msg.error)}`));
            } else {
              resolve(msg.result);
            }
          }
        } catch {
          // 非 JSON 消息忽略
        }
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`RPC 连接失败: ${this.gatewayUrl}`));
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
      });
    });
  }

  // ─── 辅助 ────────────────────────────────────────────────────────────

  /**
   * 查找 session 文件：扫描 agents/<id>/sessions/ 下的 <sessionId>.jsonl
   * （含 .reset.<ts>.<ms>.Z 旋转文件，取最新或精确匹配）。
   */
  findSessionFile(sessionId: string): string | null {
    const agentsDir = path.join(this.rootPath, 'agents');
    let agents: fs.Dirent[];
    try {
      agents = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      const sessionsDir = path.join(agentsDir, agent.name, 'sessions');
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(sessionsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      // 优先精确匹配 <sessionId>.jsonl
      const exact = files.find((f) => f.isFile() && f.name === `${sessionId}.jsonl`);
      if (exact) return path.join(sessionsDir, exact.name);
      // 退化：匹配 <sessionId>.jsonl.reset.* （旋转文件）
      const rotated = files
        .filter((f) => f.isFile() && f.name.startsWith(`${sessionId}.jsonl.reset.`))
        .map((f) => f.name)
        .sort()
        .pop();
      if (rotated) return path.join(sessionsDir, rotated);
    }
    return null;
  }

  /** 生成一个 session id（UUID v4 风格） */
  private generateSessionId(): string {
    const crypto = require('node:crypto') as { randomUUID: () => string };
    return crypto.randomUUID();
  }
}

/**
 * 从 message.content 提取可显示文本（与 importer 相同逻辑，供 wrapper 复用）。
 *   - content 字符串 → 该字符串
 *   - content 数组 → 只取 text 块拼接
 *   - 结果空白 → null
 */
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
