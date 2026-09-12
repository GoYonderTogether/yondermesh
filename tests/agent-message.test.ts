/**
 * agent_message（统一通信工具）测试
 *
 * 覆盖收敛后的核心语义：
 *   1. 投递时机翻译（now / after_turn / on_reply ↔ DB 的 deliver_on）
 *   2. 合并与包装（同目标积压合并成一条；on_reply 以用户口吻不加来源）
 *   3. check：读自己的收件箱
 *   4. send + now：目标在跑 → 拒绝（防双写）；目标已停 → 真投递
 *   5. send + on_reply / after_turn：只入队，不立即投递
 *   6. DeliveryFlusher：session 从 live 变 idle 时才把队列投出去
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionStore } from '../src/store/index.js';
import { MailboxCore } from '../src/mailbox/core.js';
import {
  agentMessage,
  coalesce,
  toDeliveryPolicy,
  wrapForDelivery,
} from '../src/mailbox/unified.js';
import { DeliveryFlusher } from '../src/daemon/delivery.js';
import { TriggerAdapter } from '../src/trigger/adapter.js';
import { ReplyAdapter } from '../src/trigger/reply-adapter.js';
import type { TriggerRequest, TriggerResult } from '../src/trigger/types.js';

const DEVICE = 'agent-message-test';

/** 假触发器：不真的起 CLI，记录请求，返回预设回复 */
class FakeTrigger extends TriggerAdapter {
  public lastRequest: TriggerRequest | undefined;
  constructor(private readonly canned: TriggerResult) {
    super();
  }
  override async trigger(req: TriggerRequest): Promise<TriggerResult> {
    this.lastRequest = req;
    return this.canned;
  }
}

function makeEnv(opts?: { delivered?: boolean }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ymesh-agentmsg-'));
  const dbPath = join(dataDir, 'test.db');
  const store = new SessionStore(dbPath);
  const fake = new FakeTrigger({
    delivered: opts?.delivered ?? true,
    response: 'OK',
    exitCode: 0,
    channel: 'cli-spawn',
  } as TriggerResult);
  const core = new MailboxCore(dbPath, dataDir, fake, new ReplyAdapter());

  const inst = store.registerSourceInstance({
    deviceId: DEVICE,
    source: 'pi',
    rootPath: '/fake/.pi',
    coverage: 'A',
  });

  /** 灌一个 session，modifyAgeMs 控制「多久没动」→ 决定 live 与否 */
  const addSession = (nativeId: string, cwd: string, modifyAgeMs = 0): string => {
    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: nativeId,
      source: 'pi',
      cwd,
      projectPath: cwd,
      startedAt: Date.now() - 60_000,
      lastSeenAt: Date.now() - modifyAgeMs,
      fileModifiedAt: Date.now() - modifyAgeMs,
      messages: [{ role: 'user', content: 'hi' }],
    } as never);
    const found = store.querySessions({ source: 'pi' } as never).find(
      (s) => s.nativeSessionId === nativeId,
    );
    return found!.id;
  };

  return {
    store,
    core,
    fake,
    addSession,
    cleanup: () => {
      core.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe('agent_message 1. 投递时机翻译', () => {
  it('now → null（不入队）；after_turn → sender_idle；on_reply → target_idle', () => {
    expect(toDeliveryPolicy('now')).toBeNull();
    expect(toDeliveryPolicy('after_turn')).toBe('sender_idle');
    expect(toDeliveryPolicy('on_reply')).toBe('target_idle');
  });
});

describe('agent_message 2. 合并与包装', () => {
  it('多条合并成一条并编号（省 token：只唤醒目标一次）', () => {
    const merged = coalesce([{ body: 'A' }, { body: 'B' }, { body: 'C' }]);
    expect(merged).toContain('A');
    expect(merged).toContain('C');
    expect(merged).toContain('1/3');
  });

  it('单条不编号（原样）', () => {
    expect(coalesce([{ body: 'solo' }])).toBe('solo');
  });

  it('after_turn 标明来自哪个 session；on_reply 不加来源（用户口吻）', () => {
    expect(wrapForDelivery('sender_idle', '干活了', 'abcdef1234567890')).toContain('另一个 agent');
    expect(wrapForDelivery('target_idle', '按这个改', 'abcdef1234567890')).toBe('按这个改');
  });
});

describe('agent_message 3. check', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => env.cleanup());

  it('读自己的收件箱（未读计数 + 消息内容）', async () => {
    const me = env.addSession('me-native', '/proj/me');
    const other = env.addSession('other-native', '/proj/other');
    env.core.postMessage({ toSessionId: me, fromSessionId: other, body: '来自同事的留言' });

    const res = await agentMessage(
      { core: env.core, store: env.store },
      { action: 'check', selfSessionId: me },
    );
    expect(res.ok).toBe(true);
    if (res.action !== 'check') throw new Error('unreachable');
    expect(res.unread).toBe(1);
    expect(res.messages?.[0].body).toBe('来自同事的留言');
  });

  it('队列里还没投递的消息会被标成 pending', async () => {
    const me = env.addSession('me-n', '/proj/me');
    const other = env.addSession('other-n', '/proj/other');
    env.core.postMessage({
      toSessionId: me,
      fromSessionId: other,
      body: '稍后再给你的',
      deliverOn: 'target_idle',
    });
    const res = await agentMessage(
      { core: env.core, store: env.store },
      { action: 'check', selfSessionId: me },
    );
    if (res.action !== 'check') throw new Error('unreachable');
    expect(res.messages?.[0].pending).toBe(true);
  });
});

