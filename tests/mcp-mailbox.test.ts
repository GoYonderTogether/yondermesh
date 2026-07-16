/**
 * MCP mailbox 工具 handler 测试
 *
 * 覆盖 4 个新 yondermesh_* 工具：
 *   1. yondermesh_mailbox_check — peek/pop + tray 消费 + unread hint
 *   2. yondermesh_mailbox_post — 投递直投/广播
 *   3. yondermesh_mailbox_reply — 回复 + threadId 派生
 *   4. yondermesh_whoami — 三层降级解析 self
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import { SessionStore } from '../src/store/index.js';
import { MCP_TOOLS, findTool } from '../src/mcp/tools.js';
import type { McpToolResponse } from '../src/mcp/tools.js';
import { defaultDaemonConfig } from '../src/daemon/index.js';

const DEVICE = 'mcp-mailbox-test';

/** 解析 MCP 工具返回的 JSON 内容 */
function parseContent(resp: McpToolResponse): Record<string, unknown> {
  const text = resp.content[0]?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/** 设置测试环境：临时 YONDERMESH_HOME + seeded store */
function setupEnv(): {
  dataDir: string;
  store: SessionStore;
  selfSid: string;
  cleanup: () => void;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'ymesh-mcp-test-'));
  process.env.YONDERMESH_HOME = dataDir;

  // defaultDaemonConfig 会读 YONDERMESH_HOME
  const config = defaultDaemonConfig();
  const store = new SessionStore(config.dbPath);

  const inst = store.registerSourceInstance({
    deviceId: DEVICE,
    source: 'claude-code',
    rootPath: '/fake/.claude',
    coverage: 'A',
  });

  store.ingestSession({
    deviceId: DEVICE,
    sourceInstanceId: inst.id,
    nativeSessionId: 'sess-self',
    source: 'claude-code',
    cwd: '/projects/mcp-test',
    projectPath: '/projects/mcp-test',
    startedAt: Date.now(),
    topology: 'root',
    messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
  });

  // 找 self session id
  const sessions = store.querySessions({});
  const selfSid = sessions.find((s) => s.nativeSessionId === 'sess-self')!.id;

  return {
    dataDir,
    store,
    selfSid,
    cleanup: () => {
      store.close();
      delete process.env.YONDERMESH_HOME;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe('MCP mailbox 工具', () => {
  let env: ReturnType<typeof setupEnv>;
  let selfSid: string;

  beforeEach(() => {
    env = setupEnv();
    selfSid = env.selfSid;
  });

  afterEach(() => {
    env.cleanup();
  });

  describe('yondermesh_mailbox_post', () => {
    it('投递直投消息', async () => {
      const tool = findTool('yondermesh_mailbox_post')!;
      const resp = await tool.handler({
        to_session_id: selfSid,
        from_session_id: 'sender-1',
        body: 'hello from MCP',
      });
      expect(resp.isError).toBeFalsy();
      const data = parseContent(resp);
      expect(data.posted).toBe(true);
      expect(data.messageId).toBeGreaterThan(0);
    });

    it('投递广播消息', async () => {
      const tool = findTool('yondermesh_mailbox_post')!;
      const resp = await tool.handler({
        to_project: '/projects/mcp-test',
        body: 'broadcast from MCP',
      });
      expect(resp.isError).toBeFalsy();
      const data = parseContent(resp);
      expect(data.posted).toBe(true);
    });

    it('缺少 body 返回 isError', async () => {
      const tool = findTool('yondermesh_mailbox_post')!;
      const resp = await tool.handler({
        to_session_id: selfSid,
      });
      expect(resp.isError).toBe(true);
    });

    it('缺少 to_session_id 和 to_project 返回 isError', async () => {
      const tool = findTool('yondermesh_mailbox_post')!;
      const resp = await tool.handler({
        body: 'no recipient',
      });
      expect(resp.isError).toBe(true);
    });

    it('priority + expires_in_seconds 持久化', async () => {
      const tool = findTool('yondermesh_mailbox_post')!;
      const resp = await tool.handler({
        to_session_id: selfSid,
        body: 'urgent + expiry',
        priority: 'urgent',
        expires_in_seconds: 3600,
      });
      const data = parseContent(resp);
      const id = data.messageId as number;

      // 验证字段（通过 mailbox_check 查）
      const checkTool = findTool('yondermesh_mailbox_check')!;
      const checkResp = await checkTool.handler({
        self_session_id: selfSid,
        mark_read: false,
      });
      const checkData = parseContent(checkResp);
      const messages = checkData.messages as Array<Record<string, unknown>>;
      const msg = messages.find((m) => m.id === id);
      expect(msg).toBeDefined();
      expect(msg!.priority).toBe('urgent');
      expect(msg!.expiresAt).not.toBeNull();
    });
  });

  describe('yondermesh_mailbox_check', () => {
    it('mark_read=true 默认 pop 语义', async () => {
      // 先投递
      const postTool = findTool('yondermesh_mailbox_post')!;
      await postTool.handler({
        to_session_id: selfSid,
        from_session_id: 'other',
        body: 'check test msg',
      });

      // check (pop)
      const tool = findTool('yondermesh_mailbox_check')!;
      const resp = await tool.handler({ self_session_id: selfSid });
      const data = parseContent(resp);

      expect(data.sessionId).toBe(selfSid);
      expect(data.markRead).toBe(true);
      const messages = data.messages as unknown[];
      expect(messages).toHaveLength(1);

      // 再 check 应该没有未读
      const resp2 = await tool.handler({ self_session_id: selfSid });
      const data2 = parseContent(resp2);
      const messages2 = data2.messages as unknown[];
      expect(messages2).toHaveLength(0);
    });

    it('mark_read=false peek 不标记已读', async () => {
      const postTool = findTool('yondermesh_mailbox_post')!;
      await postTool.handler({
        to_session_id: selfSid,
        from_session_id: 'other',
        body: 'peek test',
      });

      const tool = findTool('yondermesh_mailbox_check')!;
      const resp = await tool.handler({
        self_session_id: selfSid,
        mark_read: false,
      });
      const data = parseContent(resp);
      expect(data.markRead).toBe(false);
      const messages = data.messages as unknown[];
      expect(messages).toHaveLength(1);

      // 再 check 仍然有未读
      const resp2 = await tool.handler({
        self_session_id: selfSid,
        mark_read: false,
      });
      const data2 = parseContent(resp2);
      const messages2 = data2.messages as unknown[];
      expect(messages2).toHaveLength(1);
    });

    it('无法解析 self session 时返回 isError', async () => {
      // 清掉 YONDERMESH_SELF_SESSION_ID（可能被其他测试设置）
      const oldEnv = process.env.YONDERMESH_SELF_SESSION_ID;
      delete process.env.YONDERMESH_SELF_SESSION_ID;

      const tool = findTool('yondermesh_mailbox_check')!;
      const resp = await tool.handler({}); // 不传 self_session_id，cwd 也不匹配
      expect(resp.isError).toBe(true);

      // 恢复：undefined 时必须 delete，赋值 undefined 会变成字符串 "undefined"
      if (oldEnv === undefined) {
        delete process.env.YONDERMESH_SELF_SESSION_ID;
      } else {
        process.env.YONDERMESH_SELF_SESSION_ID = oldEnv;
      }
    });

    it('unread hint 在有未读时显示', async () => {
      const postTool = findTool('yondermesh_mailbox_post')!;
      await postTool.handler({
        to_session_id: selfSid,
        from_session_id: 'other',
        body: 'hint test',
      });

      const tool = findTool('yondermesh_mailbox_check')!;
      const resp = await tool.handler({
        self_session_id: selfSid,
        mark_read: false,
      });
      const data = parseContent(resp);
      const unread = data.unread as Record<string, number>;
      expect(unread.total).toBe(1);
      expect(data.hint).toContain('📬');
    });
  });

  describe('yondermesh_mailbox_reply', () => {
    it('回复消息并自动派生 threadId', async () => {
      // 先发一条原消息
      const postTool = findTool('yondermesh_mailbox_post')!;
      const postResp = await postTool.handler({
        to_session_id: selfSid,
        from_session_id: 'sender-1',
        body: 'original message',
      });
      const parentId = parseContent(postResp).messageId as number;

      // 回复
      const tool = findTool('yondermesh_mailbox_reply')!;
      const resp = await tool.handler({
        reply_to_id: parentId,
        body: 'this is a reply',
        from_session_id: selfSid,
      });
      expect(resp.isError).toBeFalsy();
      const data = parseContent(resp);
      expect(data.posted).toBe(true);
      expect(data.threadId).toBe(`thread-${parentId}`);
    });

    it('回复不存在的消息返回 isError', async () => {
      const tool = findTool('yondermesh_mailbox_reply')!;
      const resp = await tool.handler({
        reply_to_id: 99999,
        body: 'reply to ghost',
      });
      expect(resp.isError).toBe(true);
    });

    it('缺少 reply_to_id 返回 isError', async () => {
      const tool = findTool('yondermesh_mailbox_reply')!;
      const resp = await tool.handler({
        body: 'no reply target',
      });
      expect(resp.isError).toBe(true);
    });
  });

  describe('yondermesh_whoami', () => {
    afterEach(() => {
      delete process.env.YONDERMESH_SELF_SESSION_ID;
    });

    it('通过 self_session_id arg 解析', async () => {
      const tool = findTool('yondermesh_whoami')!;
      const resp = await tool.handler({ self_session_id: selfSid });
      const data = parseContent(resp);
      expect(data.sessionId).toBe(selfSid);
      expect(data.resolved).toBe(true);
    });

    it('通过 env YONDERMESH_SELF_SESSION_ID 解析', async () => {
      process.env.YONDERMESH_SELF_SESSION_ID = selfSid;
      const tool = findTool('yondermesh_whoami')!;
      const resp = await tool.handler({});
      const data = parseContent(resp);
      expect(data.sessionId).toBe(selfSid);
    });

    it('无法解析时返回 resolved=false', async () => {
      delete process.env.YONDERMESH_SELF_SESSION_ID;
      const tool = findTool('yondermesh_whoami')!;
      const resp = await tool.handler({});
      const data = parseContent(resp);
      expect(data.resolved).toBe(false);
      expect(data.sessionId).toBeNull();
    });

    it('有未读时显示 hint', async () => {
      const postTool = findTool('yondermesh_mailbox_post')!;
      await postTool.handler({
        to_session_id: selfSid,
        from_session_id: 'other',
        body: 'whoami unread test',
      });

      const tool = findTool('yondermesh_whoami')!;
      const resp = await tool.handler({ self_session_id: selfSid });
      const data = parseContent(resp);
      expect(data.hint).toContain('📬');
    });
  });

  describe('MCP_TOOLS 注册表', () => {
    it('包含 4 个 mailbox 工具', () => {
      const names = MCP_TOOLS.map((t) => t.name);
      expect(names).toContain('yondermesh_mailbox_check');
      expect(names).toContain('yondermesh_mailbox_post');
      expect(names).toContain('yondermesh_mailbox_reply');
      expect(names).toContain('yondermesh_whoami');
    });

    it('包含 yondermesh_send v3 工具', () => {
      const names = MCP_TOOLS.map((t) => t.name);
      expect(names).toContain('yondermesh_send');
      const sendTool = findTool('yondermesh_send');
      expect(sendTool).toBeDefined();
      expect(sendTool!.inputSchema).toBeDefined();
      const schema = sendTool!.inputSchema as Record<string, unknown>;
      const props = schema.properties as Record<string, { type?: string }>;
      expect(props.cli).toBeDefined();
      expect(props.message).toBeDefined();
      expect(props.mode).toBeDefined();
      expect(props.session_id).toBeDefined();
      expect(props.model).toBeDefined();
      expect(props.timeout_ms).toBeDefined();
      const required = schema.required as string[];
      expect(required).toContain('cli');
      expect(required).toContain('message');
    });

    it('每个工具有 name/description/inputSchema/handler', () => {
      for (const tool of MCP_TOOLS) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.handler).toBeTypeOf('function');
      }
    });

    it('legacy v2 mailbox 工具 description 标注 "(legacy v2"', () => {
      const legacy = findTool('yondermesh_mailbox_post')!;
      expect(legacy.description).toContain('(legacy v2');
      const legacyCheck = findTool('yondermesh_mailbox_check')!;
      expect(legacyCheck.description).toContain('(legacy v2');
      const legacyReply = findTool('yondermesh_mailbox_reply')!;
      expect(legacyReply.description).toContain('(legacy v2');
    });
  });

  // ─── v3 同步注入：yondermesh_send ──────────────────────────────────────

  describe('yondermesh_send', () => {
    it('缺少 cli 返回 isError', async () => {
      const tool = findTool('yondermesh_send')!;
      const resp = await tool.handler({ message: 'hello' });
      expect(resp.isError).toBe(true);
    });

    it('缺少 message 返回 isError', async () => {
      const tool = findTool('yondermesh_send')!;
      const resp = await tool.handler({ cli: 'hermes' });
      expect(resp.isError).toBe(true);
    });

    it('无效 mode 返回 isError', async () => {
      const tool = findTool('yondermesh_send')!;
      const resp = await tool.handler({ cli: 'hermes', message: 'x', mode: 'bogus' });
      expect(resp.isError).toBe(true);
      const text = resp.content[0]?.text ?? '';
      expect(text).toMatch(/mode/i);
    });

    it('stopped 模式缺少 session_id 返回 isError', async () => {
      const tool = findTool('yondermesh_send')!;
      const resp = await tool.handler({ cli: 'hermes', message: 'x', mode: 'stopped' });
      expect(resp.isError).toBe(true);
      const text = resp.content[0]?.text ?? '';
      expect(text).toMatch(/session_id/i);
    });

    it('running 模式缺少 session_id 返回 isError', async () => {
      const tool = findTool('yondermesh_send')!;
      const resp = await tool.handler({ cli: 'hermes', message: 'x', mode: 'running' });
      expect(resp.isError).toBe(true);
    });

    it('无法识别的 CLI：返回 delivered=false + error（不抛错）', async () => {
      const tool = findTool('yondermesh_send')!;
      // 用一个不存在的 CLI id，TriggerAdapter 会返回 delivered=false
      const resp = await tool.handler({
        cli: 'no-such-cli',
        message: 'hello',
        mode: 'new',
        timeout_ms: 3000,
      });
      expect(resp.isError).toBeFalsy();
      const data = parseContent(resp);
      expect(data.cli).toBe('no-such-cli');
      expect(data.delivered).toBe(false);
      expect(data.error).toBeTruthy();
      expect(data.messageId).toBeGreaterThan(0);
      expect(data.mode).toBe('new');
    });

    // hermes 真实集成（skip if 未安装）
    const hermesInstalled = existsSync(join(homedir(), '.hermes'));
    (hermesInstalled ? it : it.skip)('hermes new 模式：发送消息拿到回复', async () => {
      const tool = findTool('yondermesh_send')!;
      const resp = await tool.handler({
        cli: 'hermes',
        message: 'Reply with exactly the word PONG and nothing else.',
        mode: 'new',
        timeout_ms: 60_000,
      });
      expect(resp.isError).toBeFalsy();
      const data = parseContent(resp);
      expect(data.cli).toBe('hermes');
      expect(data.delivered).toBe(true);
      expect(data.messageId).toBeGreaterThan(0);
      expect(typeof data.response).toBe('string');
      expect((data.response as string).length).toBeGreaterThan(0);
    }, 90_000);
  });
});
