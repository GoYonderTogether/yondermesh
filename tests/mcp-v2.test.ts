/**
 * LOOP-012 MCP v2 — 实时感知 + 跨 session 通信
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { McpServer } from '../src/mcp/server.js';

/** 通过反射访问 store 内部 db，调整 session 的 updated_at 用于测试
 *  注意：getActiveSessionsSummary 用 updated_at（内容变化时才更新）判断活跃，而非 last_seen_at（每次扫描都刷新）
 */
function setLastSeenAt(store: SessionStore, sessionId: string, ts: number): void {
  const db = (store as unknown as {
    db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
  }).db;
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(ts, sessionId);
}

describe('LOOP-012 验收门 1-2: list_active_sessions', () => {
  let store: SessionStore;
  let mcp: McpServer;

  beforeEach(() => {
    store = new SessionStore(':memory:');

    const codexInst = store.registerSourceInstance({
      deviceId: 'test',
      source: 'codex',
      rootPath: '/codex',
      coverage: 'A',
    });
    const claudeInst = store.registerSourceInstance({
      deviceId: 'test',
      source: 'claude',
      rootPath: '/claude',
      coverage: 'A',
    });

    // LIVE codex session（刚 ingest，lastSeenAt = now）
    store.ingestSession({
      deviceId: 'test',
      sourceInstanceId: codexInst.id,
      nativeSessionId: '019f5fdb-dead-beef',
      source: 'codex',
      cwd: '/projects/test-project',
      projectPath: '/projects/test-project',
      topology: 'root',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'work' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'thanks' },
      ],
    });

    // IDLE claude session（lastSeenAt 调整到 5 分钟前）
    const claudeRes = store.ingestSession({
      deviceId: 'test',
      sourceInstanceId: claudeInst.id,
      nativeSessionId: 'abc12345-dead-beef',
      source: 'claude',
      cwd: '/projects/old-project',
      projectPath: '/projects/old-project',
      topology: 'root',
      messages: [{ role: 'user', content: 'old hello' }],
    });
    setLastSeenAt(store, claudeRes.sessionId, Date.now() - 5 * 60 * 1000);

    // 超时 codex session（lastSeenAt 在 60 分钟前，应被排除）
    const staleRes = store.ingestSession({
      deviceId: 'test',
      sourceInstanceId: codexInst.id,
      nativeSessionId: 'stale-session',
      source: 'codex',
      cwd: '/projects/stale',
      topology: 'root',
      messages: [{ role: 'user', content: 'old' }],
    });
    setLastSeenAt(store, staleRes.sessionId, Date.now() - 60 * 60 * 1000);

    mcp = new McpServer(store);
  });

  it('返回最近 30 分钟内的 session', async () => {
    const result = await mcp.callTool('list_active_sessions', {});
    expect(result.isError).toBeFalsy();
    const summary = JSON.parse(result.content);
    expect(summary.totalActive).toBe(2);
    expect(summary.sessions).toHaveLength(2);
  });

  it('正确标记 LIVE 和 IDLE', async () => {
    const result = await mcp.callTool('list_active_sessions', {});
    const summary = JSON.parse(result.content);
    const live = summary.sessions.filter((s: { isLive: boolean }) => s.isLive);
    const idle = summary.sessions.filter((s: { isLive: boolean }) => !s.isLive);
    expect(live.length).toBe(1);
    expect(idle.length).toBe(1);
    expect(live[0].source).toBe('codex');
    expect(idle[0].source).toBe('claude');
  });

  it('提取 cwd', async () => {
    const result = await mcp.callTool('list_active_sessions', {});
    const summary = JSON.parse(result.content);
    const codexSession = summary.sessions.find((s: { source: string }) => s.source === 'codex');
    expect(codexSession.cwd).toBe('/projects/test-project');
  });

  it('包含摘要字段（liveCount/subagentActive/bySource）', async () => {
    const result = await mcp.callTool('list_active_sessions', {});
    const summary = JSON.parse(result.content);
    expect(summary.liveCount).toBe(1);
    expect(summary.subagentActive).toBe(0);
    expect(summary.rootActive).toBe(2);
    expect(summary.bySource.codex).toBe(1);
    expect(summary.bySource.claude).toBe(1);
  });

  it('within_minutes 缩短窗口会过滤掉 idle session', async () => {
    const result = await mcp.callTool('list_active_sessions', { within_minutes: 1 });
    const summary = JSON.parse(result.content);
    // 5 分钟前的 claude session 应被排除
    expect(summary.totalActive).toBe(1);
    expect(summary.sessions[0].source).toBe('codex');
  });
});

