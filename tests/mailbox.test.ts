/**
 * MailboxCore 测试
 *
 * 覆盖：
 *   1. postMessage 基本投递 + getMessage
 *   2. peekMessages 不标记已读
 *   3. popMessages 读取 + 标记已读
 *   4. markRead 单条 / 批量 session / 批量 project
 *   5. countUnread 直投 + 广播（排除自己发的）
 *   6. expiresAt 过期消息被 cleanupExpired 删除
 *   7. threading：replyToId 自动派生 threadId
 *   8. resolveSelfSession 三层降级（env / explicit / cwd 匹配）
 *   9. Notifier 回调：postMessage 触发 notifyNewMessage
 *   10. listMailboxes 统计
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import { SessionStore } from '../src/store/index.js';
import { MailboxCore } from '../src/mailbox/core.js';
import type { MailboxMessage, MailboxNotifier } from '../src/mailbox/types.js';
import { TriggerAdapter } from '../src/trigger/adapter.js';
import { ReplyAdapter } from '../src/trigger/reply-adapter.js';
import type { TriggerRequest, TriggerResult } from '../src/trigger/types.js';

const DEVICE = 'mailbox-test';

/**
 * Fake TriggerAdapter：可预设 trigger() 的返回值，用于 send() 单元测试。
 *
 * 用法：
 *   const fake = new FakeTriggerAdapter({ delivered: true, response: 'PONG' });
 *   const mailbox = new MailboxCore(dbPath, dataDir, fake, new ReplyAdapter());
 *   const result = await mailbox.send({ cli: 'hermes', mode: 'new', message: 'PING' });
 */
class FakeTriggerAdapter extends TriggerAdapter {
  private readonly canned: TriggerResult;
  public lastRequest: TriggerRequest | undefined;

  constructor(canned: TriggerResult) {
    super();
    this.canned = canned;
  }

  override async trigger(req: TriggerRequest): Promise<TriggerResult> {
    this.lastRequest = req;
    return this.canned;
  }
}

