/**
 * OpenCode HTTP API wrapper（OpenCodeController）
 *
 * 通过 OpenCode 的 HTTP API（`opencode serve` 启动的本地 server）实时控制运行中的
 * session：启动 / 中途注入 / 中断 / 实时流订阅。同时提供基于 SQLite 直读的 session
 * 提取与中性格式转交能力。
 *
 * 真实 API（OpenCode v1.17.16，`opencode serve --port <p> --hostname 127.0.0.1` 实测）：
 *   POST /session                 创建 session，body {title?, agent?, model?{providerID,id}}
 *                                返回 session JSON（含 id）
 *   GET  /session                 列出当前 server 作用域内的 session（JSON 数组）
 *   GET  /session/{id}            取单个 session 详情（JSON）
 *   GET  /session/{id}/message    取 session 的全部消息（JSON 数组，含 parts）
 *   POST /session/{id}/prompt_async  异步注入 prompt（中途注入正在运行的 session）
 *                                body {model:{providerID, modelID}, parts:[{type:"text",text}]}
 *                                成功返回空 200（非 JSON）；model 字段需对象且键为 modelID
 *   POST /session/{id}/abort     中断正在运行的 session，返回 true
 *   GET  /event                   Server-Sent Events 全局事件流（data: {json}\n\n）
 *                                事件含 type（session.message.updated 等）与 properties.sessionID
 *   GET  /config | /agent | /mcp  配置 / agent / MCP 状态（JSON）
 *
 * server 未运行时：launch 可选自动 `opencode serve`（spawn 子进程）；其余 API 方法
 * 抛出 server 不可达错误。session 提取 / 列表 / 转交优先直读 SQLite DB（不依赖 server）。
 */

import { createRequire } from 'node:module';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { resolveOpenCodeDbPath } from './importer.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** OpenCode session info（GET /session/{id} 返回结构的精简） */
export interface OpenCodeSessionInfo {
  id: string;
  slug?: string;
  projectID?: string;
  directory?: string;
  path?: string;
  title?: string;
  agent?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  version?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number; updated?: number };
  parentID?: string;
}

/** OpenCode message（GET /session/{id}/message 元素） */
export interface OpenCodeMessage {
  info: {
    id: string;
    sessionID: string;
    role: string;
    time?: { created?: number };
    agent?: string;
    model?: { providerID?: string; modelID?: string };
  };
  parts: Array<{
    id?: string;
    type: string;
    text?: string;
    sessionID?: string;
    messageID?: string;
  }>;
}

/** 中性格式：跨 agent 转交的标准化 session 表示 */
export interface NeutralSession {
  source: 'opencode';
  nativeSessionId: string;
  title?: string;
  cwd?: string;
  projectPath?: string;
  agent?: string;
  model?: string;
  cliVersion?: string;
  topology: 'root' | 'subagent';
  parentNativeId?: string;
  startedAt?: number;
  endedAt?: number;
  costUsd?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  toolCallCount?: number;
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    timestamp?: number;
  }>;
}

/** Controller 选项 */
export interface OpenCodeControllerOptions {
  /** server 基址，如 http://127.0.0.1:4096；未指定则按 port/hostname 推导 */
  baseUrl?: string;
  /** server 端口（baseUrl 未指定时用） */
  port?: number;
  /** server hostname（默认 127.0.0.1） */
  hostname?: string;
  /** OpenCode DB 路径（extract/list/transfer 直读），默认 resolveOpenCodeDbPath() */
  dbPath?: string;
  /** launch 时若 server 不可达，是否自动 spawn `opencode serve`，默认 false */
  autoServe?: boolean;
  /** OPENCODE_SERVER_PASSWORD（若 server 设了密码鉴权） */
  password?: string;
}

/** 默认 server 地址 */
const DEFAULT_HOSTNAME = '127.0.0.1';

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * OpenCode 运行时控制器：HTTP API wrapper + SQLite 直读。
 *
 * 用法：
 *   const c = new OpenCodeController({ baseUrl: 'http://127.0.0.1:4096' });
 *   const s = await c.launch('do something');
 *   await c.inject(s.id, 'extra context');
 *   for await (const ev of c.getStream(s.id)) console.log(ev);
 */
export class OpenCodeController {
  private readonly baseUrl: string;
  private readonly dbPath: string;
  private readonly autoServe: boolean;
  private readonly password?: string;
  /** 已自动 spawn 的 server 子进程（用于关闭） */
  private servedProcess?: ReturnType<typeof spawn>;

