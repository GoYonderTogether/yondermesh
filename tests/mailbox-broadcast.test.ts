/**
 * mailbox-broadcast.test.ts — 广播「按收件人已读」语义
 *
 * 背景（实战数据）：mailbox 两个月 632 条消息里 576 条（91%）是 to_project 广播。
 * 旧实现用 agent_messages.read_at 单列记已读，于是同一个项目里**第一个 check 的
 * agent 会把广播从其他 agent 手里一并标成已读**——文档承诺的是"广播给该项目所有 agent"。
 *
 * 验收门：
 *   B1. 同项目两个 agent 都能收到同一条广播（先读的人不吞掉）
 *   B2. 一个 agent 读完后，另一个 agent 的未读数仍为 1
 *   B3. 两个 agent 都读完后，未读归零
 *   B4. 直投消息仍然是「读了就没了」（read_at 语义不变）
 *   B5. 广播未读不随 check 次数误判（重复 check 不再返回同一条）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionStore } from '../src/store/index.js';
import { MailboxCore } from '../src/mailbox/core.js';

const DEVICE = 'broadcast-test';
const PROJECT = '/projects/shared-repo';

function setup(): {
  store: SessionStore;
  mailbox: MailboxCore;
  a: string;
  b: string;
  cleanup: () => void;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'ymesh-broadcast-'));
  const dbPath = join(dataDir, 'test.db');
  const store = new SessionStore(dbPath);
  const mailbox = new MailboxCore(dbPath, dataDir);

  const inst = store.registerSourceInstance({
    deviceId: DEVICE,
    source: 'claude-code',
    rootPath: '/fake/.claude',
    coverage: 'A',
  });

  const mk = (nativeSessionId: string) =>
    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId,
      source: 'claude-code',
      cwd: PROJECT,
      projectPath: PROJECT,
      startedAt: Date.now(),
      messages: [{ role: 'user', content: 'hi' }],
    }).sessionId;

  return {
    store,
    mailbox,
    a: mk('agent-a'),
    b: mk('agent-b'),
    cleanup: () => {
      mailbox.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe('MailboxCore 广播语义（按收件人已读）', () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup();
  });
  afterEach(() => env.cleanup());

  it('B1/B2/B3: 广播不被第一个读者吃掉，两个 agent 都能看到', () => {
    env.mailbox.postMessage({ toProject: PROJECT, body: '全项目注意：今晚发版', kind: 'info' });

    // 两个 agent 都认为有 1 条未读
    expect(env.mailbox.countUnread(env.a).broadcast).toBe(1);
    expect(env.mailbox.countUnread(env.b).broadcast).toBe(1);

    // A 先读
    const aMsgs = env.mailbox.popMessages({ forSessionId: env.a, unreadOnly: true });
    expect(aMsgs.map((m) => m.body)).toEqual(['全项目注意：今晚发版']);

    // B 仍然能看到（这就是修掉的 bug）
    expect(env.mailbox.countUnread(env.b).broadcast).toBe(1);
    const bMsgs = env.mailbox.popMessages({ forSessionId: env.b, unreadOnly: true });
    expect(bMsgs.map((m) => m.body)).toEqual(['全项目注意：今晚发版']);

    // 都读完之后归零，且重复读不再返回
    expect(env.mailbox.countUnread(env.a).broadcast).toBe(0);
    expect(env.mailbox.countUnread(env.b).broadcast).toBe(0);
    expect(env.mailbox.popMessages({ forSessionId: env.b, unreadOnly: true })).toEqual([]);
  });

  it('B4: 直投消息保持「读了就没了」', () => {
    env.mailbox.postMessage({ toSessionId: env.a, body: '只给 A 的私信', kind: 'info' });
    expect(env.mailbox.countUnread(env.a).direct).toBe(1);

    const msgs = env.mailbox.popMessages({ forSessionId: env.a, unreadOnly: true });
    expect(msgs.map((m) => m.body)).toEqual(['只给 A 的私信']);
    expect(env.mailbox.countUnread(env.a).direct).toBe(0);
    expect(env.mailbox.popMessages({ forSessionId: env.a, unreadOnly: true })).toEqual([]);
  });

  it('B5: 自己发的广播不算自己的未读', () => {
    env.mailbox.postMessage({
      toProject: PROJECT,
      fromSessionId: env.a,
      body: '我自己发的公告',
      kind: 'info',
    });
    expect(env.mailbox.countUnread(env.a).broadcast).toBe(0);
    expect(env.mailbox.countUnread(env.b).broadcast).toBe(1);
  });

  it('B6: 广播 + 直投并存时未读计数分别正确', () => {
    env.mailbox.postMessage({ toProject: PROJECT, body: '广播一条', kind: 'info' });
    env.mailbox.postMessage({ toSessionId: env.a, body: '私信一条', kind: 'question' });

    const u = env.mailbox.countUnread(env.a);
    expect(u.broadcast).toBe(1);
    expect(u.direct).toBe(1);
    expect(u.total).toBe(2);

    const msgs = env.mailbox.popMessages({ forSessionId: env.a, unreadOnly: true });
    expect(msgs.map((m) => m.body).sort()).toEqual(['广播一条', '私信一条'].sort());
    expect(env.mailbox.countUnread(env.a).total).toBe(0);
    // B 只受广播影响
    expect(env.mailbox.countUnread(env.b).broadcast).toBe(1);
    expect(env.mailbox.countUnread(env.b).direct).toBe(0);
  });
});
