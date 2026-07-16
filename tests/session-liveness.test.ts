/**
 * Session 活跃度判定 —— file_modified_at 驱动
 *
 * 核心问题（BUG）：
 *   旧实现用 updated_at（= 扫描时刻 Date.now()）判定 isLive，
 *   导致 daemon 扫到一批 session 时全部标 LIVE，即使文件几小时前就停了。
 *
 * 修复方向：
 *   1. 新增 file_modified_at 列，记录 session 文件的实际 mtime
 *   2. isLive 改基于 file_modified_at，不受扫描时间影响
 *   3. 内容不变重新 ingest 不覆盖 file_modified_at
 *   4. activityStatus 三级：live / idle / stale
 *
 * 设计原则：用 vi.setSystemTime 固定时间，确保判定逻辑可验证。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionStore } from '../src/store/index.js';

const DEVICE = 'mac-test';
const NOW = 1_784_090_400_000; // 2026-07-15 12:00:00 UTC
const MIN = 60_000;
const HOUR = 60 * MIN;

function freshStore(): SessionStore {
  return new SessionStore(':memory:');
}

function claudeInstance(store: SessionStore): string {
  return store.registerSourceInstance({
    deviceId: DEVICE,
    source: 'claude-code',
    rootPath: '/Users/test/.claude/projects',
    coverage: 'A',
  }).id;
}

/** 入库一条 session，可指定 fileModifiedAt */
function ingest(
  store: SessionStore,
  instId: string,
  opts: {
    nativeId: string;
    fileModifiedAt?: number;
    messages?: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: number }>;
    topology?: 'root' | 'subagent';
  },
) {
  return store.ingestSession({
    deviceId: DEVICE,
    sourceInstanceId: instId,
    nativeSessionId: opts.nativeId,
    source: 'claude-code',
    topology: opts.topology ?? 'root',
    messages: opts.messages ?? [{ role: 'user', content: 'hello', timestamp: 1 }],
    fileModifiedAt: opts.fileModifiedAt,
  });
}

describe('file_modified_at 存储', () => {
  let store: SessionStore;
  let instId: string;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    store = freshStore();
    instId = claudeInstance(store);
  });
  afterEach(() => vi.useRealTimers());

  it('首次入库时 file_modified_at 写入传入值', () => {
    const result = ingest(store, instId, {
      nativeId: 's1',
      fileModifiedAt: NOW - 5 * MIN,
    });
    const session = store.getSession(result.sessionId);
    expect(session!.fileModifiedAt).toBe(NOW - 5 * MIN);
  });

  it('未传 fileModifiedAt 时回退到 Date.now()', () => {
    const result = ingest(store, instId, { nativeId: 's1' });
    const session = store.getSession(result.sessionId);
    expect(session!.fileModifiedAt).toBe(NOW);
  });

  it('内容变化时 file_modified_at 更新为新值', () => {
    const r1 = ingest(store, instId, {
      nativeId: 's1',
      fileModifiedAt: NOW - HOUR,
      messages: [{ role: 'user', content: 'old', timestamp: 1 }],
    });
    vi.setSystemTime(NOW);
    const r2 = store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: instId,
      nativeSessionId: 's1',
      source: 'claude-code',
      messages: [{ role: 'user', content: 'new', timestamp: 2 }],
      fileModifiedAt: NOW,
    });
    expect(r2.newRevision).toBe(true);
    const session = store.getSession(r1.sessionId);
    expect(session!.fileModifiedAt).toBe(NOW);
  });

  it('内容不变重新 ingest → file_modified_at 不被覆盖为扫描时间', () => {
    const fileTime = NOW - 10 * MIN;
    ingest(store, instId, {
      nativeId: 's1',
      fileModifiedAt: fileTime,
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    });
    // 模拟 daemon 扫描：内容相同，但时间已过 5 分钟
    vi.setSystemTime(NOW + 5 * MIN);
    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: instId,
      nativeSessionId: 's1',
      source: 'claude-code',
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      fileModifiedAt: fileTime,
    });
    const sessions = store.getActiveSessionsSummary(30 * MIN).sessions;
    const s = sessions.find((x) => x.nativeSessionId === 's1');
    expect(s).toBeDefined();
    expect(s!.fileModifiedAt).toBe(fileTime);
  });
});

