/**
 * LOOP-011 MCP Server 测试
 *
 * 验收门（对应 spec §7）：
 *   1. listTools 返回 4 个工具，schema 正确
 *   2. search_sessions 无参数返回最近 session
 *   3. search_sessions 支持 project / agent / topology / since 过滤
 *   4. get_session_detail 返回消息列表，session 不存在时返回 isError
 *   5. get_session_relations 返回关系，无关系时返回空数组
 *   6. get_overview 返回统计
 *   7. callTool 未知工具名返回 isError
 *   8. parseRelativeTime 正确解析 d/h/m 和 ISO 8601
 *   9. stdio 通信完成 initialize / tools/list / tools/call 握手
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from '../src/store/index.js';
import { McpServer, parseRelativeTime } from '../src/mcp/server.js';

const DEVICE = 'mac-test';

/** 构造一个带测试数据的 store */
function seededStore(): SessionStore {
  const store = new SessionStore(':memory:');

  const inst = store.registerSourceInstance({
    deviceId: DEVICE,
    source: 'claude-code',
    rootPath: '/fake/.claude',
    coverage: 'A',
  });

  const codexInst = store.registerSourceInstance({
    deviceId: DEVICE,
    source: 'codex',
    rootPath: '/fake/.codex',
    coverage: 'A',
  });

  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const weekAgo = now - 7 * 86_400_000;

  // root session, claude-code, project A, recent
  const root1 = store.ingestSession({
    deviceId: DEVICE,
    sourceInstanceId: inst.id,
    nativeSessionId: 'sess-root-1',
    source: 'claude-code',
    cwd: '/projects/alpha',
    projectPath: '/projects/alpha',
    startedAt: dayAgo,
    topology: 'root',
    messages: [
      { role: 'user', content: 'fix the bug', timestamp: dayAgo },
      { role: 'assistant', content: 'fixed it', timestamp: dayAgo + 1000 },
    ],
  });

  // subagent session, claude-code, project A, recent
  const sub1 = store.ingestSession({
    deviceId: DEVICE,
    sourceInstanceId: inst.id,
    nativeSessionId: 'sess-sub-1',
    source: 'claude-code',
    cwd: '/projects/alpha',
    projectPath: '/projects/alpha',
    startedAt: dayAgo + 2000,
    topology: 'subagent',
    messages: [
      { role: 'user', content: 'sub task', timestamp: dayAgo + 2000 },
    ],
  });

  // root session, codex, project B, old
  store.ingestSession({
    deviceId: DEVICE,
    sourceInstanceId: codexInst.id,
    nativeSessionId: 'codex-root-1',
    source: 'codex',
    cwd: '/projects/beta',
    projectPath: '/projects/beta',
    startedAt: weekAgo,
    topology: 'root',
    messages: [
      { role: 'user', content: 'old work', timestamp: weekAgo },
    ],
  });

  // relationship: sub1 spawned_by root1
  store.addRelationship({
    fromSessionId: sub1.sessionId,
    toSessionId: root1.sessionId,
    relationType: 'spawned_by',
  });

  return store;
}

describe('LOOP-011 验收门 8: parseRelativeTime', () => {
  it('解析天数后缀 d', () => {
    const ts = parseRelativeTime('7d');
    expect(ts).toBeCloseTo(Date.now() - 7 * 86_400_000, -2);
  });

  it('解析小时后缀 h', () => {
    const ts = parseRelativeTime('24h');
    expect(ts).toBeCloseTo(Date.now() - 24 * 3_600_000, -2);
  });

  it('解析分钟后缀 m', () => {
    const ts = parseRelativeTime('30m');
    expect(ts).toBeCloseTo(Date.now() - 30 * 60_000, -2);
  });

  it('解析 ISO 8601', () => {
    const ts = parseRelativeTime('2026-07-01T00:00:00Z');
    expect(ts).toBe(Date.UTC(2026, 6, 1));
  });

  it('无效格式返回 null', () => {
    expect(parseRelativeTime('banana')).toBeNull();
    expect(parseRelativeTime('')).toBeNull();
    expect(parseRelativeTime(undefined)).toBeNull();
  });
});