  constructor(options: OpenCodeControllerOptions = {}) {
    const hostname = options.hostname ?? DEFAULT_HOSTNAME;
    const port = options.port ?? 0;
    this.baseUrl =
      options.baseUrl ??
      (port > 0 ? `http://${hostname}:${port}` : `http://${hostname}`);
    this.dbPath = resolveOpenCodeDbPath({ dbPath: options.dbPath });
    this.autoServe = options.autoServe ?? false;
    this.password = options.password;
  }

  // ─── HTTP API：session 控制 ──────────────────────────────────────────

  /**
   * 启动一个新 session 并注入初始 prompt。
   * server 不可达且 autoServe=true 时自动 spawn `opencode serve`。
   * 返回创建的 session info。
   */
  async launch(prompt: string, opts?: {
    title?: string;
    agent?: string;
    model?: { providerID: string; id: string };
  }): Promise<OpenCodeSessionInfo> {
    await this.ensureServer();

    const body: Record<string, unknown> = {};
    if (opts?.title) body.title = opts.title;
    if (opts?.agent) body.agent = opts.agent;
    if (opts?.model) body.model = opts.model;

    const session = await this.httpJson<OpenCodeSessionInfo>('POST', '/session', body);
    if (!session.id) throw new Error('launch: server 未返回 session id');

    // 注入初始 prompt（异步）
    if (prompt.length > 0) {
      await this.inject(session.id, prompt, opts?.model);
    }
    return session;
  }