describe('isLive 基于 file_modified_at（核心 BUG 修复）', () => {
  let store: SessionStore;
  let instId: string;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    store = freshStore();
    instId = claudeInstance(store);
  });
  afterEach(() => vi.useRealTimers());

  it('文件 30 秒前修改 → isLive=true', () => {
    ingest(store, instId, {
      nativeId: 'live-1',
      fileModifiedAt: NOW - 30_000,
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
    });
    const summary = store.getActiveSessionsSummary(30 * MIN);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'live-1');
    expect(s!.isLive).toBe(true);
    expect(s!.activityStatus).toBe('live');
  });

  it('文件 5 分钟前修改 → isLive=false, activityStatus=idle', () => {
    ingest(store, instId, {
      nativeId: 'idle-1',
      fileModifiedAt: NOW - 5 * MIN,
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
    });
    const summary = store.getActiveSessionsSummary(30 * MIN);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'idle-1');
    expect(s!.isLive).toBe(false);
    expect(s!.activityStatus).toBe('idle');
  });

  it('文件 1 小时前修改 → activityStatus=stale', () => {
    ingest(store, instId, {
      nativeId: 'stale-1',
      fileModifiedAt: NOW - HOUR,
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
    });
    const summary = store.getActiveSessionsSummary(2 * HOUR);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'stale-1');
    expect(s).toBeDefined();
    expect(s!.isLive).toBe(false);
    expect(s!.activityStatus).toBe('stale');
  });

  it('扫描行为不制造假 LIVE（核心 BUG 复现）', () => {
    // 场景：session 文件在 2 小时前就停了写入
    const fileTime = NOW - 2 * HOUR;
    ingest(store, instId, {
      nativeId: 'stopped-1',
      fileModifiedAt: fileTime,
      messages: [{ role: 'user', content: 'done', timestamp: 1 }],
    });

    // 模拟 daemon 在 NOW 扫描（内容不变，只刷新 last_seen_at）
    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: instId,
      nativeSessionId: 'stopped-1',
      source: 'claude-code',
      messages: [{ role: 'user', content: 'done', timestamp: 1 }],
      fileModifiedAt: fileTime,
    });

    const summary = store.getActiveSessionsSummary(3 * HOUR);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'stopped-1');
    expect(s).toBeDefined();
    // 关键断言：即使刚被扫描，也不应该是 LIVE
    expect(s!.isLive).toBe(false);
    expect(s!.activityStatus).toBe('stale');
  });

  it('file_modified_at NULL 回退到 updated_at（兼容老数据）', () => {
    // 模拟老数据：直接插入一条没有 file_modified_at 的 session
    store.db.exec(`
      INSERT INTO sessions (id, device_id, source_instance_id, native_session_id, source,
        topology, presence, retention, sync_state, content_hash, message_count,
        last_seen_at, created_at, updated_at)
      VALUES ('legacy-1', '${DEVICE}', '${instId}', 'legacy-native', 'claude-code',
        'root', 'present', 'live', 'local', 'fakehash', 1,
        ${NOW - 10 * MIN}, ${NOW - 10 * MIN}, ${NOW - 10 * MIN})
    `);

    const summary = store.getActiveSessionsSummary(30 * MIN);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'legacy-native');
    expect(s).toBeDefined();
    expect(s!.isLive).toBe(false);
    expect(s!.activityStatus).toBe('idle');
  });
});

