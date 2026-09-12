/**
 * yondermesh MCP Server — LOOP-011 + LOOP-012
 *
 * v1: stdio JSON-RPC, 4 个查询工具
 * v2: 实时 session 感知 + 跨 session 消息总线
 */

import '../prelude/quiet-sqlite-warning.js';
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
import { agentMessage } from '../mailbox/unified.js';
import { observe, pickFilter } from './observe.js';
import { orchestrate } from './orchestrate.js';
import { workspace as workspaceCmd } from './workspace.js';
import { buildSituation, attachSituation } from './situation.js';
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

/** yondermesh_* 工具 → 精简集替代名(whoami 不在表内,保留原样) */
const YONDERMESH_DEPRECATED_TARGET: Record<string, string> = {
  yondermesh_query_sessions: 'search_sessions',
  yondermesh_get_session: 'get_session',
  yondermesh_launch_agent: 'send',
  yondermesh_inject_session: 'send',
  yondermesh_transfer_session: 'send',
  yondermesh_mount_status: 'agents',
  yondermesh_mailbox_check: 'mailbox',
  yondermesh_mailbox_post: 'mailbox',
  yondermesh_mailbox_reply: 'mailbox',
  yondermesh_send: 'send',
  yondermesh_list_agents: 'agents',
};

/** 给 description 加 [deprecated, use X] 前缀 */
function makeDeprecated(description: string, target: string): string {
  if (!target) return description;
  return `[deprecated, use ${target}] ${description}`;
}

/**
 * T1.3 正交核心工具集(推荐入口)。文档生成器据此把工具分为「核心 8 工具」与
 * 「辅助工具」两组;新增/调整核心工具时同步更新此常量,即为单一真相源。
 */
