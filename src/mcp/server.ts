/**
 * yondermesh MCP Server — LOOP-011 + LOOP-012
 *
 * v1: stdio JSON-RPC, 4 个查询工具
 * v2: 实时 session 感知 + 跨 session 消息总线
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { SessionStore } from '../store/index.js';
import type { SessionQuery, SessionRecord, SessionTopology } from '../store/types.js';
import { detectAliveProcesses } from '../store/process-detector.js';
import { buildSessionHandoff } from './codex-handoff.js';
import {
  extractProject,
  loadExtractIndex,
  projectExtractDir,
  projectHashOf,
  queryExtracts,
} from '../extract/index.js';
import type { ExtractOptions, QueryOptions } from '../extract/index.js';
import {
  buildActiveSessionHints,
  formatHintsAsText,
} from './tool-hints.js';
import { findTool as findNewTool, MCP_TOOLS } from './tools.js';
import { MailboxCore } from '../mailbox/index.js';
import { defaultDaemonConfig } from '../daemon/index.js';

/** 安全获取 daemon 配置（避免循环依赖问题） */
function defaultDaemonConfigSafe(): { dbPath: string; dataDir: string } {
  try {
    const config = defaultDaemonConfig();
    return { dbPath: config.dbPath, dataDir: config.dataDir };
  } catch {
    // 兜底：用默认路径
    const dataDir = process.env.YONDERMESH_HOME ?? join(homedir(), '.yondermesh');
    return { dbPath: join(dataDir, 'yondermesh.db'), dataDir };
  }
}

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
    // 旧版工具（本文件内定义的 handler）
    const legacy: McpToolDef[] = [
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
          '获取指定会话的消息记录。支持 live 模式直接读源文件获取实时内容（正在运行的会话也能读到最新消息）。用于了解某次会话的具体内容和决策过程，或查看另一个 agent 当前在做什么。新增 include_compacted / include_tool_calls / handoff_mode 参数用于任务接管场景（仅 live 模式生效，DB 模式忽略）。',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: '会话 ID' },
            live: { type: 'boolean', description: 'true=直接读源文件获取实时内容（推荐用于正在运行的 session）' },
            limit: { type: 'number', description: '只返回最后 N 条消息（大 session 时用）' },
            include_compacted: { type: 'boolean', description: 'live 模式下附 compacted_summaries 数组（codex 压缩摘要），默认 false', default: false },
            include_tool_calls: { type: 'boolean', description: 'live 模式下 recent messages 保留 function_call/function_call_output（带截断），默认 false', default: false },
            handoff_mode: { type: 'boolean', description: 'true=等价于 live=true + include_compacted=true + include_tool_calls=true + 自动取尾部 30 条，专为任务接管设计，默认 false', default: false },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'get_session_handoff',
        description:
          '专为任务接管设计：提取指定 session 的浓缩 handoff 包。直读源文件，返回 codex 压缩后的 compacted 摘要、最后一条真实 user 消息、尾部近况（保留 function_call/function_call_output/custom_tool_call，带截断）、task_plan（update_plan 等）、session 元数据与活跃状态。用于在另一个 agent 中断或需要接力时，快速获得完整上下文而不丢失 tool 调用细节。',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: '会话 ID（必填）' },
            tail_messages: { type: 'number', description: '尾部含 tool call 的消息条数，默认 30', default: 30 },
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
          '列出当前正在运行或最近活跃的 AI agent 会话，附带运行时摘要（总数 / live / subagent / by source）。直查数据库，反映最近扫描周期内的状态。',
        inputSchema: {
          type: 'object',
          properties: {
            within_minutes: { type: 'number', description: '查多少分钟内有活动的 session，默认 30', default: 30 },
          },
        },
      },
      {
        name: 'who_is_working',
        description:
          '快速查询本机当前有哪些 AI agent 正在工作。返回人类可读的摘要，包含正在运行的 session 数量、subagent 数量、每个活跃 session 的简短描述（id / source / 项目目录 / 最近活动时间）。用于任何 agent 在开始任务前快速感知机器上当前的活动状态。',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'who_is_waiting',
        description:
          '查找等待用户审阅回复的 session。返回最后一条消息是 assistant 且近期有活动的 session 列表，每条含消息预览。返回结果附带下一步指引，提示调用方查看这些 session 的内容细节并主动向用户提议操作。',
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
      {
        name: 'extract_project_history',
        description:
          '提取指定项目所有 session 历史中的用户需求（user 消息）和 agent 响应（assistant 消息），分别存为可索引的 NDJSONL 文件。这是了解用户在某个项目上真实需求的第一步。force_refresh=false 且已有提取结果时直接返回现有统计不重新提取。',
        inputSchema: {
          type: 'object',
          properties: {
            project_path: { type: 'string', description: '项目路径（cwd 前缀匹配）' },
            force_refresh: { type: 'boolean', description: 'true 时强制重新提取；false 且已有结果时直接返回现有统计', default: false },
          },
          required: ['project_path'],
        },
      },
      {
        name: 'query_user_requirements',
        description:
          '查询某项目的用户需求（user 消息）。可按关键词、session、时间、ID 过滤。每条含 id、sessionId、content、timestamp。需先调用 extract_project_history 完成提取。',
        inputSchema: {
          type: 'object',
          properties: {
            project_path: { type: 'string', description: '项目路径（需与 extract 时一致）' },
            keyword: { type: 'string', description: '关键词模糊匹配（大小写不敏感，匹配 content）' },
            session_id: { type: 'string', description: '按 session ID 过滤' },
            from: { type: 'string', description: '起始时间，ISO 8601 或相对时间如 7d / 24h / 30m' },
            to: { type: 'string', description: '结束时间，ISO 8601 或相对时间' },
            limit: { type: 'number', description: '返回条数上限，默认 20', default: 20 },
            offset: { type: 'number', description: '跳过前 N 条，默认 0', default: 0 },
            id: { type: 'number', description: '按精确 ID（=行号，1-based）查询，命中时忽略其它过滤' },
          },
          required: ['project_path'],
        },
      },
      {
        name: 'query_agent_responses',
        description:
          '查询某项目的 agent 响应（assistant 消息）。可按关键词、session、时间、ID 过滤。需先调用 extract_project_history 完成提取。',
        inputSchema: {
          type: 'object',
          properties: {
            project_path: { type: 'string', description: '项目路径（需与 extract 时一致）' },
            keyword: { type: 'string', description: '关键词模糊匹配（大小写不敏感，匹配 content）' },
            session_id: { type: 'string', description: '按 session ID 过滤' },
            from: { type: 'string', description: '起始时间，ISO 8601 或相对时间如 7d / 24h / 30m' },
            to: { type: 'string', description: '结束时间，ISO 8601 或相对时间' },
            limit: { type: 'number', description: '返回条数上限，默认 20', default: 20 },
            offset: { type: 'number', description: '跳过前 N 条，默认 0', default: 0 },
            id: { type: 'number', description: '按精确 ID（=行号，1-based）查询，命中时忽略其它过滤' },
          },
          required: ['project_path'],
        },
      },
    ];

    // 新版 yondermesh_* 工具（来自 MCP_TOOLS）
    const newTools: McpToolDef[] = MCP_TOOLS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: inputSchema as Record<string, unknown>,
    }));

    return [...legacy, ...newTools];
  }

  // -- 工具执行 -----------------------------------------------------------

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    // 先尝试旧版工具路由
    let result: McpToolResult;
    const legacyResult = await this.tryLegacyTool(name, args);
    if (legacyResult) {
      result = legacyResult;
    } else {
      // 新版 yondermesh_* 工具
      const newTool = findNewTool(name);
      if (!newTool) {
        return { content: `未知工具: ${name}`, isError: true };
      }
      const response = await newTool.handler(args);
      result = {
        content: response.content.map((c) => c.text).join('\n'),
        isError: response.isError,
      };
    }

    // Channel A: 非 mailbox 工具调用后注入 unread hint
    if (!name.startsWith('yondermesh_mailbox_') && !name.startsWith('yondermesh_whoami') && !result.isError) {
      const hint = this.buildUnreadHint(args);
      if (hint) {
        result = { content: result.content + '\n' + hint };
      }
    }

    return result;
  }

  /** 尝试旧版工具路由，未匹配返回 null */
  private async tryLegacyTool(name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
    switch (name) {
      case 'search_sessions':
        return this.searchSessions(args);
      case 'get_session_detail':
        return this.getSessionDetail(args);
      case 'get_session_handoff':
        return this.getSessionHandoff(args);
      case 'get_session_relations':
        return this.getSessionRelations(args);
      case 'get_overview':
        return this.getOverview(args);
      case 'list_active_sessions':
        return this.listActiveSessions(args);
      case 'who_is_working':
        return this.whoIsWorking(args);
      case 'who_is_waiting':
        return this.whoIsWaiting(args);
      case 'post_message':
        return this.postMessage(args);
      case 'get_messages':
        return this.getMessages(args);
      case 'extract_project_history':
        return this.extractProjectHistory(args);
      case 'query_user_requirements':
        return this.queryUserRequirements(args);
      case 'query_agent_responses':
        return this.queryAgentResponses(args);
      default:
        return null;
    }
  }

  /** Channel A: 构建 unread hint（self 有未读时返回字符串，否则 null） */
  private buildUnreadHint(args: Record<string, unknown>): string | null {
    try {
      const config = defaultDaemonConfigSafe();
      const mailbox = new MailboxCore(config.dbPath, config.dataDir);
      try {
        const explicitSid = typeof args.self_session_id === 'string' ? args.self_session_id : undefined;
        const selfSid = mailbox.resolveSelfSession({ explicit: explicitSid });
        if (!selfSid) return null;
        const unread = mailbox.countUnread(selfSid);
        if (unread.total === 0) return null;
        return `📬 mailbox: ${unread.total} unread (direct ${unread.direct}, broadcast ${unread.broadcast}). Call yondermesh_mailbox_check to read.`;
      } finally {
        mailbox.close();
      }
    } catch {
      return null;
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

    const handoffMode = args.handoff_mode === true;
    // handoff_mode 隐含 live + include_compacted + include_tool_calls + 自动取尾部
    const live = args.live === true || handoffMode;
    const includeCompacted = args.include_compacted === true || handoffMode;
    const includeToolCalls = args.include_tool_calls === true || handoffMode;
    const limit = typeof args.limit === 'number' ? args.limit : (handoffMode ? 30 : undefined);

    if (live && (handoffMode || includeCompacted || includeToolCalls)) {
      // 富上下文模式：复用 handoff 共享解析（含 compacted + tool_call）
      const pkg = buildSessionHandoff(sessionId, this.claudePath, this.codexPath, {
        tailMessages: limit ?? 30,
      });
      if (!pkg) {
        return { content: `找不到 session ${sessionId} 的源文件或文件为空`, isError: true };
      }
      const result: Record<string, unknown> = { messages: pkg.recent_messages };
      if (includeCompacted) {
        result.compacted_summaries = pkg.compacted_summaries;
      }
      return { content: JSON.stringify(result) };
    }

    if (live) {
      // 直接读源文件（默认 live 模式，保持向后兼容）
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

  private getSessionHandoff(args: Record<string, unknown>): McpToolResult {
    const sessionId = args.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      return { content: '缺少必填参数 session_id', isError: true };
    }

    const tailMessages = typeof args.tail_messages === 'number' ? args.tail_messages : 30;
    const pkg = buildSessionHandoff(sessionId, this.claudePath, this.codexPath, { tailMessages });
    if (!pkg) {
      return { content: `找不到 session ${sessionId} 的源文件`, isError: true };
    }
    return { content: JSON.stringify(pkg) };
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
   const withinMs = withinMin * 60_000;
   const summary = this.store.getActiveSessionsSummary(withinMs, detectAliveProcesses);
    const awaitingReview = this.store.getSessionsAwaitingReview(withinMs);
    const hints = buildActiveSessionHints(summary, awaitingReview);
    return { content: JSON.stringify({ ...summary, _hints: hints }) };
 }

 private whoIsWorking(_args: Record<string, unknown>): McpToolResult {
   const summary = this.store.getActiveSessionsSummary(30 * 60_000, detectAliveProcesses);
    const awaitingReview = this.store.getSessionsAwaitingReview(30 * 60_000);
   const home = homedir();

   const lines: string[] = [];
   lines.push(
     `本机当前有 ${summary.totalActive} 个 session 活跃中（${summary.liveCount} 个 live，${summary.subagentActive} 个 subagent）：`,
   );

   if (summary.totalActive === 0) {
     lines.push('');
     lines.push('（无活跃 session）');
   } else {
     lines.push('');
     for (const s of summary.sessions) {
       const tag =
         s.activityStatus === 'live' ? '[live] ' :
         s.activityStatus === 'idle' ? '[idle] ' :
         s.activityStatus === 'stopped' ? '[stop] ' : '[stale]';
       const idPrefix = s.topology === 'subagent' ? 'sub:' : '';
       const shortId = shortIdOf(s.sessionId);
       const cwd = s.cwd ? s.cwd.replace(home, '~') : '-';
       const ago = formatRelativeAgo(s.fileModifiedAt);
       const source = s.source.padEnd(12);
       lines.push(`${tag} ${idPrefix}${shortId}  ${source}  ${cwd}  最近 ${ago}`);
     }
   }

   const sourceParts = Object.entries(summary.bySource).map(([k, v]) => `${k}=${v}`);
   if (sourceParts.length > 0) {
     lines.push('');
     lines.push(`按 source 分布: ${sourceParts.join(', ')}`);
   }

    // 附加上下文感知指引
    const hints = buildActiveSessionHints(summary, awaitingReview);
    lines.push(formatHintsAsText(hints));

    return { content: lines.join('\n') };
 }
  private whoIsWaiting(args: Record<string, unknown>): McpToolResult {
    const withinMin = typeof args.within_minutes === 'number' ? args.within_minutes : 30;
    const withinMs = withinMin * 60_000;
    const sessions = this.store.getSessionsAwaitingReview(withinMs);
    const summary = this.store.getActiveSessionsSummary(withinMs, detectAliveProcesses);
    const home = homedir();

    const lines: string[] = [];
    if (sessions.length === 0) {
      lines.push('当前没有等待用户审阅的 session。');
    } else {
      lines.push(`有 ${sessions.length} 个 session 等待用户审阅回复：`);
      lines.push('');
      for (const s of sessions) {
        const idPrefix = s.topology === 'subagent' ? 'sub:' : '';
        const shortId = shortIdOf(s.sessionId);
        const cwd = s.cwd ? s.cwd.replace(home, '~') : '-';
        const ago = formatRelativeAgo(s.fileModifiedAt);
        const source = s.source.padEnd(12);
        const preview = s.lastMessagePreview.length > 60
          ? s.lastMessagePreview.slice(0, 60) + '...'
          : s.lastMessagePreview;
        lines.push(`[REVIEW] ${idPrefix}${shortId}  ${source}  ${cwd}  最近 ${ago}`);
        lines.push(`         "${preview}"`);
      }
    }

    // 附加上下文感知指引
    const hints = buildActiveSessionHints(summary, sessions);
    lines.push(formatHintsAsText(hints));

    return { content: lines.join('\n') };
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

  // -- extract 工具 -----------------------------------------------------

  private extractProjectHistory(args: Record<string, unknown>): McpToolResult {
    const projectPath = args.project_path;
    if (typeof projectPath !== 'string' || !projectPath) {
      return { content: '缺少必填参数 project_path', isError: true };
    }
    const forceRefresh = args.force_refresh === true;
    const projectHash = projectHashOf(projectPath);

    // force_refresh=false 且已有提取结果：直接返回现有统计，不重新提取
    if (!forceRefresh) {
      const existing = loadExtractIndex(projectHash);
      if (existing) {
        return {
          content: JSON.stringify({
            projectHash: existing.projectHash,
            projectPath: existing.projectPath,
            requirementCount: existing.requirementCount,
            responseCount: existing.responseCount,
            sessionCount: existing.sessionCount,
            extractedAt: existing.extractedAt,
            extractsDir: projectExtractDir(existing.projectHash),
            refreshed: false,
          }),
        };
      }
    }

    const options: ExtractOptions = { cwdPrefix: projectPath };
    const result = extractProject(options);
    return {
      content: JSON.stringify({
        projectHash: result.projectHash,
        projectPath: result.projectPath,
        requirementCount: result.requirementCount,
        responseCount: result.responseCount,
        sessionCount: result.sessionCount,
        extractedAt: result.extractedAt,
        extractsDir: projectExtractDir(result.projectHash),
        refreshed: true,
      }),
    };
  }

  private queryUserRequirements(args: Record<string, unknown>): McpToolResult {
    const projectPath = args.project_path;
    if (typeof projectPath !== 'string' || !projectPath) {
      return { content: '缺少必填参数 project_path', isError: true };
    }
    const projectHash = projectHashOf(projectPath);
    const opts = buildExtractQueryOptions(args);
    const entries = queryExtracts(projectHash, 'requirements', opts);
    return { content: JSON.stringify(entries) };
  }

  private queryAgentResponses(args: Record<string, unknown>): McpToolResult {
    const projectPath = args.project_path;
    if (typeof projectPath !== 'string' || !projectPath) {
      return { content: '缺少必填参数 project_path', isError: true };
    }
    const projectHash = projectHashOf(projectPath);
    const opts = buildExtractQueryOptions(args);
    const entries = queryExtracts(projectHash, 'responses', opts);
    return { content: JSON.stringify(entries) };
  }
}

// ---------------------------------------------------------------------------
// extract 查询选项构建
// ---------------------------------------------------------------------------

function buildExtractQueryOptions(args: Record<string, unknown>): QueryOptions {
  const opts: QueryOptions = {};
  if (typeof args.id === 'number') opts.id = args.id;
  if (typeof args.keyword === 'string' && args.keyword) opts.keyword = args.keyword;
  if (typeof args.session_id === 'string' && args.session_id) opts.sessionId = args.session_id;
  const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
  opts.limit = Math.min(Math.max(1, rawLimit), 500);
  const rawOffset = typeof args.offset === 'number' ? args.offset : 0;
  opts.offset = Math.max(0, rawOffset);
  const from = parseRelativeTime(typeof args.from === 'string' ? args.from : undefined);
  if (from !== null) opts.startedAtFrom = from;
  const to = parseRelativeTime(typeof args.to === 'string' ? args.to : undefined);
  if (to !== null) opts.startedAtTo = to;
  return opts;
}

// ---------------------------------------------------------------------------
// 文件系统扫描辅助
// ---------------------------------------------------------------------------

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
    model: s.model,
    cliVersion: s.cliVersion,
    originator: s.originator,
    threadSource: s.threadSource,
  };
}

/** 短 id：前 12 字符 + ...（不足则原样） */
function shortIdOf(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + '...' : id;
}

/** 相对时间格式化：最近 N 秒前 / N 分钟前 / N 小时前 */
function formatRelativeAgo(ms: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时前`;
}
