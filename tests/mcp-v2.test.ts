/**
 * LOOP-012 MCP v2 — 实时感知 + 跨 session 通信
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { McpServer } from '../src/mcp/server.js';

describe('LOOP-012 验收门 1-2: list_active_sessions', () => {
  let tmpDir: string;
  let claudeDir: string;
  let codexDir: string;
  let mcp: McpServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-mcp2-'));
    claudeDir = path.join(tmpDir, 'claude-projects');
    codexDir = path.join(tmpDir, 'codex-sessions', '2026', '07', '14');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });

    // 写一个 LIVE codex session（刚写入）
    const codexFile = path.join(codexDir, 'rollout-2026-07-14T17-00-33-019f5fdb-dead-beef.jsonl');
    fs.writeFileSync(codexFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: { session_id: '019f5fdb-dead-beef', cwd: '/projects/test-project', originator: 'Codex Desktop' },
    }) + '\n');
    for (let i = 0; i < 5; i++) {
      fs.appendFileSync(codexFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'response_item',
        payload: { type: 'message', role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `msg ${i}` }] },
      }) + '\n');
    }

    // 写一个 IDLE claude session（5 分钟前修改）
    const claudeFile = path.join(claudeDir, 'abc12345-dead-beef.jsonl');
    fs.writeFileSync(claudeFile, JSON.stringify({
      type: 'user', sessionId: 'abc12345-dead-beef',
      cwd: '/projects/old-project', version: '2.1.205',
      message: { content: 'hello' },
    }) + '\n');
    const oldTime = (Date.now() - 5 * 60 * 1000) / 1000;
    fs.utimesSync(claudeFile, oldTime, oldTime);

    const store = new SessionStore(':memory:');
    mcp = new McpServer(store, {
      claudeProjectsPath: claudeDir,
      codexSessionsPath: codexDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('返回最近 30 分钟内的 session', async () => {
    const result = await mcp.callTool('list_active_sessions', {});
    expect(result.isError).toBeFalsy();
    const sessions = JSON.parse(result.content);
    expect(sessions.length).toBe(2);
  });

  it('正确标记 LIVE 和 IDLE', async () => {
    const result = await mcp.callTool('list_active_sessions', {});
    const sessions = JSON.parse(result.content);
    const live = sessions.filter((s: { isLive: boolean }) => s.isLive);
    const idle = sessions.filter((s: { isLive: boolean }) => !s.isLive);
    expect(live.length).toBe(1);
    expect(idle.length).toBe(1);
    expect(live[0].source).toBe('codex');
    expect(idle[0].source).toBe('claude');
  });

  it('提取 cwd', async () => {
    const result = await mcp.callTool('list_active_sessions', {});
    const sessions = JSON.parse(result.content);
    const codexSession = sessions.find((s: { source: string }) => s.source === 'codex');
    expect(codexSession.cwd).toBe('/projects/test-project');
  });

  it('估算消息数', async () => {
    const result = await mcp.callTool('list_active_sessions', {});
    const sessions = JSON.parse(result.content);
    const codexSession = sessions.find((s: { source: string }) => s.source === 'codex');
    expect(codexSession.messageCount).toBeGreaterThanOrEqual(5);
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