describe('agent_message 4. send + now', () => {
  it('目标正在运行 → 拒绝（外部注入会与它自己双写）', async () => {
    const env = makeEnv();
    try {
      const live = env.addSession('live-native', '/proj/live', 0);
      const res = await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: live, body: 'hi', delivery: 'now' },
      );
      expect(res.ok).toBe(false);
      if (res.action !== 'send') throw new Error('unreachable');
      expect(res.error).toContain('正在运行');
      expect(res.hint).toContain('on_reply');
      // 关键：没有真的去 spawn CLI
      expect(env.fake.lastRequest).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it('目标已停止 → 真投递并拿到回复', async () => {
    const env = makeEnv();
    try {
      const idle = env.addSession('idle-native', '/proj/idle', 10 * 60_000);
      const res = await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: idle, body: '做这个', delivery: 'now' },
      );
      expect(res.ok).toBe(true);
      if (res.action !== 'send') throw new Error('unreachable');
      expect(res.delivered).toBe(true);
      expect(res.response).toBe('OK');
      expect(env.fake.lastRequest?.message).toBe('做这个');
    } finally {
      env.cleanup();
    }
  });

  it('支持用 native id / 前缀定位目标（自动解析 CLI）', async () => {
    const env = makeEnv();
    try {
      env.addSession('01a0beef-1111-2222-3333-444444444444', '/proj/x', 10 * 60_000);
      const res = await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: '01a0beef', body: 'hi', delivery: 'now' },
      );
      expect(res.ok).toBe(true);
      if (res.action !== 'send') throw new Error('unreachable');
      expect(res.to?.source).toBe('pi');
    } finally {
      env.cleanup();
    }
  });
});

describe('agent_message 5. send + 队列', () => {
  it('on_reply：只入队，不立刻投递', async () => {
    const env = makeEnv();
    try {
      const target = env.addSession('t-native', '/proj/t', 10 * 60_000);
      const res = await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: target, body: '等会再发', delivery: 'on_reply' },
      );
      expect(res.ok).toBe(true);
      if (res.action !== 'send') throw new Error('unreachable');
      expect(res.delivered).toBe(false);
      expect(res.delivery).toBe('on_reply');
      expect(res.messageId).toBeGreaterThan(0);
      // 队列里有它，但还没投
      const pending = env.core.pendingDeliveries('target_idle', target);
      expect(pending).toHaveLength(1);
      expect(env.fake.lastRequest).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it('after_turn 广播：不需要知道收件人', async () => {
    const env = makeEnv();
    try {
      const res = await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: 'all', body: '大家好', delivery: 'after_turn' },
      );
      expect(res.ok).toBe(true);
      if (res.action !== 'send') throw new Error('unreachable');
      expect(res.delivery).toBe('queued');
    } finally {
      env.cleanup();
    }
  });
});