export const ORTHOGONAL_TOOL_NAMES = [
  'search_sessions', 'get_session', 'list_active', 'overview',
  'handoff', 'send', 'mailbox', 'agents',
] as const;

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
   // T1.3 精简集(推荐入口,排在最前)
   const refined: McpToolDef[] = [
     {
       name: 'search_sessions',
       description:
         '搜索本机所有 AI agent 的会话记录。可按时间范围、项目路径、agent 类型、会话类型过滤,并支持 query 关键字全文检索(匹配会话消息正文)。用于在开始新任务前查找是否有相关历史会话,回顾某个项目的全部工作记录。',
       inputSchema: {
         type: 'object',
         properties: {
           query: { type: 'string', description: '关键字全文检索,大小写不敏感,匹配会话消息正文' },
           search: { type: 'string', description: '同 query(别名)' },
           source: { type: 'string', description: '按 agent 类型过滤(claude/codex/hermes 等),等价于旧参数 agent' },
           project_path: { type: 'string', description: '项目路径精确匹配' },
           project_prefix: { type: 'string', description: '项目路径前缀' },
           agent: { type: 'string', enum: ['claude', 'codex', 'opencode', 'hermes', 'kimi', 'cursor', 'copilot', 'gemini'], description: '按 agent 类型过滤(旧别名,等价 source)' },
           topology: { type: 'string', enum: ['root', 'subagent'], description: 'root=用户发起的真实会话，subagent=被其他 agent 调起的子会话' },
           since: { type: 'string', description: '起始时间，ISO 8601 或相对时间如 7d / 24h / 30m' },
           limit: { type: 'number', description: '返回条数，默认 20', default: 20 },
         },
       },
     },
     {
       name: 'get_session',
       description:
         '获取指定会话的完整内容(消息记录)。支持 live 模式直读源文件获取实时内容、handoff_mode 任务接管模式,以及 include_relations 附带父子/关联会话拓扑。合并旧版 get_session_detail + get_session_relations + yondermesh_get_session。',
       inputSchema: {
         type: 'object',
         properties: {
           session_id: { type: 'string', description: '会话 ID' },
           live: { type: 'boolean', description: '直读源文件获取实时内容(运行中会话也能读到最新)' },
           limit: { type: 'number', description: '只返回最后 N 条消息' },
           include_compacted: { type: 'boolean', description: 'live 模式附 codex 压缩摘要', default: false },
           include_tool_calls: { type: 'boolean', description: 'live 模式保留 function_call', default: false },
           handoff_mode: { type: 'boolean', description: '等价于 live + compacted + tool_calls + 尾部 30 条', default: false },
           include_relations: { type: 'boolean', description: '附带父/子/关联会话拓扑', default: false },
         },
         required: ['session_id'],
       },
     },
     {
       name: 'list_active',
       description:
         '列出当前活跃或等待用户审阅的 AI agent 会话。合并旧版 list_active_sessions + who_is_working + who_is_waiting,附 live/idle/stopped 计数与各 session 运行时摘要。直查数据库,反映最近扫描周期内的状态。',
       inputSchema: {
         type: 'object',
         properties: {
           within_minutes: { type: 'number', description: '查多少分钟内有活动的 session,默认 30', default: 30 },
           include_waiting: { type: 'boolean', description: '附带等待用户审阅的 session,默认 true', default: true },
         },
       },
     },
     {
       name: 'overview',
       description: '获取本机全部 AI agent 会话的统计概览(总数/root/subagent/消息数等)。合并旧版 get_overview。',
       inputSchema: {
         type: 'object',
         properties: {
           since: { type: 'string', description: '只统计此时间之后的数据' },
           project_prefix: { type: 'string', description: '只统计匹配的项目' },
         },
       },
     },
     {
       name: 'handoff',
       description: '为任务接力生成浓缩 handoff 包。直读源文件,返回 codex 压缩后的 compacted 摘要、尾部近况、task_plan、session 元数据与活跃状态。合并旧版 get_session_handoff。',
       inputSchema: {
         type: 'object',
         properties: {
           session_id: { type: 'string', description: '会话 ID(必填)' },
           tail_messages: { type: 'number', description: '尾部含 tool call 的消息条数,默认 30', default: 30 },
         },
         required: ['session_id'],
       },
     },
     {
       name: 'agent_message',
       description:
         '跟其他 agent 会话通信的唯一入口。action=send 发消息，action=check 看发给我的消息。' +
         '不需要知道对方是哪个 CLI，只给 session id（支持 hash / native id / 唯一前缀）。' +
         'delivery 决定什么时候送到：now=立刻（目标在跑则拒绝，因为外部注入会和它自己双写）；' +
         'after_turn=等我这轮结束再发（同一目标的积压会合并成一条，省 token）；' +
         'on_reply=等对方回复完用户那一刻、以用户口吻发给它（适合对正在干活的 agent 提要求）。' +
         '合并旧版 send + mailbox + yondermesh_send + yondermesh_mailbox_* + post_message + get_messages。',
       inputSchema: {
         type: 'object',
         properties: {
           action: { type: 'string', enum: ['send', 'check'], description: 'send=发/check=看，默认 check', default: 'check' },
           to: { type: 'string', description: 'send: 目标 session id，或 "all" 广播' },
           body: { type: 'string', description: 'send: 消息正文' },
           delivery: { type: 'string', enum: ['now', 'after_turn', 'on_reply'], description: 'send: 投递时机，默认 now', default: 'now' },
           reply_to: { type: 'number', description: 'send: 回复某条消息的 id（自动串 thread）' },
           limit: { type: 'number', description: 'check: 最多返回几条，默认 20', default: 20 },
           mark_read: { type: 'boolean', description: 'check: 读完标记已读，默认 true', default: true },
           unread_only: { type: 'boolean', description: 'check: 只看未读，默认 true', default: true },
           self_session_id: { type: 'string', description: 'check: 显式指定自己的 session（不传则自动解析）' },
         },
         required: ['action'],
       },
     },
     {
       name: 'agents',
       description: '列出本机 agent CLI 及其安装状态、采集等级、挂载能力,可选附带挂载详情。合并旧版 yondermesh_list_agents + yondermesh_mount_status。',
       inputSchema: {
         type: 'object',
         properties: {
           installed_only: { type: 'boolean', description: '只返回已安装的,默认 true', default: true },
           include_mounts: { type: 'boolean', description: '附带各 CLI 挂载详情,默认 false', default: false },
         },
       },
     },
   ];

  // 旧版工具（本文件内定义的 handler）
  const legacy: McpToolDef[] = [
     {
       name: 'get_session_detail',
       description:
         '[deprecated, use get_session] 获取指定会话的消息记录。支持 live 模式直接读源文件获取实时内容（正在运行的会话也能读到最新消息）。用于了解某次会话的具体内容和决策过程，或查看另一个 agent 当前在做什么。新增 include_compacted / include_tool_calls / handoff_mode 参数用于任务接管场景（仅 live 模式生效，DB 模式忽略）。',
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
         '[deprecated, use handoff] 专为任务接管设计：提取指定 session 的浓缩 handoff 包。直读源文件，返回 codex 压缩后的 compacted 摘要、最后一条真实 user 消息、尾部近况（保留 function_call/function_call_output/custom_tool_call，带截断）、task_plan（update_plan 等）、session 元数据与活跃状态。用于在另一个 agent 中断或需要接力时，快速获得完整上下文而不丢失 tool 调用细节。',
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
         '[deprecated, use get_session] 查询会话的关系拓扑。返回该会话的父会话、子会话和关联会话。',
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
          '[deprecated, use overview] 获取本机全部 AI agent 会话的统计概览。',
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
          '[deprecated, use list_active] 列出当前正在运行或最近活跃的 AI agent 会话，附带运行时摘要（总数 / live / subagent / by source）。直查数据库，反映最近扫描周期内的状态。',
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
          '[deprecated, use list_active] 快速查询本机当前有哪些 AI agent 正在工作。返回人类可读的摘要，包含正在运行的 session 数量、subagent 数量、每个活跃 session 的简短描述（id / source / 项目目录 / 最近活动时间）。用于任何 agent 在开始任务前快速感知机器上当前的活动状态。',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'who_is_waiting',
        description:
          '[deprecated, use list_active] 查找等待用户审阅回复的 session。返回最后一条消息是 assistant 且近期有活动的 session 列表，每条含消息预览。返回结果附带下一步指引，提示调用方查看这些 session 的内容细节并主动向用户提议操作。',
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
          '[deprecated, use mailbox] 向另一个 agent session 或项目广播发送消息。用于跨 session 通信，例如通知另一个 agent 任务完成、提出建议、或提出问题。消息通过本地 SQLite 共享，目标 agent 可通过 get_messages 读取。',
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
          '[deprecated, use mailbox] 读取发给当前 session 或项目的消息。读取后自动标记为已读。用于接收其他 agent 通过 post_message 发来的跨 session 通信。',
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
   // yondermesh_* 工具:除 whoami 外标 deprecated(指向精简集对应工具)
   const newTools: McpToolDef[] = MCP_TOOLS.map(({ name, description, inputSchema }) => {
     const isKept = name === 'yondermesh_whoami';
     return {
       name,
       description: isKept ? description : makeDeprecated(description, YONDERMESH_DEPRECATED_TARGET[name] ?? ''),
       inputSchema: inputSchema as Record<string, unknown>,
     };
   });

   // ── 对外只暴露 4 个职能工具（看 / 说 / 管 / 标）────────────────────
   //
   // 为什么不再平铺 30 个：它们大多是同一个职能的不同切法（scope/shape 的差别）。
   // 工具面越小、越正交，模型选错的概率越低。
   //
   // 旧的 30 个名字**仍然可以调用**（callTool 的路由没动），只是不再列出来 ——
   // 「可见性 ≠ 可调用性」：不破坏既有调用方，但新会话只看到 4 个。
   void refined;
   void legacy;
   void newTools;
   return this.canonicalTools();
  }

  // -- 工具执行 -----------------------------------------------------------

 async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
   // 先尝试旧版工具路由
   let result: McpToolResult;
   // 精简集工具优先路由(T1.3 精简正交集)
   const refinedResult = await this.tryRefinedTool(name, args);
   if (refinedResult) {
     result = refinedResult;
   } else {
   // 旧通信工具名（send / mailbox_* / post_message / get_messages）统一翻译到
   // agent_message —— 保证「一套逻辑」，旧名只是入口别名，不再各走一套实现。
   const commResult = await this.forwardLegacyComm(name, args);
   if (commResult) {
     result = commResult;
   } else if (name === 'send') {
     // send --mode new / 只给 cli：走旧的启动路径（创建新会话）
     result = await this.forwardTo('yondermesh_send', args);
   } else {
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
   }
   }

   // Channel A: 非 mailbox 工具调用后注入 unread hint
   if (
     !name.startsWith('yondermesh_mailbox_') &&
     !name.startsWith('yondermesh_whoami') &&
     name !== 'agent_message' &&
     name !== 'mailbox' &&
     name !== 'send' &&
     !result.isError
   ) {
      const hint = this.buildUnreadHint(args);
      if (hint) {
        result = { content: result.content + '\n' + hint };
      }
    }

   return result;
 }

  /**
   * 4 个职能工具：看(observe) / 说(message) / 管(orchestrate) / 标(workspace)。
   *
   * 收敛依据见 Obsidian `yondermesh/2-静态资料-static/03 设计-Agent接口收敛`。
   * 每个职能展开后有很多可配场景（见各自 schema），但**动作面只有 4 个**。
   * 每个响应都带一小块「现状」信封（见 situation.ts），模型不用主动查全局。
   */
  private canonicalTools(): McpToolDef[] {
    return [
      {
        name: 'observe',
        description:
          '看——统一的查询与分析入口。scope 选看哪儿（me 我自己 / global 全局总览 / project 整个项目 / session 某个会话 / '
          + 'active 谁在干活 / tree 会话树），filter 只要什么，shape 决定形态。'
          + '筛选是查询的一部分，不用后处理：只看人的话用 roles:["user","assistant"]；'
          + '只要长需求用 min_length:200；排掉工具噪音用 exclude:["tool"]。'
          + '合并旧版 search_sessions / get_session / list_active / overview / extract_project_history / '
          + 'query_user_requirements / query_agent_responses / agents / whoami。',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['me', 'global', 'project', 'session', 'active', 'tree'], description: '看哪儿，默认 global' },
            target: { type: 'string', description: 'scope=session/tree 给 session id；scope=project 给项目路径' },
            shape: { type: 'string', enum: ['list', 'detail', 'summary', 'tree', 'stats'], description: '要什么形态' },
            roles: { type: 'array', items: { type: 'string' }, description: '只要这些角色：user / assistant / system / tool' },
            exclude: { type: 'array', items: { type: 'string' }, description: '排除这些角色，如 ["tool"]' },
            min_length: { type: 'number', description: '只要内容长度 >= 这个字数的' },
            keyword: { type: 'string', description: '关键词模糊匹配' },
            since: { type: 'string', description: '这个时间之后，支持 7d / 24h / 30m 或 ISO' },
            until: { type: 'string', description: '这个时间之前' },
            limit: { type: 'number', description: '最多几条，默认 20', default: 20 },
            offset: { type: 'number', description: '翻页用，默认 0', default: 0 },
            include_agents: { type: 'boolean', description: 'scope=global 时附带 CLI 列表', default: false },
            self_session_id: { type: 'string', description: '显式指定自己的 session（scope=me）' },
          },
          required: ['scope'],
        },
      },
      {
        name: 'message',
        description:
          '说——跟其他 agent 会话通信的唯一入口。不需要知道对方是哪个 CLI，只给 session id。'
          + 'action=send 发 / check 看发给我的。delivery 决定时机：'
          + 'now 立刻发（目标正在跑会被拒绝，外部注入会与它自己双写损坏会话）；'
          + 'after_turn 等我这轮结束再发（积压合并成一条）；'
          + 'on_reply 等对方回复完用户那一刻、以用户口吻发给它。',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['send', 'check'], description: 'send=发 / check=看，默认 check', default: 'check' },
            to: { type: 'string', description: 'send: 目标 session id（支持 hash / native / 前缀），或 "all" 广播' },
            body: { type: 'string', description: 'send: 消息正文' },
            delivery: { type: 'string', enum: ['now', 'after_turn', 'on_reply'], description: 'send: 投递时机，默认 now', default: 'now' },
            reply_to: { type: 'number', description: 'send: 回复某条消息的 id' },
            limit: { type: 'number', description: 'check: 最多几条，默认 20', default: 20 },
            mark_read: { type: 'boolean', description: 'check: 读完标已读，默认 true', default: true },
            unread_only: { type: 'boolean', description: 'check: 只看未读，默认 true', default: true },
            self_session_id: { type: 'string', description: 'check: 显式自己的 session' },
          },
          required: ['action'],
        },
      },
      {
        name: 'orchestrate',
        description:
          '管——我作为上级对下属 agent 的动作。action 选树上的操作：'
          + 'spawn 起新会话（可编排 config.cli/model/effort/cwd，cwd 强烈建议给）；'
          + 'assign 把活派给已有会话（别重复起新的）；'
          + 'handoff 生成接力包交给另一个 agent；'
          + 'await 等某个会话出结果；'
          + 'discuss 拉多个会话互相讨论（必须给不同 model，否则是同一张嘴说三遍）；'
          + 'prior 这事以前有人试过吗；'
          + 'stop 暂不支持（ymesh 不持有别的 agent 的进程句柄）。',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['spawn', 'assign', 'handoff', 'await', 'discuss', 'stop', 'prior'], description: '要做什么' },
            target: { type: 'string', description: 'assign/await/handoff 的目标 session id' },
            brief: { type: 'string', description: '任务描述（spawn/assign/discuss 用）' },
            to: { type: 'array', items: { type: 'string' }, description: 'discuss: 拉哪几个会话进来（>=2）' },
            query: { type: 'string', description: 'prior: 要查的任务/报错文本' },
            delivery: { type: 'string', enum: ['now', 'after_turn', 'on_reply'], description: 'assign/discuss 的投递时机，默认 on_reply' },
            config: {
              type: 'object',
              description: 'spawn 的执行配置',
              properties: {
                cli: { type: 'string', description: '用哪个 CLI 起（spawn 必填）' },
                model: { type: 'string', description: '模型 id' },
                effort: { type: 'string', description: '推理强度 low/medium/high' },
                cwd: { type: 'string', description: '工作目录（强烈建议给）' },
                timeout_ms: { type: 'number', description: '超时毫秒' },
              },
            },
            limit: { type: 'number', description: 'tail/handoff 条数，默认 30' },
            self_session_id: { type: 'string', description: '发送方 session id' },
          },
          required: ['action'],
        },
      },
      {
        name: 'workspace',
        description:
          '标——工作目录的归属与分组（写人的判断，不是读 agent 状态）。'
          + 'project_path 只能从 CLI 的 cwd 自动推出来，但「这几个目录属于同一摊事」「这目录我叫它笔记库」'
          + '是人的判断，机器推不出来，所以需要能写。'
          + 'add/update 标记（label 起名 / group 分组 / note 备注）；list 看已标记；'
          + 'status 看每个标记目录下现在有哪些 agent 在跑；remove 取消标记（不动会话）。',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'status'], description: '做什么' },
            path: { type: 'string', description: '工作目录绝对路径' },
            label: { type: 'string', description: '给它起个名字，如「笔记库」' },
            group: { type: 'string', description: '归到哪一组，如「个人」/「工作」' },
            note: { type: 'string', description: '备注' },
            within_minutes: { type: 'number', description: 'status: 只看最近多久的会话，默认 30', default: 30 },
          },
          required: ['action'],
        },
      },
    ];
  }

  // -- T1.3 精简集工具 ---------------------------------------------------

  /** 精简集工具路由,未匹配返回 null(旧工具路由随后兜底) */
  private async tryRefinedTool(name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
    switch (name) {
      case 'get_session':
        return this.refinedGetSession(args);
      case 'list_active':
        return this.refinedListActive(args);
      case 'overview':
        return this.getOverview(args);
      case 'handoff':
        return this.getSessionHandoff(args);
      case 'observe':
        return this.refinedObserve(args);
      case 'message':
      case 'agent_message':
        return this.refinedAgentMessage(args);
      case 'orchestrate':
        return this.refinedOrchestrate(args);
      case 'workspace':
        return this.refinedWorkspace(args);
      case 'agents':
        return this.refinedAgents(args);
      default:
        return null;
    }
  }

  /** 转发到 MCP_TOOLS 里的某个 yondermesh_* 工具 */
  private async forwardTo(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const tool = findNewTool(toolName);
    if (!tool) {
      return { content: `内部错误: 工具 ${toolName} 未注册`, isError: true };
    }
    const resp = await tool.handler(args);
    return {
      content: resp.content.map((c) => c.text).join('\n'),
      isError: resp.isError,
    };
  }

  /** get_session: 合并 detail + relations
   *  refined 入口统一返回 { messages: [...] } 形态：
   *  getSessionDetail 在 plain live / DB 模式返回裸数组、rich live 模式返回 {messages,...}。
   *  这里把裸数组包成 {messages}，便于 include_relations 附加 relations 字段（否则
   *  在数组上设 .relations 属性会被 JSON.stringify 丢弃）。 */
  private refinedGetSession(args: Record<string, unknown>): McpToolResult {
    const detail = this.getSessionDetail(args);
    if (detail.isError) return detail;
    const parsed: unknown = JSON.parse(detail.content);
    const result: Record<string, unknown> = Array.isArray(parsed)
      ? { messages: parsed }
      : (parsed as Record<string, unknown>);
    if (args.include_relations === true) {
      const rels = this.getSessionRelations({ session_id: args.session_id });
      result.relations = JSON.parse(rels.content);
    }
    return { content: JSON.stringify(result) };
  }

  /** list_active: 合并 active sessions + waiting review */
  private refinedListActive(args: Record<string, unknown>): McpToolResult {
    const withinMin = typeof args.within_minutes === 'number' ? args.within_minutes : 30;
    const withinMs = withinMin * 60_000;
    const summary = this.store.getActiveSessionsSummary(withinMs, detectAliveProcesses);
    const hints = buildActiveSessionHints(
      summary,
      this.store.getSessionsAwaitingReview(withinMs),
    );
    const result: Record<string, unknown> = { ...summary, _hints: hints };
    if (args.include_waiting !== false) {
      const awaiting = this.store.getSessionsAwaitingReview(withinMs);
      result.waiting = awaiting.length;
      result.waiting_sessions = awaiting;
    }
    return { content: JSON.stringify(result) };
  }

  /** mailbox: action 参数分发到旧 mailbox/post_message 工具 */
  /** observe —— 看（统一查询与分析） */
  private async refinedObserve(args: Record<string, unknown>): Promise<McpToolResult> {
    const scope = (typeof args.scope === 'string' ? args.scope : 'global') as
      | 'me' | 'global' | 'project' | 'session' | 'active' | 'tree';
    const shape = typeof args.shape === 'string' ? (args.shape as never) : undefined;
    const res = await observe(
      { store: this.store },
      {
        scope,
        target: typeof args.target === 'string' ? args.target : undefined,
        filter: pickFilter(args),
        shape,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        offset: typeof args.offset === 'number' ? args.offset : undefined,
        includeAgents: args.include_agents === true,
        selfSessionId:
          typeof args.self_session_id === 'string' ? args.self_session_id : undefined,
      },
    );
    return { content: res.text, isError: !res.ok };
  }

  /** orchestrate —— 管（对下属 agent 的动作） */
  private async refinedOrchestrate(args: Record<string, unknown>): Promise<McpToolResult> {
    const action = (typeof args.action === 'string' ? args.action : '') as never;
    if (!action) {
      return { content: 'orchestrate 需要 action', isError: true };
    }
    const config = (args.config ?? {}) as Record<string, unknown>;
    const configObj =
      Object.keys(config).length > 0
        ? {
            cli: typeof config.cli === 'string' ? config.cli : undefined,
            model: typeof config.model === 'string' ? config.model : undefined,
            effort: typeof config.effort === 'string' ? config.effort : undefined,
            cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
            timeoutMs: typeof config.timeout_ms === 'number' ? config.timeout_ms : undefined,
          }
        : undefined;

    const config2 = defaultDaemonConfigSafe();
    const core = new MailboxCore(config2.dbPath, config2.dataDir);
    try {
      const res = await orchestrate(
        { store: this.store, core },
        {
          action,
          target: typeof args.target === 'string' ? args.target : undefined,
          brief: typeof args.brief === 'string' ? args.brief : undefined,
          to: Array.isArray(args.to) ? args.to.map(String) : undefined,
          query: typeof args.query === 'string' ? args.query : undefined,
          config: configObj,
          delivery: typeof args.delivery === 'string' ? (args.delivery as never) : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          selfSessionId:
            typeof args.self_session_id === 'string' ? args.self_session_id : undefined,
        } as never,
      );
      return { content: res.text, isError: !res.ok };
    } finally {
      core.close();
    }
  }

  /** workspace —— 标（工作目录的归属与分组） */
  private async refinedWorkspace(args: Record<string, unknown>): Promise<McpToolResult> {
    const res = workspaceCmd(this.store, {
      action: (typeof args.action === 'string' ? args.action : 'list') as never,
      path: typeof args.path === 'string' ? args.path : undefined,
      label: typeof args.label === 'string' ? args.label : undefined,
      group: typeof args.group === 'string' ? args.group : undefined,
      note: typeof args.note === 'string' ? args.note : undefined,
      withinMinutes: typeof args.within_minutes === 'number' ? args.within_minutes : undefined,
    });
    return { content: res.text, isError: !res.ok };
  }

  /**
   * agent_message —— 跨 session 通信的唯一入口。
   *
   * 旧的 send / mailbox 不再是独立逻辑，而是把参数翻译成这里的一次调用
   * （见 translateLegacyCommArgs）。这样「邮箱」不再是一套要和 send 对齐的
   * 平行语义，收敛成一个动作面：发消息 / 看消息 + 投递时机。
   */
  private async refinedAgentMessage(args: Record<string, unknown>): Promise<McpToolResult> {
    return this.runAgentMessage(args);
  }

  /** 把统一入参跑一遍，返回 MCP 结果 */
  private async runAgentMessage(args: Record<string, unknown>): Promise<McpToolResult> {
    const action = args.action === 'send' ? 'send' : 'check';
    const input = {
      action: action as 'send' | 'check',
      to: typeof args.to === 'string' ? args.to : undefined,
      body: typeof args.body === 'string' ? args.body : undefined,
      delivery:
        args.delivery === 'after_turn' || args.delivery === 'on_reply' || args.delivery === 'now'
          ? (args.delivery as 'now' | 'after_turn' | 'on_reply')
          : undefined,
      replyTo: typeof args.reply_to === 'number' ? args.reply_to : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      markRead: args.mark_read !== false,
      unreadOnly: args.unread_only !== false,
      selfSessionId:
        typeof args.self_session_id === 'string' ? args.self_session_id : undefined,
    };

    const config = defaultDaemonConfigSafe();
    const core = new MailboxCore(config.dbPath, config.dataDir);
    try {
      const result = await agentMessage({ core, store: this.store }, input);
      // 情境包：让模型在通信响应里就看见全局，不用另调一次查询
      const selfId =
        result.action === 'check' ? result.selfSessionId : input.selfSessionId;
      const situation = buildSituation(this.store, selfId ?? null);
      const body = JSON.stringify(result, null, 2);
      return { content: attachSituation(body, situation), isError: result.ok === false };
    } finally {
      core.close();
    }
  }

  /**
   * 旧通信工具名 → agent_message 的翻译层（保持向后兼容，但不再是独立逻辑）。
   *
   * 映射：
   *   send                       → action=send，delivery=now
   *   mailbox / *_mailbox_*      → action=check/post…
   *   post_message / get_messages→ 同上
   */
  private async forwardLegacyComm(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult | null> {
    const unified: Record<string, unknown> = {};
    switch (name) {
      case 'send':
      case 'yondermesh_send':
        // 「起一个新会话」不是"跟已有 session 通信"，统一工具不覆盖它
        //（新会话没有 session id，必须先知道用哪个 CLI）→ 交回旧 handler。
        if (args.mode === 'new' || (!args.session_id && args.cli)) return null;
        unified.action = 'send';
        unified.body = args.message ?? args.body;
        unified.to = args.session_id ?? args.to;
        unified.delivery = args.delivery ?? 'now';
        break;
      case 'mailbox':
        // 统一工具自己的名字：直接透传
        return this.runAgentMessage(args);
      case 'yondermesh_mailbox_check':
        unified.action = 'check';
        unified.self_session_id = args.self_session_id ?? args.for_session_id;
        unified.mark_read = args.mark_read;
        break;
      case 'yondermesh_mailbox_post':
      case 'yondermesh_mailbox_reply':
        unified.action = 'send';
        unified.body = args.body;
        unified.to = args.to_session_id ?? args.to_project ?? 'all';
        unified.reply_to = args.reply_to_id;
        unified.self_session_id = args.from_session_id;
        unified.delivery = args.delivery ?? 'after_turn';
        break;
      default:
        return null;
    }
    return this.runAgentMessage(unified);
  }

  /** agents: 合并 list_agents + mount_status */
  private async refinedAgents(args: Record<string, unknown>): Promise<McpToolResult> {
    const agentsResp = await this.forwardTo('yondermesh_list_agents', args);
    if (args.include_mounts === true) {
      const mountsResp = await this.forwardTo('yondermesh_mount_status', {});
      const data = JSON.parse(agentsResp.content) as Record<string, unknown>;
      data.mounts = JSON.parse(mountsResp.content);
      return { content: JSON.stringify(data) };
    }
    return agentsResp;
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
    // 精简集别名:source 与旧 agent 参数等价,优先 agent(保持向后兼容)
    if (typeof args.source === 'string' && args.source) query.source = args.source;
   if (typeof args.topology === 'string')
      query.topology = args.topology as SessionTopology;

    const since = parseRelativeTime(
      typeof args.since === 'string' ? args.since : undefined,
    );
    if (since !== null) query.startedAtFrom = since;

    const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
    query.limit = Math.min(Math.max(1, rawLimit), 200);

  const sessions = this.store.querySessions(query);

   // 精简集全文检索:query/search 关键字对 session 消息正文做 substring 匹配。
   // store 层无原生 FTS,这里在已过滤的候选上二次过滤;无关键字时行为不变。
   const searchKw =
     typeof args.query === 'string' ? args.query :
     typeof args.search === 'string' ? args.search : '';
   const matched = searchKw
     ? sessions.filter((s) => {
         const lower = searchKw.toLowerCase();
         const msgs = this.store.getMessages(s.id);
         return msgs.some((m) => m.content.toLowerCase().includes(lower));
       })
     : sessions;

   return { content: JSON.stringify(matched.map(formatSessionSummary)) };
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

/** 递归查找包含指定 sessionId 的文件
 *  sessionId 可能是 UUID（`rollout-<uuid>` 文件名一段），也可能是 codex 的
 *  native_session_id 含路径（`2026/04/13/rollout-<uuid>`）。两种都按 basename 匹配。 */
function findSessionFile(dir: string, sessionId: string, _source: string): string | null {
  if (!existsSync(dir)) return null;

  // 取 basename（兼容含路径的 sessionId）；剥掉可能的 .jsonl 后缀，避免双重匹配
  const needle = sessionId.split('/').pop()!.replace(/\.jsonl$/, '');

  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as typeof entries;
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findSessionFile(fullPath, needle, _source);
      if (found) return found;
    } else if (entry.name.includes(needle) && entry.name.endsWith('.jsonl')) {
      return fullPath;
    }
  }

  return null;
}

/** 解析 ISO 字符串或数字时间戳为 number 毫秒；失败返回 undefined */
function parseTimestampMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 秒级时间戳归一化为毫秒
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
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
          // claude JSONL 根级有 timestamp（ISO 字符串），message 内也可能有
          const ts = parseTimestampMs(d.timestamp ?? msg.timestamp);
          messages.push({
            seq: messages.length,
            role: d.type,
            content: text,
            ...(ts !== undefined ? { timestamp: ts } : {}),
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
              // codex JSONL 根级有 timestamp（ISO 字符串）
              const ts = parseTimestampMs(d.timestamp);
              messages.push({
                seq: messages.length,
                role,
                content: text,
                ...(ts !== undefined ? { timestamp: ts } : {}),
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
