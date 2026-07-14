/**
 * yondermesh MCP Server — LOOP-011
 *
 * 通过 stdio JSON-RPC 2.0 暴露 SessionStore 查询能力。
 * 零外部依赖，使用 Node 内置模块实现 MCP 协议。
 */

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

export class McpServer {
  readonly store: SessionStore;
  private running = false;

  constructor(store: SessionStore) {
    this.store = store;
  }

  // -- stdio 传输 --------------------------------------------------------

  /** 启动 stdio JSON-RPC 循环 */
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
          '搜索本机所有 AI agent 的会话记录。可按时间范围、项目路径、agent 类型、会话类型（根会话/子代理）过滤。用于在开始新任务前查找是否有相关历史会话，回顾某个项目的全部工作记录，或查找某个 agent 最近做了什么。',
        inputSchema: {
          type: 'object',
          properties: {
            project_path: {
              type: 'string',
              description: '项目路径精确匹配',
            },
            project_prefix: {
              type: 'string',
              description: '项目路径前缀，匹配子目录',
            },
            agent: {
              type: 'string',
              enum: ['claude-code', 'codex', 'cass'],
              description: '按 agent 类型过滤',
            },
            topology: {
              type: 'string',
              enum: ['root', 'subagent'],
              description: 'root=用户发起的真实会话，subagent=被其他 agent 调起的子会话',
            },
            since: {
              type: 'string',
              description: '起始时间，ISO 8601 或相对时间如 7d / 24h / 30m',
            },
            limit: {
              type: 'number',
              description: '返回条数，默认 20',
              default: 20,
            },
          },
        },
      },
      {
        name: 'get_session_detail',
        description:
          '获取指定会话的完整消息记录，包括用户消息、助手回复和工具调用。用于深入了解某次会话的具体内容和决策过程。',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: '会话 ID，从 search_sessions 获取',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'get_session_relations',
        description:
          '查询会话的关系拓扑。返回该会话的父会话、子会话和关联会话。用于理解会话之间的派生关系，例如某个子代理会话是由哪个根会话触发的。',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: '会话 ID',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'get_overview',
        description:
          '获取本机全部 AI agent 会话的统计概览。包括按 agent 类型、按项目的会话数和消息数分布。用于快速了解设备上的工作全貌。',
        inputSchema: {
          type: 'object',
          properties: {
            since: {
              type: 'string',
              description: '只统计此时间之后的数据，ISO 8601 或相对时间',
            },
            project_prefix: {
              type: 'string',
              description: '只统计匹配的项目',
            },
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

    const messages = this.store.getMessages(sessionId);
    if (messages.length === 0) {
      // 检查 session 是否存在
      const sessions = this.store.querySessions({ limit: 1 });
      const exists = this.store.querySessions({}).some((s) => s.id === sessionId);
      void sessions;
      if (!exists) {
        return { content: `会话 ${sessionId} 不存在`, isError: true };
      }
    }

    return {
      content: JSON.stringify(
        messages.map((m) => ({
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
