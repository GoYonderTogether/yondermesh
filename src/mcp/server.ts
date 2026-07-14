/**
 * yondermesh MCP Server — LOOP-011 + LOOP-012
 *
 * v1: stdio JSON-RPC, 4 个查询工具
 * v2: 实时 session 感知 + 跨 session 消息总线
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { SessionStore } from '../store/index.js';
import type { SessionQuery, SessionRecord, SessionTopology } from '../store/types.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: string;
  isError?: boolean;
}

export interface McpServerOptions {
  claudeProjectsPath?: string;
  codexSessionsPath?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// 相对时间解析
// ---------------------------------------------------------------------------

const TIME_UNITS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
};

export function parseRelativeTime(input?: string): number | null {
  if (!input || typeof input !== 'string') return null;

  // ISO 8601
  const iso = Date.parse(input);
  if (!Number.isNaN(iso)) return iso;

  // 相对格式：数字 + 单位（7d / 24h / 30m）
  const match = input.match(/^(\d+)([dhm])$/);
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = TIME_UNITS[match[2]];
    return Date.now() - n * unit;
  }

  return null;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: 'yondermesh', version: '0.1.0' } as const;
const LIVE_THRESHOLD_MS = 120_000; // 2 分钟内有写入 = LIVE

export class McpServer {
  readonly store: SessionStore;
  private readonly options: McpServerOptions;
  private running = false;

  constructor(store: SessionStore, options?: McpServerOptions) {
    this.store = store;
    this.options = options ?? {};
  }

  // -- 文件系统路径解析 ---------------------------------------------------

  private get claudePath(): string {
    return this.options.claudeProjectsPath ?? join(homedir(), '.claude', 'projects');
  }

  private get codexPath(): string {
    return this.options.codexSessionsPath ?? join(homedir(), '.codex', 'sessions');
  }

  // -- stdio 传输 --------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    process.stdin.setEncoding('utf-8');
    let buffer = '';

    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.processLine(trimmed);
      }
    });

    process.stdin.on('end', () => {
      this.running = false;
    });
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private processLine(line: string): void {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      const resp: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 0,
        error: { code: -32700, message: 'Parse error' },
      };
      process.stdout.write(JSON.stringify(resp) + '\n');
      return;
    }

    this.handleMessage(req)
      .then((resp) => {
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
      })
      .catch(() => {
        const resp: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32603, message: 'Internal error' },
        };
        process.stdout.write(JSON.stringify(resp) + '\n');
      });
  }

  // -- JSON-RPC 路由 ------------------------------------------------------

  async handleMessage(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: SERVER_INFO,
            capabilities: { tools: {} },
          },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: { tools: this.listTools() },
        };

      case 'tools/call': {
        const params = req.params ?? {};
        const name = params.name as string;
        const args = (params.arguments as Record<string, unknown>) ?? {};
        const result = await this.callTool(name, args);
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            content: [{ type: 'text', text: result.content }],
            isError: result.isError ?? false,
          },
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  }

  // -- 工具定义 -----------------------------------------------------------

  listTools(): McpToolDef[] {
    return [
      {
        name: 'search_sessions',
        description:
          '搜索本机所有 AI agent 的会话记录。可按时间范围、项目路径、agent 类型、会话类型过滤。用于在开始新任务前查找是否有相关历史会话，回顾某个项目的全部工作记录。',
        inputSchema: {
          type: 'object',
          properties: {
            project_path: { type: 'string', description: '项目路径精确匹配' },
            project_prefix: { type: 'string', description: '项目路径前缀' },
            agent: { type: 'string', enum: ['claude', 'codex', 'opencode', 'hermes', 'kimi', 'cursor', 'copilot', 'gemini'], description: '按 agent 类型过滤' },
            topology: { type: 'string', enum: ['root', 'subagent'], description: 'root=用户发起的真实会话，subagent=被其他 agent 调起的子会话' },
            since: { type: 'string', description: '起始时间，ISO 8601 或相对时间如 7d / 24h / 30m' },
            limit: { type: 'number', description: '返回条数，默认 20', default: 20 },
          },
        },
      },
      {
        name: 'get_session_detail',
        description:
          '获取指定会话的消息记录。支持 live 模式直接读源文件获取实时内容（正在运行的会话也能读到最新消息）。用于了解某次会话的具体内容和决策过程，或查看另一个 agent 当前在做什么。',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: '会话 ID' },
            live: { type: 'boolean', description: 'true=直接读源文件获取实时内容（推荐用于正在运行的 session）' },
            limit: { type: 'number', description: '只返回最后 N 条消息（大 session 时用）' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'get_session_relations',
        description:
          '查询会话的关系拓扑。返回该会话的父会话、子会话和关联会话。',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: '会话 ID' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'get_overview',
        description:
          '获取本机全部 AI agent 会话的统计概览。',
        inputSchema: {
          type: 'object',
          properties: {
            since: { type: 'string', description: '只统计此时间之后的数据' },
            project_prefix: { type: 'string', description: '只统计匹配的项目' },
          },
        },
      },
      {
        name: 'list_active_sessions',
        description:
          '列出当前正在运行或最近活跃的 AI agent 会话。直查文件系统，不依赖扫描周期。用于了解当前有哪些 agent 正在工作，isLive=true 表示正在实时写入。这是了解机器上当前活动状态的第一步。',
        inputSchema: {
          type: 'object',
          properties: {
            within_minutes: { type: 'number', description: '查多少分钟内有活动的 session，默认 30', default: 30 },
          },
        },
      },
      {
        name: 'post_message',
        description:
          '向另一个 agent session 或项目广播发送消息。用于跨 session 通信，例如通知另一个 agent 任务完成、提出建议、或提出问题。消息通过本地 SQLite 共享，目标 agent 可通过 get_messages 读取。',
        inputSchema: {
          type: 'object',
          properties: {
            to_session_id: { type: 'string', description: '目标 session ID（直接消息）' },
            to_project: { type: 'string', description: '目标项目路径（广播给该项目下所有 agent）' },
            from_session_id: { type: 'string', description: '发送方 session ID' },
            body: { type: 'string', description: '消息内容' },
            kind: { type: 'string', enum: ['info', 'warning', 'question', 'task_update'], description: '消息类型', default: 'info' },
          },
          required: ['body'],
        },
      },
      {
        name: 'get_messages',
        description:
          '读取发给当前 session 或项目的消息。读取后自动标记为已读。用于接收其他 agent 通过 post_message 发来的跨 session 通信。',
        inputSchema: {
          type: 'object',
          properties: {
            for_session_id: { type: 'string', description: '查发给这个 session 的直接消息' },
            for_project: { type: 'string', description: '查发给这个项目的广播' },
            since_minutes: { type: 'number', description: '只看最近 N 分钟的消息，默认 60', default: 60 },
            unread_only: { type: 'boolean', description: '只看未读消息', default: false },
          },
        },
      },
    ];
  }

  // -- 工具执行 -----------------------------------------------------------

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    switch (name) {
      case 'search_sessions':
        return this.searchSessions(args);
      case 'get_session_detail':
        return this.getSessionDetail(args);
      case 'get_session_relations':
        return this.getSessionRelations(args);
      case 'get_overview':
        return this.getOverview(args);
      case 'list_active_sessions':
        return this.listActiveSessions(args);
      case 'post_message':
        return this.postMessage(args);
      case 'get_messages':
        return this.getMessages(args);
      default:
        return { content: `未知工具: ${name}`, isError: true };
    }
  }

  private searchSessions(args: Record<string, unknown>): McpToolResult {
    const query: SessionQuery = {};

    if (typeof args.project_path === 'string') query.projectPath = args.project_path;
    if (typeof args.project_prefix === 'string') query.projectPrefix = args.project_prefix;
    if (typeof args.agent === 'string') query.source = args.agent;
    if (typeof args.topology === 'string')
      query.topology = args.topology as SessionTopology;

    const since = parseRelativeTime(
      typeof args.since === 'string' ? args.since : undefined,
    );
    if (since !== null) query.startedAtFrom = since;

    const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
    query.limit = Math.min(Math.max(1, rawLimit), 200);

    const sessions = this.store.querySessions(query);
    return { content: JSON.stringify(sessions.map(formatSessionSummary)) };
  }

  private getSessionDetail(args: Record<string, unknown>): McpToolResult {
    const sessionId = args.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      return { content: '缺少必填参数 session_id', isError: true };
    }

    const live = args.live === true;
    const limit = typeof args.limit === 'number' ? args.limit : undefined;

    if (live) {
      // 直接读源文件
      const messages = readLiveMessages(sessionId, this.claudePath, this.codexPath, limit);
      if (messages.length === 0) {
        return { content: `找不到 session ${sessionId} 的源文件或文件为空`, isError: true };
      }
      return { content: JSON.stringify(messages) };
    }

    // DB 模式
    const messages = this.store.getMessages(sessionId);
    if (messages.length === 0) {
      const exists = this.store.querySessions({}).some((s) => s.id === sessionId);
      if (!exists) {
        return { content: `会话 ${sessionId} 不存在`, isError: true };
      }
    }

    const result = limit ? messages.slice(-limit) : messages;
    return {
      content: JSON.stringify(
        result.map((m) => ({
          seq: m.seq,
          role: m.role,
          content: m.content,
          ...(m.timestamp ? { timestamp: m.timestamp } : {}),
        })),
      ),
    };
  }

  private getSessionRelations(args: Record<string, unknown>): McpToolResult {
    const sessionId = args.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      return { content: '缺少必填参数 session_id', isError: true };
    }

    const rels = this.store.queryRelationships(sessionId);
    return {
      content: JSON.stringify(
        rels.map((r) => ({
          type: r.relationType,
          direction: r.direction,
          sessionId: r.direction === 'outgoing' ? r.toSessionId : r.fromSessionId,
        })),
      ),
    };
  }

  private getOverview(args: Record<string, unknown>): McpToolResult {
    const query: SessionQuery = {};

    const since = parseRelativeTime(
      typeof args.since === 'string' ? args.since : undefined,
    );
    if (since !== null) query.startedAtFrom = since;

    if (typeof args.project_prefix === 'string')
      query.projectPrefix = args.project_prefix;

    const stats = this.store.getSessionStats(query);
    return { content: JSON.stringify(stats) };
  }

  // -- LOOP-012 新增工具 -------------------------------------------------

  private listActiveSessions(args: Record<string, unknown>): McpToolResult {
    const withinMin = typeof args.within_minutes === 'number' ? args.within_minutes : 30;
    const thresholdMs = withinMin * 60_000;
    const now = Date.now();

    const results: Array<Record<string, unknown>> = [];

    // 扫描 codex sessions
    scanDir(this.codexPath, '.jsonl', (filePath) => {
      const stat = statSync(filePath);
      const ageMs = now - stat.mtimeMs;
      if (ageMs > thresholdMs) return;

      const meta = peekSessionMeta(filePath, 'codex');
      results.push({
        sessionId: meta.sessionId ?? pathBaseName(filePath),
        source: 'codex',
        filePath,
        isLive: ageMs < LIVE_THRESHOLD_MS,
        lastActivitySecAgo: Math.round(ageMs / 1000),
        cwd: meta.cwd ?? null,
        projectPath: meta.cwd ?? null,
        messageCount: meta.messageCount,
        lineCount: meta.lineCount,
      });
    });

    // 扫描 claude projects
    scanDir(this.claudePath, '.jsonl', (filePath) => {
      const stat = statSync(filePath);
      const ageMs = now - stat.mtimeMs;
      if (ageMs > thresholdMs) return;

      const meta = peekSessionMeta(filePath, 'claude');
      results.push({
        sessionId: meta.sessionId ?? pathBaseName(filePath),
        source: 'claude',
        filePath,
        isLive: ageMs < LIVE_THRESHOLD_MS,
        lastActivitySecAgo: Math.round(ageMs / 1000),
        cwd: meta.cwd ?? null,
        projectPath: meta.cwd ?? null,
        messageCount: meta.messageCount,
        lineCount: meta.lineCount,
      });
    });

    // 按 lastActivitySecAgo 升序（最活跃的在前）
    results.sort((a, b) => (a.lastActivitySecAgo as number) - (b.lastActivitySecAgo as number));

    return { content: JSON.stringify(results) };
  }

  private postMessage(args: Record<string, unknown>): McpToolResult {
    const body = args.body;
    if (typeof body !== 'string' || !body) {
      return { content: '缺少必填参数 body', isError: true };
    }

    const id = this.store.postMessage({
      toSessionId: typeof args.to_session_id === 'string' ? args.to_session_id : undefined,
      toProject: typeof args.to_project === 'string' ? args.to_project : undefined,
      fromSessionId: typeof args.from_session_id === 'string' ? args.from_session_id : undefined,
      body,
      kind: typeof args.kind === 'string' ? args.kind : 'info',
    });

    return { content: JSON.stringify({ messageId: id, posted: true }) };
  }

  private getMessages(args: Record<string, unknown>): McpToolResult {
    const sinceMin = typeof args.since_minutes === 'number' ? args.since_minutes : 60;
    const messages = this.store.queryAgentMessages({
      forSessionId: typeof args.for_session_id === 'string' ? args.for_session_id : undefined,
      forProject: typeof args.for_project === 'string' ? args.for_project : undefined,
      sinceMs: Date.now() - sinceMin * 60_000,
      unreadOnly: args.unread_only === true,
    });

    return { content: JSON.stringify(messages) };
  }
}

// ---------------------------------------------------------------------------
// 文件系统扫描辅助
// ---------------------------------------------------------------------------

/** 递归扫描目录，对每个匹配文件调用 callback */
function scanDir(dir: string, ext: string, cb: (filePath: string) => void): void {
  if (!existsSync(dir)) return;

  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as typeof entries;
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, ext, cb);
    } else if (entry.name.endsWith(ext)) {
      cb(fullPath);
    }
  }
}