describe('LOOP-011 验收门 1: listTools', () => {
  let mcp: McpServer;

  beforeEach(() => {
    mcp = new McpServer(new SessionStore(':memory:'));
  });

  it('返回工具列表（legacy + yondermesh_* 命名空间，共 25 个）', () => {
    const tools = mcp.listTools();
   expect(tools).toHaveLength(25);
  });

  it('工具名称正确', () => {
    const tools = mcp.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_sessions');
    expect(names).toContain('get_session_detail');
    expect(names).toContain('get_session_handoff');
    expect(names).toContain('get_session_relations');
    expect(names).toContain('get_overview');
  });

  it('每个工具有 description 和 inputSchema', () => {
    const tools = mcp.listTools();
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
    }
  });
});

describe('LOOP-011 验收门 2-3: search_sessions', () => {
  let mcp: McpServer;

  beforeEach(() => {
    mcp = new McpServer(seededStore());
  });

  it('无参数返回全部 session', async () => {
    const result = await mcp.callTool('search_sessions', {});
    expect(result.isError).toBeFalsy();
    const sessions = JSON.parse(result.content);
    expect(sessions.length).toBe(3);
  });

  it('按 agent 过滤', async () => {
    const result = await mcp.callTool('search_sessions', { agent: 'codex' });
    const sessions = JSON.parse(result.content);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe('codex');
  });

  it('按 topology 过滤', async () => {
    const result = await mcp.callTool('search_sessions', { topology: 'root' });
    const sessions = JSON.parse(result.content);
    expect(sessions.every((s: { topology: string }) => s.topology === 'root')).toBe(true);
    expect(sessions.length).toBe(2);
  });

  it('按 project_path 精确过滤', async () => {
    const result = await mcp.callTool('search_sessions', { project_path: '/projects/alpha' });
    const sessions = JSON.parse(result.content);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s: { projectPath: string }) => s.projectPath === '/projects/alpha')).toBe(true);
  });

  it('按 project_prefix 模糊过滤', async () => {
    const result = await mcp.callTool('search_sessions', { project_prefix: '/projects/beta' });
    const sessions = JSON.parse(result.content);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectPath).toBe('/projects/beta');
  });

  it('按 since 时间过滤', async () => {
    const result = await mcp.callTool('search_sessions', { since: '2d' });
    const sessions = JSON.parse(result.content);
    // 只有 alpha 的两个 session 在 2 天内
    expect(sessions).toHaveLength(2);
  });

  it('limit 参数生效', async () => {
    const result = await mcp.callTool('search_sessions', { limit: 1 });
    const sessions = JSON.parse(result.content);
    expect(sessions).toHaveLength(1);
  });

  it('返回的 session 包含必要字段', async () => {
    const result = await mcp.callTool('search_sessions', { limit: 1 });
    const sessions = JSON.parse(result.content);
    const s = sessions[0];
    expect(s.id).toBeDefined();
    expect(s.source).toBeDefined();
    expect(s.projectPath).toBeDefined();
    expect(s.messageCount).toBeDefined();
    expect(s.startedAt).toBeDefined();
    expect(s.topology).toBeDefined();
  });
});

describe('LOOP-011 验收门 4: get_session_detail', () => {
  let mcp: McpServer;
  let sessionId: string;

  beforeEach(() => {
    const store = seededStore();
    mcp = new McpServer(store);
    // 拿第一个 session id
    const sessions = store.querySessions({ limit: 1 });
    sessionId = sessions[0].id;
  });

  it('返回消息列表', async () => {
    const result = await mcp.callTool('get_session_detail', { session_id: sessionId });
    expect(result.isError).toBeFalsy();
    const messages = JSON.parse(result.content);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].role).toBeDefined();
    expect(messages[0].content).toBeDefined();
  });

  it('session 不存在返回 isError', async () => {
    const result = await mcp.callTool('get_session_detail', { session_id: 'nonexistent-id' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('不存在');
  });

  it('缺少 session_id 参数返回 isError', async () => {
    const result = await mcp.callTool('get_session_detail', {});
    expect(result.isError).toBe(true);
  });
});