describe('LOOP-012 验收门 2b: who_is_working', () => {
  let store: SessionStore;
  let mcp: McpServer;

  beforeEach(() => {
    store = new SessionStore(':memory:');

    const claudeInst = store.registerSourceInstance({
      deviceId: 'test',
      source: 'claude',
      rootPath: '/claude',
      coverage: 'A',
    });
    const codexInst = store.registerSourceInstance({
      deviceId: 'test',
      source: 'codex',
      rootPath: '/codex',
      coverage: 'A',
    });

    // LIVE root codex session
    store.ingestSession({
      deviceId: 'test',
      sourceInstanceId: codexInst.id,
      nativeSessionId: 'live-root',
      source: 'codex',
      cwd: '/projects/yonder',
      topology: 'root',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // IDLE subagent claude session（5 分钟前 lastSeenAt）
    const subRes = store.ingestSession({
      deviceId: 'test',
      sourceInstanceId: claudeInst.id,
      nativeSessionId: 'live-sub',
      source: 'claude',
      cwd: '/projects/yonder',
      topology: 'subagent',
      messages: [{ role: 'assistant', content: 'working' }],
    });
    setLastSeenAt(store, subRes.sessionId, Date.now() - 5 * 60 * 1000);

    mcp = new McpServer(store);
  });

  it('输出人类可读文本（不是 JSON）', async () => {
    const result = await mcp.callTool('who_is_working', {});
    expect(result.isError).toBeFalsy();
    // 不应以 { 或 [ 开头（应是文本）
    expect(result.content.trimStart()[0]).not.toBe('{');
    expect(result.content.trimStart()[0]).not.toBe('[');
  });

  it('包含汇总行（总数 / live / subagent）', async () => {
    const result = await mcp.callTool('who_is_working', {});
    expect(result.content).toContain('2 个 session 活跃中');
    expect(result.content).toContain('1 个 live');
    expect(result.content).toContain('1 个 subagent');
  });

  it('subagent 行带 sub: 前缀', async () => {
    const result = await mcp.callTool('who_is_working', {});
    expect(result.content).toContain('sub:');
  });

  it('包含 source 分布统计', async () => {
    const result = await mcp.callTool('who_is_working', {});
    expect(result.content).toContain('按 source 分布');
    expect(result.content).toContain('codex=1');
    expect(result.content).toContain('claude=1');
  });

  it('无活跃 session 时输出提示', async () => {
    const emptyStore = new SessionStore(':memory:');
    const emptyMcp = new McpServer(emptyStore);
    const result = await emptyMcp.callTool('who_is_working', {});
    expect(result.content).toContain('0 个 session 活跃中');
    expect(result.content).toContain('无活跃 session');
  });
});

describe('LOOP-012 验收门 3-6: 消息总线', () => {
  let store: SessionStore;
  let mcp: McpServer;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    mcp = new McpServer(store);
  });

  it('post_message 写入成功', async () => {
    const result = await mcp.callTool('post_message', {
      to_session_id: 'target-session-001',
      from_session_id: 'my-session-001',
      body: 'cass 去重做完了吗？',
      kind: 'question',
    });
    expect(result.isError).toBeFalsy();
    const resp = JSON.parse(result.content);
    expect(resp.posted).toBe(true);
    expect(resp.messageId).toBeDefined();
  });

  it('get_messages 按 session_id 过滤', async () => {
    await mcp.callTool('post_message', {
      to_session_id: 'target-001',
      from_session_id: 'sender-001',
      body: 'hello',
    });
    await mcp.callTool('post_message', {
      to_session_id: 'target-002',
      from_session_id: 'sender-001',
      body: 'wrong target',
    });

    const result = await mcp.callTool('get_messages', {
      for_session_id: 'target-001',
    });
    const messages = JSON.parse(result.content);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('hello');
  });

  it('get_messages 按 project 广播过滤', async () => {
    await mcp.callTool('post_message', {
      to_project: '/projects/yondermesh',
      from_session_id: 'sender-001',
      body: 'broadcast to yondermesh team',
    });

    const result = await mcp.callTool('get_messages', {
      for_project: '/projects/yondermesh',
    });
    const messages = JSON.parse(result.content);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain('broadcast');
  });

  it('get_messages 支持 unread_only', async () => {
    await mcp.callTool('post_message', {
      to_session_id: 'target-001',
      from_session_id: 'sender-001',
      body: 'first',
    });

    // 读一次（标记为已读）
    await mcp.callTool('get_messages', { for_session_id: 'target-001' });

    // 再发一条
    await mcp.callTool('post_message', {
      to_session_id: 'target-001',
      from_session_id: 'sender-001',
      body: 'second',
    });

    // unread_only 应只返回 second
    const result = await mcp.callTool('get_messages', {
      for_session_id: 'target-001',
      unread_only: true,
    });
    const messages = JSON.parse(result.content);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('second');
  });
});

describe('LOOP-012 验收门 7-8: get_session_detail live 模式', () => {
  let tmpDir: string;
  let claudeDir: string;
  let mcp: McpServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-live-'));
    claudeDir = path.join(tmpDir, 'claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // 写一个 claude session 文件
    const sessionFile = path.join(claudeDir, 'live-test-001.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({
        type: i % 2 === 0 ? 'user' : 'assistant',
        sessionId: 'live-test-001',
        cwd: '/projects/test',
        message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` },
      }));
    }
    fs.writeFileSync(sessionFile, lines.join('\n') + '\n');

    const store = new SessionStore(':memory:');
    mcp = new McpServer(store, { claudeProjectsPath: claudeDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('live=true 直接读源文件', async () => {
    const result = await mcp.callTool('get_session_detail', {
      session_id: 'live-test-001',
      live: true,
    });
    expect(result.isError).toBeFalsy();
    const messages = JSON.parse(result.content);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].content).toContain('message');
  });

  it('limit 参数截断到最后 N 条', async () => {
    const result = await mcp.callTool('get_session_detail', {
      session_id: 'live-test-001',
      live: true,
      limit: 3,
    });
    const messages = JSON.parse(result.content);
    expect(messages.length).toBe(3);
    // 应该是最后 3 条
    expect(messages[2].content).toContain('message 9');
  });

  it('文件不存在返回 isError', async () => {
    const result = await mcp.callTool('get_session_detail', {
      session_id: 'nonexistent-id',
      live: true,
    });
    expect(result.isError).toBe(true);
  });
});