/** 从文件名提取基础名（不含扩展名） */
function pathBaseName(filePath: string): string {
  const parts = filePath.split('/');
  const filename = parts[parts.length - 1] ?? filePath;
  return filename.replace(/\.jsonl$/, '');
}

/** 读取文件前几行提取 session meta */
function peekSessionMeta(filePath: string, source: 'claude' | 'codex'): {
  sessionId: string | null;
  cwd: string | null;
  messageCount: number;
  lineCount: number;
} {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let messageCount = 0;
  let lineCount = 0;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    lineCount = lines.length;

    if (source === 'codex') {
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.type === 'session_meta' && d.payload) {
            sessionId = d.payload.session_id ?? d.payload.id ?? null;
            cwd = d.payload.cwd ?? null;
          }
          if (d.type === 'response_item') {
            const p = d.payload ?? {};
            if (p.role === 'user' || p.role === 'assistant') messageCount++;
          }
        } catch { /* skip */ }
      }
    } else {
      // claude
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
        if (!sessionId && d.sessionId) sessionId = d.sessionId;
        if (!cwd && d.cwd) cwd = d.cwd;
        if (d.type === 'user' || d.type === 'assistant') messageCount++;
        } catch { /* skip */ }
      }
    }
  } catch { /* file unreadable */ }

  return { sessionId, cwd, messageCount, lineCount };
}