describe('LOOP-011 验收门 5: get_session_relations', () => {
  let mcp: McpServer;
  let rootSessionId: string;
  let subSessionId: string;

  beforeEach(() => {
    const store = seededStore();
    mcp = new McpServer(store);
    const sessions = store.querySessions({ topology: 'root', source: 'claude-code' });
    rootSessionId = sessions[0].id;
    const subs = store.querySessions({ topology: 'subagent' });
    subSessionId = subs[0].id;
  });

  it('返回关系的 session 能查到关系', async () => {
    const result = await mcp.callTool('get_session_relations', { session_id: subSessionId });
    expect(result.isError).toBeFalsy();
    const rels = JSON.parse(result.content);
    expect(rels.length).toBeGreaterThanOrEqual(1);
    const r = rels[0];
    expect(r.type).toBeDefined();
    expect(r.direction).toBeDefined();
    expect(r.sessionId).toBeDefined();
  });

  it('无关系的 session 返回空数组', async () => {
    // codex root 没有关系
    const codexSessions = mcp['store'].querySessions({ source: 'codex' });
    const result = await mcp.callTool('get_session_relations', { session_id: codexSessions[0].id });
    const rels = JSON.parse(result.content);
    expect(rels).toHaveLength(0);
  });

  it('缺少 session_id 参数返回 isError', async () => {
    const result = await mcp.callTool('get_session_relations', {});
    expect(result.isError).toBe(true);
  });
});

describe('LOOP-011 验收门 6: get_overview', () => {
  let mcp: McpServer;

  beforeEach(() => {
    mcp = new McpServer(seededStore());
  });

  it('返回完整统计', async () => {
    const result = await mcp.callTool('get_overview', {});
    expect(result.isError).toBeFalsy();
    const stats = JSON.parse(result.content);
    expect(stats.totalSessions).toBe(3);
    expect(stats.rootSessions).toBe(2);
    expect(stats.subagentSessions).toBe(1);
    expect(stats.totalMessages).toBeGreaterThanOrEqual(3);
  });

  it('支持 since 时间过滤', async () => {
    const result = await mcp.callTool('get_overview', { since: '2d' });
    const stats = JSON.parse(result.content);
    expect(stats.totalSessions).toBe(2);
  });

  it('支持 project_prefix 过滤', async () => {
    const result = await mcp.callTool('get_overview', { project_prefix: '/projects/beta' });
    const stats = JSON.parse(result.content);
    expect(stats.totalSessions).toBe(1);
  });
});

describe('LOOP-011 验收门 7: callTool 未知工具', () => {
  let mcp: McpServer;

  beforeEach(() => {
    mcp = new McpServer(new SessionStore(':memory:'));
  });

  it('未知工具名返回 isError', async () => {
    const result = await mcp.callTool('banana_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('banana_tool');
  });
});

describe('LOOP-011 验收门 9: stdio 协议', () => {
  it('handleMessage 处理 initialize 请求', async () => {
    const mcp = new McpServer(new SessionStore(':memory:'));
    const resp = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    expect(resp).toBeDefined();
    expect(resp.result).toBeDefined();
    expect(resp.result.serverInfo.name).toBe('yondermesh');
    expect(resp.result.capabilities.tools).toBeDefined();
  });

  it('handleMessage 处理 tools/list 请求', async () => {
    const mcp = new McpServer(new SessionStore(':memory:'));
    const resp = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
   expect(resp.result.tools).toHaveLength(25);
  });

  it('handleMessage 处理 tools/call 请求', async () => {
    const mcp = new McpServer(seededStore());
    const resp = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_overview', arguments: {} },
    });
    expect(resp.result.content).toBeDefined();
    const stats = JSON.parse(resp.result.content[0].text);
    expect(stats.totalSessions).toBe(3);
  });

  it('handleMessage 处理未知 method 返回错误', async () => {
    const mcp = new McpServer(new SessionStore(':memory:'));
    const resp = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/list',
    });
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32601);
  });
});