  /**
   * 中途注入消息到正在运行的 session（POST /session/{id}/prompt_async）。
   * 这是 ymesh 实时影响运行中 OpenCode session 的核心入口。
   * message 非空时注入；空 message 仅探测可达性。
   */
  async inject(
    sessionId: string,
    message: string,
    model?: { providerID: string; id: string },
  ): Promise<void> {
    await this.ensureServer();
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: message }],
    };
    if (model) {
      // API 要求 model 对象键为 modelID（而非 id）
      body.model = { providerID: model.providerID, modelID: model.id };
    }
    await this.httpJson('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
  }

  /** 中断正在运行的 session（POST /session/{id}/abort）。返回是否成功。 */
  async interrupt(sessionId: string): Promise<boolean> {
    await this.ensureServer();
    try {
      const res = await this.httpJson<boolean>(
        'POST',
        `/session/${encodeURIComponent(sessionId)}/abort`,
      );
      return res === true;
    } catch (e) {
      // session 未运行 / 已结束 → abort 无意义，不视为致命错误
      throw new Error(`interrupt 失败 (${sessionId}): ${errorMessage(e)}`);
    }
  }

  /** 获取单个 session 详情（GET /session/{id}）。 */
  async getSession(sessionId: string): Promise<OpenCodeSessionInfo> {
    await this.ensureServer();
    return this.httpJson<OpenCodeSessionInfo>(
      'GET',
      `/session/${encodeURIComponent(sessionId)}`,
    );
  }

  /** 获取 session 的消息（GET /session/{id}/message）。 */
  async getMessages(sessionId: string): Promise<OpenCodeMessage[]> {
    await this.ensureServer();
    return this.httpJson<OpenCodeMessage[]>(
      'GET',
      `/session/${encodeURIComponent(sessionId)}/message`,
    );
  }

  /**
   * 订阅实时事件流（SSE GET /event）。
   * 返回异步迭代器：逐事件 yield（已解析为对象）。
   * sessionId 非空时只 yield 含该 session 的事件（按 properties.sessionID 过滤）。
   * 调用方 `for await (const ev of controller.getStream(sid))`；break/return 即断开。
   *
   * 事件结构示例：
   *   { id, type: "session.message.updated", properties: { sessionID, ... } }
   */
  async *getStream(
    sessionId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>, void, unknown> {
    await this.ensureServer();
    const url = new URL('/event', this.baseUrl);
    const req = http.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...(this.password ? { Authorization: `Bearer ${this.password}` } : {}),
        },
        signal,
      },
    );
    req.end();

    yield* consumeSSE(req, sessionId);
  }

  // ─── SQLite 直读：session 提取 / 列表 / 转交 ─────────────────────────

  /**
   * 列出本地全部 session（直读 SQLite，不依赖 server）。
   * 合并 DB 全量 session 与（可选）server 在线 session。
   * server 不可达时仅返回 DB 数据。
   */
  async listSessions(): Promise<OpenCodeSessionInfo[]> {
    const fromDb = this.listSessionsFromDb();
    let fromApi: OpenCodeSessionInfo[] = [];
    try {
      await this.ensureServer(false);
      fromApi = await this.httpJson<OpenCodeSessionInfo[]>('GET', '/session');
    } catch {
      // server 不可达 → 仅返回 DB 数据
    }
    // 合并去重（以 DB 为准，API 补充 DB 没有的 live session）
    const seen = new Set(fromDb.map((s) => s.id));
    for (const s of fromApi) {
      if (!seen.has(s.id)) fromDb.push(s);
    }
    return fromDb;
  }

  /**
   * 提取单个 session 的完整内容（直读 SQLite：session + message + part）。
   * 不依赖 server，适合离线分析 / 转交。
   */
  extractSession(sessionId: string): NeutralSession {
    const ocdb = this.openDb();
    try {
      const s = ocdb
        .prepare(
          `SELECT id, parent_id, directory, title, version, model, cost,
                  tokens_input, tokens_output, tokens_reasoning,
                  tokens_cache_read, tokens_cache_write,
                  time_created, time_updated, time_archived, project_id, agent
           FROM session WHERE id = ?`,
        )
        .get(sessionId) as {
          id: string;
          parent_id: string | null;
          directory: string | null;
          title: string | null;
          version: string | null;
          model: string | null;
          cost: number | null;
          tokens_input: number | null;
          tokens_output: number | null;
          tokens_reasoning: number | null;
          tokens_cache_read: number | null;
          tokens_cache_write: number | null;
          time_created: number | null;
          time_updated: number | null;
          time_archived: number | null;
          project_id: string | null;
          agent: string | null;
        } | undefined;
      if (!s) throw new Error(`session 不存在: ${sessionId}`);

      const projectPath = s.project_id
        ? ((ocdb
            .prepare('SELECT worktree FROM project WHERE id = ?')
            .get(s.project_id) as { worktree?: string } | undefined)?.worktree ?? undefined)
        : undefined;

      const msgStmt = ocdb.prepare(
        `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id`,
      );
      const partStmt = ocdb.prepare(
        `SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id`,
      );
      const msgRows = msgStmt.all(sessionId) as unknown as Array<{
        id: string;
        time_created: number | null;
        data: string;
      }>;
      const messages: NeutralSession['messages'] = [];
      let toolCallCount = 0;
      for (const m of msgRows) {
        let role = '';
        try {
          const data = JSON.parse(m.data) as { role?: unknown };
          role = typeof data.role === 'string' ? data.role : '';
        } catch {
          continue;
        }
        if (role !== 'user' && role !== 'assistant') continue;
        const partRows = partStmt.all(m.id) as unknown as Array<{ data: string }>;
        const textParts: string[] = [];
        for (const p of partRows) {
          try {
            const pdata = JSON.parse(p.data) as { type?: unknown; text?: unknown };
            if (pdata.type === 'text' && typeof pdata.text === 'string' && pdata.text.length > 0) {
              textParts.push(pdata.text);
            } else if (pdata.type === 'tool') {
              toolCallCount++;
            }
          } catch {
            // 脏 part 跳过
          }
        }
        if (textParts.length === 0) continue;
        messages.push({
          role,
          content: textParts.join('\n'),
          timestamp: m.time_created ?? undefined,
        });
      }

      let model: string | undefined;
      if (s.model) {
        try {
          const mo = JSON.parse(s.model) as { id?: string };
          model = typeof mo.id === 'string' ? mo.id : undefined;
        } catch {
          model = s.model;
        }
      }

      return {
        source: 'opencode',
        nativeSessionId: s.id,
        title: s.title ?? undefined,
        cwd: s.directory ?? undefined,
        projectPath,
        agent: s.agent ?? undefined,
        model,
        cliVersion: s.version ?? undefined,
        topology: s.parent_id ? 'subagent' : 'root',
        parentNativeId: s.parent_id ?? undefined,
        startedAt: s.time_created ?? undefined,
        endedAt: s.time_archived ?? undefined,
        costUsd: s.cost ?? undefined,
        tokens: {
          input: s.tokens_input ?? undefined,
          output: s.tokens_output ?? undefined,
          reasoning: s.tokens_reasoning ?? undefined,
          cacheRead: s.tokens_cache_read ?? undefined,
          cacheWrite: s.tokens_cache_write ?? undefined,
        },
        toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
        messages,
      };
    } finally {
      ocdb.close();
    }
  }

  /**
   * 转换 session 为中性格式（跨 agent 转交）。
   * 即 extractSession 的别名 —— 显式表达"转交"语义。
   * 若 server 在线，可选用 `opencode export` 走官方导出（含更全字段）。
   */
  transferSession(sessionId: string): NeutralSession {
    return this.extractSession(sessionId);
  }

  /** 关闭自动 spawn 的 server 子进程（如有） */
  close(): void {
    if (this.servedProcess) {
      this.servedProcess.kill();
      this.servedProcess = undefined;
    }
  }

  // ─── 私有助手 ────────────────────────────────────────────────────────

  /** 以 readOnly 打开 OpenCode DB */
  private openDb(): DatabaseSyncType {
    return new DatabaseSync(this.dbPath, { readOnly: true });
  }

  /** 直读 DB 列出全部 session（精简字段，适合列表展示） */
  private listSessionsFromDb(): OpenCodeSessionInfo[] {
    let ocdb: DatabaseSyncType;
    try {
      ocdb = this.openDb();
    } catch {
      return []; // DB 不可读 → 空列表
    }
    try {
      const rows = ocdb
        .prepare(
          `SELECT id, parent_id, directory, title, version, model, cost,
                  tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
                  time_created, time_updated, time_archived, project_id, agent
           FROM session ORDER BY time_created DESC`,
        )
        .all() as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => rowToSessionInfo(r));
    } finally {
      ocdb.close();
    }
  }

  /**
   * 确保 server 可达。不可达且 autoServe=true 时 spawn `opencode serve`。
   * throwOnUnreachable=true（默认）时不可达抛错；否则静默返回。
   */
  private async ensureServer(throwOnUnreachable = true): Promise<void> {
    if (await this.isReachable()) return;
    if (!this.autoServe) {
      if (throwOnUnreachable) {
        throw new Error(
          `OpenCode server 不可达: ${this.baseUrl}（用 opencode serve 启动，或 autoServe:true）`,
        );
      }
      return;
    }
    await this.spawnServer();
  }

  /** 探测 server 是否可达（GET /config 轻量探测） */
  private async isReachable(): Promise<boolean> {
    try {
      const res = await fetch(new URL('/config', this.baseUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** spawn `opencode serve` 并等待就绪（最多 8s） */
  private async spawnServer(): Promise<void> {
    const port = this.derivePort();
    const args = ['serve'];
    if (port > 0) args.push('--port', String(port));
    args.push('--hostname', DEFAULT_HOSTNAME);
    this.servedProcess = spawn('opencode', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    // 等待就绪：轮询 /config
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      if (await this.isReachable()) return;
    }
    throw new Error(`opencode serve 启动超时（${this.baseUrl}）`);
  }

  /** 从 baseUrl 提取端口 */
  private derivePort(): number {
    try {
      const u = new URL(this.baseUrl);
      const p = Number(u.port);
      return Number.isFinite(p) && p > 0 ? p : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 通用 JSON HTTP 请求。非 2xx 抛错（含 OpenCode 错误体）。
   * 成功但无 body（如 prompt_async 返回空）→ 返回 null。
   */
  private async httpJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.password ? { Authorization: `Bearer ${this.password}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        // ignore
      }
      throw new Error(`OpenCode API ${method} ${path} → ${res.status}: ${detail.slice(0, 300)}`);
    }
    const text = await res.text();
    if (text.length === 0) return null as T;
    return JSON.parse(text) as T;
  }
}

// ─── 模块级助手 ─────────────────────────────────────────────────────────

/** 消费 SSE 流（http.request 的响应），逐事件解析并按 session 过滤 */
function consumeSSE(
  req: http.ClientRequest,
  sessionId: string | undefined,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  return (async function* () {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
    });
    let buffer = '';
    for await (const chunk of res) {
      buffer += chunk.toString();
      // SSE 事件以空行分隔
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSSEBlock(block);
        if (!ev) continue;
        // 按 session 过滤（事件 properties.sessionID 或 session.id）
        if (sessionId) {
          const sid =
            (ev.properties as { sessionID?: string } | undefined)?.sessionID ??
            (ev.session as { id?: string } | undefined)?.id;
          if (sid !== sessionId) continue;
        }
        yield ev;
      }
    }
  })();
}

/** 解析一个 SSE 块为事件对象（data: 行拼成 JSON） */
function parseSSEBlock(block: string): Record<string, unknown> | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** DB 行 → OpenCodeSessionInfo（精简） */
function rowToSessionInfo(r: Record<string, unknown>): OpenCodeSessionInfo {
  let model: OpenCodeSessionInfo['model'];
  if (typeof r.model === 'string') {
    try {
      model = JSON.parse(r.model as string);
    } catch {
      model = undefined;
    }
  }
  return {
    id: r.id as string,
    parentID: (r.parent_id as string) || undefined,
    directory: (r.directory as string) || undefined,
    title: (r.title as string) || undefined,
    agent: (r.agent as string) || undefined,
    model,
    version: (r.version as string) || undefined,
    cost: (r.cost as number) || undefined,
    tokens: {
      input: (r.tokens_input as number) || undefined,
      output: (r.tokens_output as number) || undefined,
      cache: {
        read: (r.tokens_cache_read as number) || undefined,
        write: (r.tokens_cache_write as number) || undefined,
      },
    },
    time: {
      created: (r.time_created as number) || undefined,
      updated: (r.time_updated as number) || undefined,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