/** 测试用的 store + mailbox 组合 */
function setupMailbox(opts?: {
  triggerAdapter?: TriggerAdapter;
  replyAdapter?: ReplyAdapter;
}): { store: SessionStore; mailbox: MailboxCore; dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'ymesh-mailbox-test-'));
  const dbPath = join(dataDir, 'test.db');
  const store = new SessionStore(dbPath);
  const mailbox = new MailboxCore(dbPath, dataDir, opts?.triggerAdapter, opts?.replyAdapter);

  // 灌入一个测试 session（用于 resolveSelfSession cwd 匹配 + countUnread project 查询）
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
    cwd: '/projects/test-cwd',
    projectPath: '/projects/test-cwd',
    startedAt: Date.now(),
    topology: 'root',
    messages: [
      { role: 'user', content: 'hello', timestamp: Date.now() },
    ],
  });

  return {
    store,
    mailbox,
    dataDir,
    cleanup: () => {
      mailbox.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 查找 self session id（用 native_session_id 查） */
function findSelfSessionId(store: SessionStore): string {
  const sessions = store.querySessions({});
  const self = sessions.find((s) => s.nativeSessionId === 'sess-self');
  if (!self) throw new Error('self session not found');
  return self.id;
}

describe('MailboxCore', () => {
  let env: ReturnType<typeof setupMailbox>;
  let selfSid: string;

  beforeEach(() => {
    env = setupMailbox();
    selfSid = findSelfSessionId(env.store);
  });

  afterEach(() => {
    env.cleanup();
  });

  describe('1. postMessage + getMessage', () => {
    it('投递直投消息并返回 id', () => {
      const id = env.mailbox.postMessage({
        toSessionId: selfSid,
        fromSessionId: 'sender-1',
        body: 'hello from sender',
        kind: 'info',
      });
      expect(id).toBeGreaterThan(0);

      const msg = env.mailbox.getMessage(id);
      expect(msg).not.toBeNull();
      expect(msg!.body).toBe('hello from sender');
      expect(msg!.toSessionId).toBe(selfSid);
      expect(msg!.fromSessionId).toBe('sender-1');
      expect(msg!.kind).toBe('info');
      expect(msg!.priority).toBe('normal');
      expect(msg!.readAt).toBeNull();
    });

    it('投递广播消息', () => {
      const id = env.mailbox.postMessage({
        toProject: '/projects/test-cwd',
        body: 'broadcast msg',
      });
      const msg = env.mailbox.getMessage(id);
      expect(msg!.toProject).toBe('/projects/test-cwd');
      expect(msg!.toSessionId).toBeNull();
    });

    it('缺少 body 抛错', () => {
      expect(() =>
        env.mailbox.postMessage({
          toSessionId: selfSid,
          body: '',
        }),
      ).toThrow();
    });

    it('缺少 toSessionId 和 toProject 抛错', () => {
      expect(() =>
        env.mailbox.postMessage({
          body: 'no recipient',
        }),
      ).toThrow();
    });

    it('无效 kind 抛错', () => {
      expect(() =>
        env.mailbox.postMessage({
          toSessionId: selfSid,
          body: 'x',
          kind: 'invalid' as never,
        }),
      ).toThrow();
    });

    it('priority 字段持久化', () => {
      const id = env.mailbox.postMessage({
        toSessionId: selfSid,
        body: 'urgent msg',
        priority: 'urgent',
      });
      const msg = env.mailbox.getMessage(id);
      expect(msg!.priority).toBe('urgent');
    });
  });

  describe('2. peekMessages 不标记已读', () => {
    it('peek 不改变 readAt', () => {
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg 1' });
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg 2' });

      const messages = env.mailbox.peekMessages({ forSessionId: selfSid });
      expect(messages).toHaveLength(2);
      expect(messages.every((m) => m.readAt === null)).toBe(true);

      // 再 peek 一次，仍然全部未读
      const messages2 = env.mailbox.peekMessages({ forSessionId: selfSid });
      expect(messages2.every((m) => m.readAt === null)).toBe(true);
    });

    it('unreadOnly 过滤', () => {
      const id1 = env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg 1' });
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg 2' });

      // 标记第一条已读
      env.mailbox.markRead({ id: id1 });

      const unread = env.mailbox.peekMessages({ forSessionId: selfSid, unreadOnly: true });
      expect(unread).toHaveLength(1);
      expect(unread[0].body).toBe('msg 2');
    });

    it('广播消息也被返回', () => {
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'direct' });
      env.mailbox.postMessage({ toProject: '/projects/test-cwd', body: 'broadcast' });

      const messages = env.mailbox.peekMessages({ forSessionId: selfSid });
      expect(messages).toHaveLength(2);
    });

    it('排除自己发给自己项目的广播', () => {
      env.mailbox.postMessage({
        toProject: '/projects/test-cwd',
        fromSessionId: selfSid,
        body: 'my own broadcast',
      });
      env.mailbox.postMessage({
        toProject: '/projects/test-cwd',
        fromSessionId: 'other-sender',
        body: 'other broadcast',
      });

      const messages = env.mailbox.peekMessages({ forSessionId: selfSid });
      // 只应该看到 other broadcast，不包含自己发的
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe('other broadcast');
    });
  });

  describe('3. popMessages 标记已读', () => {
    it('pop 后消息变为已读', () => {
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg 1' });
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg 2' });

      const messages = env.mailbox.popMessages({ forSessionId: selfSid });
      expect(messages).toHaveLength(2);

      // 再 pop 应该返回空（已全部已读）
      const messages2 = env.mailbox.popMessages({ forSessionId: selfSid, unreadOnly: true });
      expect(messages2).toHaveLength(0);
    });
  });

  describe('4. markRead', () => {
    it('单条标记', () => {
      const id = env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg' });
      const count = env.mailbox.markRead({ id });
      expect(count).toBe(1);

      const msg = env.mailbox.getMessage(id);
      expect(msg!.readAt).not.toBeNull();
    });

    it('按 session 批量标记', () => {
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg 1' });
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg 2' });
      env.mailbox.postMessage({ toSessionId: 'other-sid', body: 'other' });

      const count = env.mailbox.markRead({ allForSession: selfSid });
      expect(count).toBe(2);
    });

    it('按 project 批量标记', () => {
      env.mailbox.postMessage({ toProject: '/projects/test-cwd', body: 'b1' });
      env.mailbox.postMessage({ toProject: '/projects/test-cwd', body: 'b2' });

      const count = env.mailbox.markRead({ allForProject: '/projects/test-cwd' });
      expect(count).toBe(2);
    });
  });

  describe('5. countUnread', () => {
    it('直投 + 广播分别计数', () => {
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'direct 1' });
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'direct 2' });
      env.mailbox.postMessage({
        toProject: '/projects/test-cwd',
        fromSessionId: 'other',
        body: 'broadcast 1',
      });

      const unread = env.mailbox.countUnread(selfSid);
      expect(unread.direct).toBe(2);
      expect(unread.broadcast).toBe(1);
      expect(unread.total).toBe(3);
    });

    it('自己发的广播不计入', () => {
      env.mailbox.postMessage({
        toProject: '/projects/test-cwd',
        fromSessionId: selfSid,
        body: 'my broadcast',
      });

      const unread = env.mailbox.countUnread(selfSid);
      expect(unread.broadcast).toBe(0);
      expect(unread.total).toBe(0);
    });

    it('已读消息不计入', () => {
      const id = env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg' });
      env.mailbox.markRead({ id });

      const unread = env.mailbox.countUnread(selfSid);
      expect(unread.total).toBe(0);
    });
  });

  describe('6. expiresAt + cleanupExpired', () => {
    it('过期消息被 cleanupExpired 删除', () => {
      const id = env.mailbox.postMessage({
        toSessionId: selfSid,
        body: 'will expire',
        expiresAt: Date.now() - 1000, // 已过期
      });
      env.mailbox.postMessage({
        toSessionId: selfSid,
        body: 'no expiry',
      });

      // peek 不返回过期消息
      const messages = env.mailbox.peekMessages({ forSessionId: selfSid });
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe('no expiry');

      // cleanupExpired 物理删除
      const deleted = env.mailbox.cleanupExpired();
      expect(deleted).toBe(1);

      // getMessage 仍能取到（不过滤过期）
      const msg = env.mailbox.getMessage(id);
      expect(msg).toBeNull();
    });

    it('未过期消息不受影响', () => {
      env.mailbox.postMessage({
        toSessionId: selfSid,
        body: 'future expiry',
        expiresAt: Date.now() + 3600_000,
      });

      const deleted = env.mailbox.cleanupExpired();
      expect(deleted).toBe(0);

      const messages = env.mailbox.peekMessages({ forSessionId: selfSid });
      expect(messages).toHaveLength(1);
    });
  });

  describe('7. threading (replyToId 派生 threadId)', () => {
    it('回复无 threadId 的消息时自动派生', () => {
      const parentId = env.mailbox.postMessage({
        toSessionId: selfSid,
        fromSessionId: 'sender-1',
        body: 'original msg',
      });

      const replyId = env.mailbox.postMessage({
        toSessionId: 'sender-1',
        fromSessionId: selfSid,
        body: 'reply',
        replyToId: parentId,
      });

      const reply = env.mailbox.getMessage(replyId);
      expect(reply!.threadId).toBe(`thread-${parentId}`);

      const parent = env.mailbox.getMessage(parentId);
      expect(parent!.threadId).toBeNull(); // 原消息没有 threadId
    });

    it('回复有 threadId 的消息时继承', () => {
      const parentId = env.mailbox.postMessage({
        toSessionId: selfSid,
        fromSessionId: 'sender-1',
        body: 'original msg',
        threadId: 'existing-thread',
      });

      const replyId = env.mailbox.postMessage({
        toSessionId: 'sender-1',
        fromSessionId: selfSid,
        body: 'reply',
        replyToId: parentId,
      });

      const reply = env.mailbox.getMessage(replyId);
      expect(reply!.threadId).toBe('existing-thread');
    });

    it('显式 threadId 优先于 replyToId 派生', () => {
      const parentId = env.mailbox.postMessage({
        toSessionId: selfSid,
        body: 'original',
      });

      const replyId = env.mailbox.postMessage({
        toSessionId: selfSid,
        body: 'reply',
        replyToId: parentId,
        threadId: 'my-thread',
      });

      const reply = env.mailbox.getMessage(replyId);
      expect(reply!.threadId).toBe('my-thread');
    });

    it('按 threadId 过滤', () => {
      env.mailbox.postMessage({
        toSessionId: selfSid,
        body: 'msg A',
        threadId: 'thread-x',
      });
      env.mailbox.postMessage({
        toSessionId: selfSid,
        body: 'msg B',
        threadId: 'thread-y',
      });

      const messages = env.mailbox.peekMessages({ forSessionId: selfSid, threadId: 'thread-x' });
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe('msg A');
    });
  });

  describe('8. resolveSelfSession 三层降级', () => {
    afterEach(() => {
      delete process.env.YONDERMESH_SELF_SESSION_ID;
    });

    it('层 1: env YONDERMESH_SELF_SESSION_ID 优先', () => {
      process.env.YONDERMESH_SELF_SESSION_ID = 'env-sid';
      const sid = env.mailbox.resolveSelfSession({ cwd: '/projects/test-cwd' });
      expect(sid).toBe('env-sid');
    });

    it('层 2: explicit 覆盖 cwd 匹配', () => {
      const sid = env.mailbox.resolveSelfSession({ explicit: 'explicit-sid', cwd: '/projects/test-cwd' });
      expect(sid).toBe('explicit-sid');
    });

    it('层 3: cwd 匹配找到 session', () => {
      const sid = env.mailbox.resolveSelfSession({ cwd: '/projects/test-cwd' });
      expect(sid).toBe(selfSid);
    });

    it('无法匹配时返回 null', () => {
      const sid = env.mailbox.resolveSelfSession({ cwd: '/nonexistent/path' });
      expect(sid).toBeNull();
    });
  });

  describe('9. Notifier 回调', () => {
    it('postMessage 触发 notifyNewMessage', () => {
      const calls: MailboxMessage[] = [];
      const notifier: MailboxNotifier = {
        notifyNewMessage(msg) {
          calls.push(msg);
        },
        notifyRead() {
          // no-op
        },
      };
      env.mailbox.registerNotifier(notifier);

      env.mailbox.postMessage({
        toSessionId: selfSid,
        body: 'notified msg',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].body).toBe('notified msg');
    });

    it('默认 NoopNotifier 不抛错', () => {
      expect(() => {
        env.mailbox.postMessage({ toSessionId: selfSid, body: 'no-op' });
      }).not.toThrow();
    });
  });

  describe('10. listMailboxes', () => {
    it('返回有消息的 session 邮箱', () => {
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg 1' });
      env.mailbox.postMessage({ toSessionId: selfSid, body: 'msg 2' });
      env.mailbox.postMessage({ toSessionId: 'other-sid', body: 'other' });

      const mailboxes = env.mailbox.listMailboxes();
      expect(mailboxes).toHaveLength(2);

      const selfMb = mailboxes.find((m) => m.sessionId === selfSid);
      expect(selfMb).toBeDefined();
      expect(selfMb!.messageCount).toBe(2);
      expect(selfMb!.unreadCount).toBe(2);
    });
  });

  // ─── v3 同步注入模型 ────────────────────────────────────────────────────

  describe('11. send() v3 同步注入（mock TriggerAdapter）', () => {
    it('成功投递 + 收到回复：写审计 user + reply 两条消息', async () => {
      const fake = new FakeTriggerAdapter({
        delivered: true,
        response: 'PONG',
        exitCode: 0,
        channel: 'cli-spawn',
        latencyMs: 42,
        newSessionId: 'newsess-123',
      });
      const env = setupMailbox({ triggerAdapter: fake, replyAdapter: new ReplyAdapter() });
      try {
        const result = await env.mailbox.send({
          cli: 'hermes',
          mode: 'new',
          message: 'PING',
          fromSessionId: selfSid,
        });

        // SendResult 字段
        expect(result.delivered).toBe(true);
        expect(result.response).toBe('PONG');
        expect(result.channel).toBe('cli-spawn');
        expect(result.newSessionId).toBe('newsess-123');
        expect(result.exitCode).toBe(0);
        expect(result.error).toBeUndefined();
        expect(result.messageId).toBeGreaterThan(0);
        expect(result.replyMessageId).toBeGreaterThan(result.messageId);

        // 触发请求正确传递
        expect(fake.lastRequest?.cli).toBe('hermes');
        expect(fake.lastRequest?.message).toBe('PING');
        expect(fake.lastRequest?.mode).toBe('new');

        // 审计：user 消息已写入
        const userMsg = env.mailbox.getMessage(result.messageId);
        expect(userMsg).not.toBeNull();
        expect(userMsg!.body).toBe('PING');
        expect(userMsg!.kind).toBe('question');
        expect(userMsg!.fromSessionId).toBe(selfSid);
        // new 模式没有 toSessionId，写入占位 toProject
        expect(userMsg!.toProject).toBe('ymesh-send/hermes');

        // 审计：reply 消息已写入，from=newSessionId，replyToId=userMsg.id
        const replyMsg = env.mailbox.getMessage(result.replyMessageId!);
        expect(replyMsg).not.toBeNull();
        expect(replyMsg!.body).toBe('PONG');
        expect(replyMsg!.kind).toBe('task_update');
        expect(replyMsg!.fromSessionId).toBe('newsess-123');
        expect(replyMsg!.replyToId).toBe(result.messageId);
        expect(replyMsg!.threadId).toBe(`thread-${result.messageId}`);
      } finally {
        env.cleanup();
      }
    });

    it('投递失败：仅写 user 审计，无 reply；error 字段有值', async () => {
      const fake = new FakeTriggerAdapter({
        delivered: false,
        response: '',
        channel: 'cli-spawn',
        latencyMs: 10,
        error: 'hermes 未安装',
      });
      const env = setupMailbox({ triggerAdapter: fake });
      try {
        const result = await env.mailbox.send({
          cli: 'hermes',
          mode: 'new',
          message: 'hello',
        });

        expect(result.delivered).toBe(false);
        expect(result.response).toBe('');
        expect(result.error).toBe('hermes 未安装');
        expect(result.messageId).toBeGreaterThan(0);
        expect(result.replyMessageId).toBeUndefined();
      } finally {
        env.cleanup();
      }
    });

    it('投递成功但回复为空：不写 reply 审计', async () => {
      const fake = new FakeTriggerAdapter({
        delivered: true,
        response: '',
        channel: 'http-api',
        latencyMs: 100,
        newSessionId: 'opencode-sess',
      });
      const env = setupMailbox({ triggerAdapter: fake });
      try {
        const result = await env.mailbox.send({
          cli: 'opencode',
          mode: 'new',
          message: 'do something',
        });

        expect(result.delivered).toBe(true);
        expect(result.response).toBe('');
        expect(result.messageId).toBeGreaterThan(0);
        expect(result.replyMessageId).toBeUndefined();
      } finally {
        env.cleanup();
      }
    });

    it('stopped 模式：要求 sessionId，写入 toSessionId', async () => {
      const fake = new FakeTriggerAdapter({
        delivered: true,
        response: 'resumed ok',
        channel: 'cli-spawn',
        latencyMs: 5,
      });
      const env = setupMailbox({ triggerAdapter: fake });
      try {
        const result = await env.mailbox.send({
          cli: 'hermes',
          mode: 'stopped',
          sessionId: 'stopped-sess-1',
          message: 'continue',
        });

        expect(result.delivered).toBe(true);
        expect(result.response).toBe('resumed ok');

        // user 审计消息 toSessionId = stopped-sess-1
        const userMsg = env.mailbox.getMessage(result.messageId);
        expect(userMsg!.toSessionId).toBe('stopped-sess-1');
        expect(userMsg!.toProject).toBeNull();

        // trigger 收到 stopped 模式 + sessionId
        expect(fake.lastRequest?.mode).toBe('stopped');
        expect(fake.lastRequest?.sessionId).toBe('stopped-sess-1');
      } finally {
        env.cleanup();
      }
    });

    it('TriggerAdapter 抛错：send 不抛，返回 delivered=false + error', async () => {
      class ThrowingAdapter extends TriggerAdapter {
        override async trigger(_req: TriggerRequest): Promise<TriggerResult> {
          throw new Error('spawn EACCES');
        }
      }
      const env = setupMailbox({ triggerAdapter: new ThrowingAdapter() });
      try {
        const result = await env.mailbox.send({
          cli: 'hermes',
          mode: 'new',
          message: 'will throw',
        });

        expect(result.delivered).toBe(false);
        expect(result.error).toContain('spawn EACCES');
        expect(result.messageId).toBeGreaterThan(0);
      } finally {
        env.cleanup();
      }
    });

    describe('参数校验', () => {
      it('缺少 cli 抛错', async () => {
        await expect(
          env.mailbox.send({ cli: '', mode: 'new', message: 'x' }),
        ).rejects.toThrow(/cli/);
      });

      it('缺少 message 抛错', async () => {
        await expect(
          env.mailbox.send({ cli: 'hermes', mode: 'new', message: '' } as never),
        ).rejects.toThrow(/message/);
      });

      it('无效 mode 抛错', async () => {
        await expect(
          env.mailbox.send({ cli: 'hermes', mode: 'invalid' as never, message: 'x' }),
        ).rejects.toThrow(/mode/);
      });

      it('stopped 模式缺少 sessionId 抛错', async () => {
        await expect(
          env.mailbox.send({ cli: 'hermes', mode: 'stopped', message: 'x' }),
        ).rejects.toThrow(/sessionId/);
      });

      it('running 模式缺少 sessionId 抛错', async () => {
        await expect(
          env.mailbox.send({ cli: 'hermes', mode: 'running', message: 'x' }),
        ).rejects.toThrow(/sessionId/);
      });
    });
  });

  // ─── hermes 真实集成（skip if 未安装）─────────────────────────────────

  const hermesInstalled = existsSync(join(homedir(), '.hermes'));
  const hermesIt = hermesInstalled ? it : it.skip;

  describe('12. send() hermes 真实集成', () => {
    hermesIt('hermes new 模式：发送 PING 拿到回复', async () => {
      // 用真实 TriggerAdapter + ReplyAdapter
      const env = setupMailbox();
      try {
        const result = await env.mailbox.send({
          cli: 'hermes',
          mode: 'new',
          message: 'Reply with exactly the word PONG and nothing else.',
          timeoutMs: 60_000,
        });

        expect(result.delivered).toBe(true);
        expect(result.messageId).toBeGreaterThan(0);
        // hermes 应该至少返回一些文本
        expect(result.response.length).toBeGreaterThan(0);
        // 回复被审计写入
        if (result.response.trim().length > 0) {
          expect(result.replyMessageId).toBeGreaterThan(0);
        }
      } finally {
        env.cleanup();
      }
    }, 90_000);
  });
});