describe('getActiveSessionsSummary 聚合统计', () => {
  let store: SessionStore;
  let instId: string;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    store = freshStore();
    instId = claudeInstance(store);

    ingest(store, instId, {
      nativeId: 'live',
      fileModifiedAt: NOW - 30_000,
      messages: [{ role: 'user', content: 'a', timestamp: 1 }],
    });
    ingest(store, instId, {
      nativeId: 'idle',
      fileModifiedAt: NOW - 5 * MIN,
      messages: [{ role: 'user', content: 'b', timestamp: 1 }],
    });
    ingest(store, instId, {
      nativeId: 'stale',
      fileModifiedAt: NOW - HOUR,
      messages: [{ role: 'user', content: 'c', timestamp: 1 }],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('summary 包含 liveCount / idleCount / staleCount', () => {
    const summary = store.getActiveSessionsSummary(2 * HOUR);
    expect(summary.liveCount).toBe(1);
    expect(summary.idleCount).toBe(1);
    expect(summary.staleCount).toBe(1);
    expect(summary.totalActive).toBe(3);
  });

  it('30 分钟默认窗口不包含 stale session', () => {
    const summary = store.getActiveSessionsSummary(30 * MIN);
    expect(summary.totalActive).toBe(2);
    expect(summary.staleCount).toBe(0);
  });

  it('按 file_modified_at 倒序排列', () => {
    const summary = store.getActiveSessionsSummary(2 * HOUR);
    const times = summary.sessions.map((s) => s.fileModifiedAt);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]!);
    }
  });
});

// ─── 进程存活检测（processAliveChecker）─── ─────────────────────────

describe('processAliveChecker：进程存活 + file mtime 组合判定', () => {
  let store: SessionStore;
  let instId: string;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    store = freshStore();
    instId = claudeInstance(store);
  });
  afterEach(() => vi.useRealTimers());

  it('进程在 + 文件刚写 → live', () => {
    ingest(store, instId, {
      nativeId: 'running-1',
      fileModifiedAt: NOW - 30_000,
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
    });
    const checker = () => new Set(['running-1']);
    const summary = store.getActiveSessionsSummary(30 * MIN, checker);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'running-1');
    expect(s!.activityStatus).toBe('live');
    expect(s!.processAlive).toBe(true);
  });

  it('进程在 + 文件 10 分钟没写 → idle（进程还活着，可能等输入或跑长任务）', () => {
    ingest(store, instId, {
      nativeId: 'waiting-1',
      fileModifiedAt: NOW - 10 * MIN,
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
    });
    const checker = () => new Set(['waiting-1']);
    const summary = store.getActiveSessionsSummary(30 * MIN, checker);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'waiting-1');
    expect(s!.activityStatus).toBe('idle');
    expect(s!.processAlive).toBe(true);
  });

  it('进程不在 + 文件超过 STALE 阈值 → stopped', () => {
    ingest(store, instId, {
      nativeId: 'dead-1',
      fileModifiedAt: NOW - 45 * MIN, // 超过 STALE_THRESHOLD_MS(30min)
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
    });
    const checker = () => new Set<string>(); // 空集：没有任何活进程
    const summary = store.getActiveSessionsSummary(60 * MIN, checker);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'dead-1');
    expect(s!.activityStatus).toBe('stopped');
    expect(s!.processAlive).toBe(false);
  });

  it('混合场景：1 live + 1 idle + 1 stopped', () => {
    ingest(store, instId, { nativeId: 'a', fileModifiedAt: NOW - 30_000, messages: [{ role: 'user', content: '1' }] });
    ingest(store, instId, { nativeId: 'b', fileModifiedAt: NOW - 10 * MIN, messages: [{ role: 'user', content: '2' }] });
    ingest(store, instId, { nativeId: 'c', fileModifiedAt: NOW - 45 * MIN, messages: [{ role: 'user', content: '3' }] }); // 超过 stale 阈值
    const checker = () => new Set(['a', 'b']); // a 和 b 有进程，c 没有
    const summary = store.getActiveSessionsSummary(60 * MIN, checker);
    expect(summary.liveCount).toBe(1);
    expect(summary.idleCount).toBe(1);
    expect(summary.stoppedCount).toBe(1);
    expect(summary.totalActive).toBe(3);
  });

  it('processAliveChecker 未提供时退回 mtime-only（不降低准确性）', () => {
    ingest(store, instId, { nativeId: 'x', fileModifiedAt: NOW - 30_000, messages: [{ role: 'user', content: '1' }] });
    ingest(store, instId, { nativeId: 'y', fileModifiedAt: NOW - 10 * MIN, messages: [{ role: 'user', content: '2' }] });
    const summary = store.getActiveSessionsSummary(30 * MIN);
    const x = summary.sessions.find((s) => s.nativeSessionId === 'x');
    const y = summary.sessions.find((s) => s.nativeSessionId === 'y');
    expect(x!.activityStatus).toBe('live');
    expect(y!.activityStatus).toBe('idle');
    expect(x!.processAlive).toBeNull();
  });
});

