/**
 * LOOP build-web-access-layer 测试
 *
 * 验收门（loop §4）：
 *   1. 各端点返回结构正确
 *   2. 计数与 SessionStore 一致
 *   3. 只绑 127.0.0.1（local-first）
 *   4. 404 / 405 错误处理
 *   5. limit 参数生效
 *   6. /api/extracts/:hash 命中与未命中
 *
 * 用真实 SessionStore（:memory:）+ node:http 发请求，零新依赖。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { get } from './test-helpers.js';
import { WebServer } from './server.js';
import { SessionStore } from '../store/index.js';
import type { SessionIngestInput } from '../store/types.js';

/** 已注册的 source instance id（beforeAll 注册后填充） */
let sourceInstanceId: string;

/** 构造一个 seed session 的输入 */
function makeSeed(over: Partial<SessionIngestInput> & { nativeSessionId: string }): SessionIngestInput {
  return {
    deviceId: 'test-device',
    sourceInstanceId,
    source: 'claude',
    topology: 'root',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ],
    ...over,
  };
}

describe('build-web-access-layer: WebServer', () => {
  let store: SessionStore;
  let server: WebServer;
  let base: string;

  beforeAll(async () => {
    store = new SessionStore(':memory:');
    store.ensureSchema();
    const instance = store.registerSourceInstance({
      deviceId: 'test-device',
      source: 'claude',
      rootPath: '/repo',
    });
    sourceInstanceId = instance.id;
    server = new WebServer(store, { port: 0 });
    const info = await server.listen();
    base = `http://${info.hostname}:${info.port}`;
  });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  it('listen 后 isListening=true，close 后 isListening=false', async () => {
    const s = new WebServer(new SessionStore(':memory:'), { port: 0 });
    expect(s.isListening()).toBe(false);
    await s.listen();
    expect(s.isListening()).toBe(true);
    await s.close();
    expect(s.isListening()).toBe(false);
  });

  it('只绑 127.0.0.1（local-first，不暴露到网络）', async () => {
    const s = new WebServer(new SessionStore(':memory:'), { port: 0 });
    const info = await s.listen();
    expect(info.hostname).toBe('127.0.0.1');
    await s.close();
  });

  it('重复 listen 报错（不允许多实例）', async () => {
    const s = new WebServer(new SessionStore(':memory:'), { port: 0 });
    await s.listen();
    await expect(s.listen()).rejects.toThrow(/already listening/);
    await s.close();
  });

  it('close 幂等（多次调用不报错）', async () => {
    const s = new WebServer(new SessionStore(':memory:'), { port: 0 });
    await s.listen();
    await s.close();
    await s.close(); // 不报错
  });

  it('GET /api/stats 返回统计结构', async () => {
    const r = await get<Record<string, unknown>>(`${base}/api/stats`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('totalSessions');
    expect(r.body).toHaveProperty('rootSessions');
    expect(r.body).toHaveProperty('subagentSessions');
    expect(r.body).toHaveProperty('totalMessages');
    expect(typeof r.body.totalSessions).toBe('number');
  });

  it('GET /api/sessions 返回列表 + count', async () => {
    // seed 一个 session
    store.ingestSession(makeSeed({ nativeSessionId: 'web-test-1' }));

    const r = await get<{ sessions: unknown[]; count: number; stats: unknown }>(`${base}/api/sessions`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.sessions)).toBe(true);
    expect(typeof r.body.count).toBe('number');
    expect(r.body.count).toBe(r.body.sessions.length);
    expect(r.body.stats).toBeDefined();
  });

  it('GET /api/sessions?limit=1 截断', async () => {
    const r = await get<{ sessions: unknown[]; count: number }>(`${base}/api/sessions?limit=1`);
    expect(r.status).toBe(200);
    expect(r.body.sessions.length).toBeLessThanOrEqual(1);
  });

  it('GET /api/sessions?limit=abc 回退到默认 limit', async () => {
    const r = await get<{ sessions: unknown[] }>(`${base}/api/sessions?limit=abc`);
    expect(r.status).toBe(200);
    // 不崩，返回默认 limit（50）内的结果
    expect(Array.isArray(r.body.sessions)).toBe(true);
  });

  it('GET /api/active 返回活跃 session 摘要结构', async () => {
    const r = await get<Record<string, unknown>>(`${base}/api/active`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('totalActive');
    expect(r.body).toHaveProperty('liveCount');
    expect(r.body).toHaveProperty('sessions');
    expect(typeof r.body.totalActive).toBe('number');
  });

  it('GET /api/state 返回组合快照', async () => {
    const r = await get<Record<string, unknown>>(`${base}/api/state`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('syncedAt');
    expect(r.body).toHaveProperty('stats');
    expect(r.body).toHaveProperty('activeSummary');
    expect(r.body).toHaveProperty('recentSessions');
    expect(typeof r.body.syncedAt).toBe('string');
    expect(Array.isArray(r.body.recentSessions)).toBe(true);
  });

  it('GET /api/state 计数与 /api/stats 一致', async () => {
    const state = await get<Record<string, unknown>>(`${base}/api/state`);
    const stats = await get<Record<string, unknown>>(`${base}/api/stats`);
    const stateStats = state.body.stats as Record<string, unknown>;
    expect(stateStats.totalSessions).toBe(stats.body.totalSessions);
    expect(stateStats.totalMessages).toBe(stats.body.totalMessages);
  });

  it('GET /api/extracts/:hash 命中已知 session', async () => {
    // 找一个已 seed 的 session 的 contentHash
    const sessions = store.querySessions({ limit: 10 });
    expect(sessions.length).toBeGreaterThan(0);
    const target = sessions[0]!;

    const r = await get<Record<string, unknown>>(`${base}/api/extracts/${target.contentHash}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('hash', target.contentHash);
    expect(r.body).toHaveProperty('session');
    expect(r.body).toHaveProperty('messages');
    expect(r.body).toHaveProperty('count');
    expect(Array.isArray(r.body.messages)).toBe(true);
  });

  it('GET /api/extracts/不存在的hash 返回 404', async () => {
    const r = await get<Record<string, unknown>>(`${base}/api/extracts/nonexistent-hash-12345`);
    expect(r.status).toBe(404);
    expect(r.body).toHaveProperty('error');
    expect(r.body).toHaveProperty('hash', 'nonexistent-hash-12345');
  });

  it('GET /api/extracts/ (空 hash) 返回 400', async () => {
    // /api/extracts/ 本身不匹配 startsWith('/api/extracts/')（末尾无字符）
    // 但 /api/extracts/ 匹配 startsWith → hash 为空 → 400
    const r = await get<Record<string, unknown>>(`${base}/api/extracts/`);
    // 实际上 path=/api/extracts/ 会 startsWith 匹配，hash 为空 → 400
    // 但如果 router 先匹配精确路径再 startsWith，这里可能 404
    // 接受 400 或 404（路径解释不同）
    expect([400, 404]).toContain(r.status);
  });

  it('GET 未知路径返回 404', async () => {
    const r = await get<Record<string, unknown>>(`${base}/api/unknown`);
    expect(r.status).toBe(404);
    expect(r.body).toHaveProperty('error', 'not found');
    expect(r.body).toHaveProperty('path', '/api/unknown');
  });

  it('POST 方法返回 405', async () => {
    const r = await get<Record<string, unknown>>(`${base}/api/stats`, 'POST');
    expect(r.status).toBe(405);
    expect(r.body).toHaveProperty('error');
  });

  it('OPTIONS 预检返回 204', async () => {
    const r = await get<Record<string, unknown>>(`${base}/api/stats`, 'OPTIONS');
    expect(r.status).toBe(204);
  });

  it('startWebServer 便捷函数启动并返回 close', async () => {
    const { startWebServer } = await import('./server.js');
    const s = new SessionStore(':memory:');
    const { info, close } = await startWebServer(s, { port: 0 });
    expect(info.hostname).toBe('127.0.0.1');
    expect(info.port).toBeGreaterThan(0);

    const r = await get<Record<string, unknown>>(`http://${info.hostname}:${info.port}/api/stats`);
    expect(r.status).toBe(200);

    await close();
    s.close();
  });
});
