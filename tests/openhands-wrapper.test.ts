/**
 * OpenHands HTTP API Wrapper 契约测试
 *
 * 覆盖验收门：
 *   1. launch 创建会话：POST /api/conversations，返回 conversationId
 *   2. inject 注入消息：POST /api/conversations/{id}/messages
 *   3. interrupt 中途介入：POST /api/conversations/{id}/interrupt
 *   4. fork 分叉会话：POST /api/conversations/{id}/fork
 *   5. pause / run 暂停与恢复
 *   6. getStatus 获取状态
 *   7. listConversations 列出会话
 *   8. ping 探测可达性
 *   9. GLM-5.2 模型参数透传（llmModel='anthropic/glm-5.2'）
 *  10. 服务器不可达时返回 ok=false（不抛出）
 *
 * 使用 Node 内置 http 模块启动 mock 服务器，验证 wrapper 的请求构造与响应解析。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenHandsApiWrapper } from '../src/openhands/index.js';
import type { ApiResult, LaunchedConversation } from '../src/openhands/index.js';

/** mock 服务器记录的请求 */
interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

let server: http.Server;
let baseUrl: string;
const requests: RecordedRequest[] = [];

/** 路由处理器：根据 method+path 返回 { status, body } */
function handleReq(
  method: string,
  pathname: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
): { status: number; body: unknown } {
  // POST /api/conversations — launch
  if (method === 'POST' && pathname === '/api/conversations') {
    const b = body as Record<string, unknown>;
    return {
      status: 200,
      body: { conversation_id: `conv-${Date.now()}`, llm_model: b.llm_model ?? 'default' },
    };
  }
  // POST /api/conversations/{id}/messages — inject
  if (method === 'POST' && pathname.match(/^\/api\/conversations\/[^/]+\/messages$/)) {
    return { status: 200, body: { ok: true, message: 'injected' } };
  }
  // POST /api/conversations/{id}/interrupt
  if (method === 'POST' && pathname.match(/^\/api\/conversations\/[^/]+\/interrupt$/)) {
    return { status: 200, body: { ok: true, interrupted: true } };
  }
  // POST /api/conversations/{id}/fork
  if (method === 'POST' && pathname.match(/^\/api\/conversations\/[^/]+\/fork$/)) {
    return { status: 200, body: { new_conversation_id: 'forked-conv-123' } };
  }
  // POST /api/conversations/{id}/pause
  if (method === 'POST' && pathname.match(/^\/api\/conversations\/[^/]+\/pause$/)) {
    return { status: 200, body: { ok: true, paused: true } };
  }
  // POST /api/conversations/{id}/run
  if (method === 'POST' && pathname.match(/^\/api\/conversations\/[^/]+\/run$/)) {
    return { status: 200, body: { ok: true, running: true } };
  }
  // GET /api/conversations/{id} — getStatus
  if (method === 'GET' && pathname.match(/^\/api\/conversations\/[^/]+$/)) {
    return { status: 200, body: { conversation_id: 'test-conv', status: 'running' } };
  }
  // GET /api/conversations — list
  if (method === 'GET' && pathname === '/api/conversations') {
    return { status: 200, body: [{ conversation_id: 'conv-1' }, { conversation_id: 'conv-2' }] };
  }
  // GET /health — ping
  if (method === 'GET' && pathname === '/health') {
    return { status: 200, body: { status: 'ok' } };
  }
  return { status: 404, body: { error: 'not found' } };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      let parsedBody: unknown = undefined;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
      }
      const pathname = req.url ?? '/';
      requests.push({
        method: req.method ?? 'GET',
        path: pathname,
        body: parsedBody,
        headers: req.headers,
      });
      const { status, body } = handleReq(req.method ?? 'GET', pathname, parsedBody, req.headers);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('OpenHands HTTP API Wrapper 契约测试', () => {
  let api: OpenHandsApiWrapper;

  beforeAll(() => {
    api = new OpenHandsApiWrapper({ baseUrl, timeoutMs: 5_000 });
  });

  // ── 验收门 1：launch 创建会话 ───────────────────────────────────────────

  it('launch 创建会话：POST /api/conversations，返回 conversationId', async () => {
    requests.length = 0;
    const res: ApiResult<LaunchedConversation> = await api.launch({
      initialUserMsg: 'hello',
      llmModel: 'anthropic/glm-5.2',
      agent: 'codeact',
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
    expect(typeof res.data!.conversationId).toBe('string');
    expect(res.data!.conversationId.length).toBeGreaterThan(0);

    // 验证请求构造
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.path).toBe('/api/conversations');
    const body = requests[0]!.body as Record<string, unknown>;
    expect(body.initial_user_msg).toBe('hello');
    expect(body.llm_model).toBe('anthropic/glm-5.2');
    expect(body.agent).toBe('codeact');
  });

  // ── 验收门 9：GLM-5.2 模型参数透传 ──────────────────────────────────────

  it('GLM-5.2 模型参数透传：llmModel="anthropic/glm-5.2" 写入 llm_model', async () => {
    requests.length = 0;
    await api.launch({ llmModel: 'anthropic/glm-5.2' });
    const body = requests[0]!.body as Record<string, unknown>;
    expect(body.llm_model).toBe('anthropic/glm-5.2');
  });

  // ── 验收门 2：inject 注入消息 ───────────────────────────────────────────

  it('inject 注入消息：POST /api/conversations/{id}/messages', async () => {
    requests.length = 0;
    const res = await api.inject('conv-123', 'follow up message');

    expect(res.ok).toBe(true);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.path).toBe('/api/conversations/conv-123/messages');
    const body = requests[0]!.body as Record<string, unknown>;
    expect(body.message).toBe('follow up message');
  });

  // ── 验收门 3：interrupt 中途介入 ────────────────────────────────────────

  it('interrupt 中途介入：POST /api/conversations/{id}/interrupt', async () => {
    requests.length = 0;
    const res = await api.interrupt('conv-456');

    expect(res.ok).toBe(true);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.path).toBe('/api/conversations/conv-456/interrupt');
  });

  // ── 验收门 4：fork 分叉会话 ─────────────────────────────────────────────

  it('fork 分叉会话：POST /api/conversations/{id}/fork，返回新 conversationId', async () => {
    requests.length = 0;
    const res: ApiResult<LaunchedConversation> = await api.fork('conv-789');

    expect(res.ok).toBe(true);
    expect(res.data).toBeDefined();
    expect(res.data!.conversationId).toBe('forked-conv-123');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.path).toBe('/api/conversations/conv-789/fork');
  });

  // ── 验收门 5：pause / run 暂停与恢复 ────────────────────────────────────

  it('pause 暂停会话：POST /api/conversations/{id}/pause', async () => {
    requests.length = 0;
    const res = await api.pause('conv-pause');

    expect(res.ok).toBe(true);
    expect(requests[0]!.path).toBe('/api/conversations/conv-pause/pause');
  });

  it('run 恢复会话：POST /api/conversations/{id}/run', async () => {
    requests.length = 0;
    const res = await api.run('conv-run');

    expect(res.ok).toBe(true);
    expect(requests[0]!.path).toBe('/api/conversations/conv-run/run');
  });

  // ── 验收门 6：getStatus 获取状态 ────────────────────────────────────────

  it('getStatus 获取状态：GET /api/conversations/{id}', async () => {
    requests.length = 0;
    const res = await api.getStatus('conv-status');

    expect(res.ok).toBe(true);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.path).toBe('/api/conversations/conv-status');
  });

  // ── 验收门 7：listConversations 列出会话 ────────────────────────────────

  it('listConversations 列出会话：GET /api/conversations', async () => {
    requests.length = 0;
    const res = await api.listConversations();

    expect(res.ok).toBe(true);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.path).toBe('/api/conversations');
    const data = res.data as Array<{ conversation_id: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
  });

  // ── 验收门 8：ping 探测可达性 ───────────────────────────────────────────

  it('ping 探测可达性：可达时返回 true', async () => {
    const reachable = await api.ping();
    expect(reachable).toBe(true);
  });

  // ── 验收门 10：服务器不可达时返回 ok=false ──────────────────────────────

  it('服务器不可达时返回 ok=false（不抛出）', async () => {
    const dead = new OpenHandsApiWrapper({
      baseUrl: 'http://127.0.0.1:1', // 端口 1 不可达
      timeoutMs: 1_000,
    });
    const res = await dead.launch({ initialUserMsg: 'test' });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('ping 不可达时返回 false', async () => {
    const dead = new OpenHandsApiWrapper({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 500,
    });
    const reachable = await dead.ping();
    expect(reachable).toBe(false);
  });
});