// ─── 进程检测可靠性边界 ─────────────────────────────────────────

describe('进程检测可靠性：session ID 不在 ps args 中时不误判 stopped', () => {
  let store: SessionStore;
  let instId: string;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    store = freshStore();
    instId = claudeInstance(store);
  });
  afterEach(() => vi.useRealTimers());

  it('进程检测返回不在 + 文件 30 秒前才写过 → 不能标 stopped（可能只是 session ID 没暴露）', () => {
    // 场景：codex / trae 等 CLI 不在 ps args 里暴露 session ID
    // 但文件刚被写过 → session 显然在跑
    ingest(store, instId, {
      nativeId: 'hidden-session',
      fileModifiedAt: NOW - 30_000,
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
    });
    const checker = () => new Set<string>(); // 进程检测返回空集
    const summary = store.getActiveSessionsSummary(30 * MIN, checker);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'hidden-session');
    // 文件刚写过 → 至少是 live，不能因为进程检测为空就标 stopped
    expect(s!.activityStatus).not.toBe('stopped');
    expect(s!.activityStatus).toBe('live');
  });

  it('进程检测返回不在 + 文件 5 分钟前写过 → idle（不能标 stopped）', () => {
    ingest(store, instId, {
      nativeId: 'hidden-idle',
      fileModifiedAt: NOW - 5 * MIN,
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
    });
    const checker = () => new Set<string>();
    const summary = store.getActiveSessionsSummary(30 * MIN, checker);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'hidden-idle');
    expect(s!.activityStatus).toBe('idle');
  });

  it('进程检测返回不在 + 文件 2 小时前停了 → stopped（此时可以确定）', () => {
    ingest(store, instId, {
      nativeId: 'likely-dead',
      fileModifiedAt: NOW - 2 * HOUR,
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
    });
    const checker = () => new Set<string>();
    const summary = store.getActiveSessionsSummary(3 * HOUR, checker);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'likely-dead');
    // 文件 2 小时没动 + 进程检测也找不到 → 确实 stopped
    expect(s!.activityStatus).toBe('stopped');
  });

  it('进程确认存活 + 文件 2 小时前写 → idle（进程在，只是没在写文件）', () => {
    ingest(store, instId, {
      nativeId: 'long-running',
      fileModifiedAt: NOW - 2 * HOUR,
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
    });
    const checker = () => new Set(['long-running']);
    const summary = store.getActiveSessionsSummary(3 * HOUR, checker);
    const s = summary.sessions.find((x) => x.nativeSessionId === 'long-running');
    // 进程在跑 → 至少 idle，不是 stopped
    expect(s!.activityStatus).toBe('idle');
  });
});

// ─── 等待审阅检测 ─────────────────────────────────────────────────

import type { AwaitingReviewSession } from '../src/store/index.js';

