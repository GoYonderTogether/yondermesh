/**
 * 本地服务器接入层（src/web/）
 *
 * 零依赖 node:http server，包一层 SessionStore，给前端提供真实数据。
 * 只绑 127.0.0.1（local-first，ARCHITECTURE §III invariant）。
 *
 * 端点：
 *   GET /api/state          — 组合快照（stats + active + recent sessions）
 *   GET /api/sessions       — 列表查询（支持 ?limit= & ?source= & ?include_subagents=）
 *   GET /api/active         — 活跃 session 摘要（最近 30 分钟）
 *   GET /api/stats          — 统计
 *   GET /api/extracts/:hash — 按 contentHash 查 session 的消息内容
 *
 * 不依赖 store schema 修改；只读 store。零新依赖（node:http）。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SessionStore } from '../store/index.js';

/** Web server 配置 */
export interface WebServerOptions {
  /** 监听端口；默认 0 = 随机可用端口（测试友好） */
  port?: number;
  /**
   * 自定义 hostname。默认 127.0.0.1（local-first）。
   * 生产环境不建议改为 0.0.0.0——会暴露到网络。
   */
  hostname?: string;
  /** 活跃 session 检测窗口（ms），默认 30 分钟 */
  activeWithinMs?: number;
  /** 默认列表 limit，默认 50 */
  defaultLimit?: number;
  /** 最大 limit，默认 500 */
  maxLimit?: number;
}

/** listen() 返回的实际监听信息 */
export interface ListenInfo {
  port: number;
  hostname: string;
}

const DEFAULT_ACTIVE_WITHIN_MS = 30 * 60_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * 本地 web server。包一层 SessionStore 暴露 REST 端点。
 *
 * 用法：
 * ```ts
 * const server = new WebServer(store, { port: 7421 });
 * const info = await server.listen();
 * console.log(`listening on http://${info.hostname}:${info.port}`);
 * // ... 后续 await server.close();
 * ```
 */
export class WebServer {
  private readonly store: SessionStore;
  private readonly port: number;
  private readonly hostname: string;
  private readonly activeWithinMs: number;
  private readonly defaultLimit: number;
  private readonly maxLimit: number;
  private server: Server | null = null;

  constructor(store: SessionStore, opts: WebServerOptions = {}) {
    this.store = store;
    this.port = opts.port ?? 0;
    // local-first：默认只绑 127.0.0.1，禁止默认暴露到网络
    this.hostname = opts.hostname ?? '127.0.0.1';
    this.activeWithinMs = opts.activeWithinMs ?? DEFAULT_ACTIVE_WITHIN_MS;
    this.defaultLimit = opts.defaultLimit ?? DEFAULT_LIMIT;
    this.maxLimit = opts.maxLimit ?? MAX_LIMIT;
  }

  /** 启动监听。返回实际监听的 port + hostname。 */
  listen(): Promise<ListenInfo> {
    if (this.server) {
      return Promise.reject(new Error('web server already listening'));
    }
    this.server = createServer((req, res) => {
      // handler 是 async，但 createServer 不 await；内部 try/catch 兜底
      this.handle(req, res).catch((err) => {
        try {
          this.json(res, 500, { error: `internal: ${String(err)}` });
        } catch {
          // res 已发送，忽略
        }
      });
    });
    return new Promise<ListenInfo>((resolve, reject) => {
      const server = this.server!;
      server.on('error', reject);
      server.listen(this.port, this.hostname, () => {
        const addr = server.address();
        const actualPort =
          typeof addr === 'object' && addr !== null ? addr.port : this.port;
        resolve({ port: actualPort, hostname: this.hostname });
      });
    });
  }

  /** 关闭监听。幂等。 */
  close(): Promise<void> {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    return new Promise<void>((resolve) => {
      server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /** 是否正在监听 */
  isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  // ---------------------------------------------------------------------------
  // 路由
  // ---------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.hostname}:${this.port}`);
    const path = url.pathname;

    // CORS：允许本地前端（如 Vite dev server）跨域访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      this.json(res, 405, { error: `method ${req.method} not allowed; use GET` });
      return;
    }

    if (path === '/api/state') return this.handleState(res);
    if (path === '/api/sessions') return this.handleSessions(res, url);
    if (path === '/api/active') return this.handleActive(res);
    if (path === '/api/stats') return this.handleStats(res);
    if (path.startsWith('/api/extracts/')) return this.handleExtract(res, path);

    this.json(res, 404, { error: 'not found', path });
  }

  // GET /api/state — 组合快照
  private handleState(res: ServerResponse): void {
    const stats = this.store.getSessionStats({});
    const activeSummary = this.store.getActiveSessionsSummary(this.activeWithinMs);
    const recentSessions = this.store.querySessions({ limit: 10 });
    this.json(res, 200, {
      syncedAt: new Date().toISOString(),
      stats,
      activeSummary,
      recentSessions,
    });
  }

  // GET /api/sessions — 列表查询
  private handleSessions(res: ServerResponse, url: URL): void {
    const limit = this.parseLimit(url.searchParams.get('limit'));
    const source = url.searchParams.get('source') ?? undefined;
    const includeSubagents = url.searchParams.get('include_subagents') === 'true';

    const query: Record<string, unknown> = { limit };
    if (source) query.source = source;
    if (!includeSubagents) query.topology = 'root';

    const sessions = this.store.querySessions(query as Parameters<SessionStore['querySessions']>[0]);
    const stats = this.store.getSessionStats(query as Parameters<SessionStore['getSessionStats']>[0]);
    this.json(res, 200, { sessions, stats, count: sessions.length });
  }

  // GET /api/active — 活跃 session 摘要
  private handleActive(res: ServerResponse): void {
    const summary = this.store.getActiveSessionsSummary(this.activeWithinMs);
    this.json(res, 200, summary);
  }

  // GET /api/stats — 统计
  private handleStats(res: ServerResponse): void {
    const stats = this.store.getSessionStats({});
    this.json(res, 200, stats);
  }

  // GET /api/extracts/:hash — 按 contentHash 查 session 消息
  private handleExtract(res: ServerResponse, path: string): void {
    const hash = decodeURIComponent(path.slice('/api/extracts/'.length));
    if (!hash) {
      this.json(res, 400, { error: 'missing hash in path' });
      return;
    }

    // store 无原生 by-hash 查询；拉全部后过滤（v0 够用，列表已 limit）
    const all = this.store.querySessions({ limit: this.maxLimit });
    const matched = all.filter((s) => s.contentHash === hash);

    if (matched.length === 0) {
      this.json(res, 404, { error: 'extract not found', hash });
      return;
    }

    // 取第一个匹配的 session 的消息
    const session = matched[0]!;
    const messages = this.store.getMessages(session.id);
    this.json(res, 200, {
      hash,
      session,
      messages,
      count: messages.length,
    });
  }

  // ---------------------------------------------------------------------------
  // 辅助
  // ---------------------------------------------------------------------------

  private parseLimit(raw: string | null): number {
    const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n <= 0) return this.defaultLimit;
    return Math.min(n, this.maxLimit);
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

/**
 * 便捷函数：创建并启动一个 web server，返回 { server, info, close }。
 * 适合一次性脚本 / CLI 命令使用。
 */
export async function startWebServer(
  store: SessionStore,
  opts: WebServerOptions = {},
): Promise<{ server: WebServer; info: ListenInfo; close: () => Promise<void> }> {
  const server = new WebServer(store, opts);
  const info = await server.listen();
  return {
    server,
    info,
    close: () => server.close(),
  };
}