/** 从源文件实时读取消息（live 模式） */
function readLiveMessages(
  sessionId: string,
  claudePath: string,
  codexPath: string,
  limit?: number,
): Array<{ seq: number; role: string; content: string; timestamp?: number }> {
  // 尝试在 claude 目录中找匹配文件
  const claudeFile = findSessionFile(claudePath, sessionId, 'claude');
  if (claudeFile) {
    return parseClaudeMessages(claudeFile, limit);
  }

  // 尝试在 codex 目录中找
  const codexFile = findSessionFile(codexPath, sessionId, 'codex');
  if (codexFile) {
    return parseCodexMessages(codexFile, limit);
  }

  return [];
}

/** 递归查找包含指定 sessionId 的文件 */
function findSessionFile(dir: string, sessionId: string, _source: string): string | null {
  if (!existsSync(dir)) return null;

  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as typeof entries;
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findSessionFile(fullPath, sessionId, _source);
      if (found) return found;
    } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
      return fullPath;
    }
  }

  return null;
}

/** 解析 claude JSONL 消息 */
function parseClaudeMessages(
  filePath: string,
  limit?: number,
): Array<{ seq: number; role: string; content: string; timestamp?: number }> {
  const messages: Array<{ seq: number; role: string; content: string; timestamp?: number }> = [];

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.type === 'user' || d.type === 'assistant') {
          const msg = d.message ?? {};
          let text = '';
          const c = msg.content ?? d.content ?? '';
          if (typeof c === 'string') {
            text = c;
          } else if (Array.isArray(c)) {
            const parts: string[] = [];
            for (const part of c) {
              if (part?.type === 'text') parts.push(part.text ?? '');
              else if (part?.type === 'tool_use') parts.push(`[tool: ${part.name ?? '?'}]`);
              else if (part?.type === 'tool_result') parts.push('[tool_result]');
            }
            text = parts.join(' ');
          }
          messages.push({
            seq: messages.length,
            role: d.type,
            content: text,
          });
        }
      } catch { /* skip */ }
    }
  } catch { /* file unreadable */ }

  return limit ? messages.slice(-limit) : messages;
}