describe('agent_message 6. DeliveryFlusher（daemon 侧）', () => {
  it('目标已空闲 → 把 on_reply 队列投出去，并标记已投递', async () => {
    const env = makeEnv();
    try {
      // 目标从一开始就是 idle（10 分钟没动）
      const target = env.addSession('flush-native', '/proj/flush', 10 * 60_000);
      await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: target, body: '等你忙完', delivery: 'on_reply' },
      );
      expect(env.core.pendingDeliveriesAll('target_idle')).toHaveLength(1);

      const flusher = new DeliveryFlusher(env.store, env.core);
      const report = await flusher.onScanned();

      expect(report.flushed).toBe(1);
      expect(report.deliveries).toBe(1);
      expect(env.core.pendingDeliveriesAll('target_idle')).toHaveLength(0);
      // 真的投出去了，且是「用户口吻」（无 agent 来源前缀）
      expect(env.fake.lastRequest?.message).toBe('等你忙完');
    } finally {
      env.cleanup();
    }
  });

  it('目标还在忙 → 不投，留在队列', async () => {
    const env = makeEnv();
    try {
      const target = env.addSession('busy-native', '/proj/busy', 0); // 刚动过 = live
      await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: target, body: '等你忙完', delivery: 'on_reply' },
      );
      const report = await new DeliveryFlusher(env.store, env.core).onScanned();
      expect(report.flushed).toBe(0);
      expect(env.core.pendingDeliveriesAll('target_idle')).toHaveLength(1);
      expect(env.fake.lastRequest).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it('after_turn：发送方空闲后投给各目标，同目标的多条合并成一条', async () => {
    const env = makeEnv();
    try {
      const sender = env.addSession('sender-native', '/proj/s', 10 * 60_000);
      const t1 = env.addSession('t1-native', '/proj/t1', 10 * 60_000);
      const t2 = env.addSession('t2-native', '/proj/t2', 10 * 60_000);

      for (const body of ['第一条', '第二条']) {
        await agentMessage(
          { core: env.core, store: env.store },
          { action: 'send', to: t1, body, delivery: 'after_turn', selfSessionId: sender },
        );
      }
      await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: t2, body: '给两号的', delivery: 'after_turn', selfSessionId: sender },
      );

      const report = await new DeliveryFlusher(env.store, env.core).onScanned();
      expect(report.flushed).toBe(3);
      expect(report.deliveries).toBe(2); // t1 合并成 1 次 + t2 1 次
      expect(env.core.pendingDeliveriesAll('sender_idle')).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });

  it('投递失败：不崩、不清队列（下轮重试）', async () => {
    const env = makeEnv({ delivered: false });
    try {
      const target = env.addSession('fail-native', '/proj/fail', 10 * 60_000);
      await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: target, body: 'x', delivery: 'on_reply' },
      );
      const report = await new DeliveryFlusher(env.store, env.core).onScanned();
      expect(report.errors.length).toBeGreaterThan(0);
      // 没投成功 → 队列保留，下轮再试
      expect(env.core.pendingDeliveriesAll('target_idle')).toHaveLength(1);
    } finally {
      env.cleanup();
    }
  });

  it('限次：目标一直投不进去时，试够次数就放弃（消息仍留在库）', async () => {
    const env = makeEnv({ delivered: false });
    try {
      const target = env.addSession('giveup-native', '/proj/giveup', 10 * 60_000);
      await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: target, body: '永远送不到', delivery: 'on_reply' },
      );
      const flusher = new DeliveryFlusher(env.store, env.core);
      // 连跑 5 轮（= MAX_DELIVERY_ATTEMPTS）
      for (let i = 0; i < 5; i++) await flusher.onScanned();
      // 第 6 轮：尝试次数已到上限 → 放弃，不再重试
      const report = await flusher.onScanned();
      expect(report.errors).toHaveLength(0);
      expect(env.core.pendingDeliveriesAll('target_idle')).toHaveLength(0);
      // 关键：消息没被删，人还能看到
      const all = env.core.peekMessages({ forSessionId: target });
      expect(all).toHaveLength(1);
      expect(all[0].body).toBe('永远送不到');
    } finally {
      env.cleanup();
    }
  });

  it('幂等：连跑两次不会重复投递', async () => {
    const env = makeEnv();
    try {
      const target = env.addSession('idem-native', '/proj/idem', 10 * 60_000);
      await agentMessage(
        { core: env.core, store: env.store },
        { action: 'send', to: target, body: '只发一次', delivery: 'on_reply' },
      );
      const flusher = new DeliveryFlusher(env.store, env.core);
      expect((await flusher.onScanned()).flushed).toBe(1);
      expect((await flusher.onScanned()).flushed).toBe(0);
    } finally {
      env.cleanup();
    }
  });
});