describe('getSessionsAwaitingReview：找出等用户回复的 session', () => {
  let store: SessionStore;
  let instId: string;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    store = freshStore();
    instId = claudeInstance(store);
  });
  afterEach(() => vi.useRealTimers());

  it('最后一条消息是 assistant + 近期活跃 → 等待审阅', () => {
    ingest(store, instId, {
      nativeId: 'waiting-1',
      fileModifiedAt: NOW - MIN,
      messages: [
        { role: 'user', content: '帮我改 bug', timestamp: 1 },
        { role: 'assistant', content: '改好了，请审阅', timestamp: 2 },
      ],
    });
    const result = store.getSessionsAwaitingReview();
    const s = result.find((x) => x.nativeSessionId === 'waiting-1');
    expect(s).toBeDefined();
    expect(s!.lastRole).toBe('assistant');
  });

  it('最后一条消息是 user → 不等待审阅（agent 正在干活）', () => {
    ingest(store, instId, {
      nativeId: 'working-1',
      fileModifiedAt: NOW - 10_000,
      messages: [
        { role: 'assistant', content: '我来看看', timestamp: 1 },
        { role: 'user', content: '好的继续', timestamp: 2 },
      ],
    });
    const result = store.getSessionsAwaitingReview();
    const s = result.find((x) => x.nativeSessionId === 'working-1');
    expect(s).toBeUndefined();
  });

  it('最后消息是 assistant + 文件 2 小时前 → 不等待审阅（已放弃）', () => {
    ingest(store, instId, {
      nativeId: 'abandoned-1',
      fileModifiedAt: NOW - 2 * HOUR,
      messages: [
        { role: 'user', content: 'hi', timestamp: 1 },
        { role: 'assistant', content: 'done', timestamp: 2 },
      ],
    });
    const result = store.getSessionsAwaitingReview();
    const s = result.find((x) => x.nativeSessionId === 'abandoned-1');
    expect(s).toBeUndefined();
  });

  it('混合场景：2 个等待审阅，1 个在干活，1 个已放弃', () => {
    ingest(store, instId, {
      nativeId: 'w1', fileModifiedAt: NOW - MIN,
      messages: [{ role: 'user', content: 'a', timestamp: 1 }, { role: 'assistant', content: 'b', timestamp: 2 }],
    });
    ingest(store, instId, {
      nativeId: 'w2', fileModifiedAt: NOW - 5 * MIN,
      messages: [{ role: 'user', content: 'c', timestamp: 1 }, { role: 'assistant', content: 'd', timestamp: 2 }],
    });
    ingest(store, instId, {
      nativeId: 'busy', fileModifiedAt: NOW - 30_000,
      messages: [{ role: 'assistant', content: 'e', timestamp: 1 }, { role: 'user', content: 'f', timestamp: 2 }],
    });
    ingest(store, instId, {
      nativeId: 'old', fileModifiedAt: NOW - 2 * HOUR,
      messages: [{ role: 'user', content: 'g', timestamp: 1 }, { role: 'assistant', content: 'h', timestamp: 2 }],
    });
    const result = store.getSessionsAwaitingReview();
    expect(result).toHaveLength(2);
    const ids = result.map((s) => s.nativeSessionId).sort();
    expect(ids).toEqual(['w1', 'w2']);
  });

  it('结果包含 lastMessagePreview（assistant 最后一条消息的前 100 字）', () => {
    ingest(store, instId, {
      nativeId: 'preview-1',
      fileModifiedAt: NOW - MIN,
      messages: [
        { role: 'user', content: 'x', timestamp: 1 },
        { role: 'assistant', content: 'A'.repeat(200), timestamp: 2 },
      ],
    });
    const result = store.getSessionsAwaitingReview();
    const s = result.find((x) => x.nativeSessionId === 'preview-1');
    expect(s!.lastMessagePreview.length).toBe(100);
  });

  it('结果按 fileModifiedAt 倒序（最近完成的排前面）', () => {
    ingest(store, instId, {
      nativeId: 'newer', fileModifiedAt: NOW - MIN,
      messages: [{ role: 'user', content: 'a', timestamp: 1 }, { role: 'assistant', content: 'b', timestamp: 2 }],
    });
    ingest(store, instId, {
      nativeId: 'older', fileModifiedAt: NOW - 10 * MIN,
      messages: [{ role: 'user', content: 'c', timestamp: 1 }, { role: 'assistant', content: 'd', timestamp: 2 }],
    });
    const result = store.getSessionsAwaitingReview();
    expect(result[0]!.nativeSessionId).toBe('newer');
    expect(result[1]!.nativeSessionId).toBe('older');
  });
});