/** 解析 codex rollout JSONL 消息 */
function parseCodexMessages(
  filePath: string,
  limit?: number,
): Array<{ seq: number; role: string; content: string; timestamp?: number }> {
  const messages: Array<{ seq: number; role: string; content: string; timestamp?: number }> = [];

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.type === 'response_item') {
          const p = d.payload ?? {};
          const role = p.role;
          if (role === 'user' || role === 'assistant') {
            const c = p.content;
            let text = '';
            if (typeof c === 'string') {
              text = c;
            } else if (Array.isArray(c)) {
              const parts: string[] = [];
              for (const part of c) {
                if (part?.type === 'text' || part?.type === 'output_text') {
                  parts.push(part.text ?? '');
                } else if (part?.type === 'function_call') {
                  parts.push(`[fn: ${part.name ?? '?'}]`);
                }
              }
              text = parts.join(' ');
            }
            if (text) {
              messages.push({
                seq: messages.length,
                role,
                content: text,
              });
            }
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* file unreadable */ }

  return limit ? messages.slice(-limit) : messages;
}

// ---------------------------------------------------------------------------
// 格式化辅助
// ---------------------------------------------------------------------------

function formatSessionSummary(s: SessionRecord) {
  return {
    id: s.id,
    source: s.source,
    projectPath: s.projectPath,
    cwd: s.cwd,
    topology: s.topology,
    messageCount: s.messageCount,
    startedAt: s.startedAt,
    lastSeenAt: s.lastSeenAt,
  };
}
