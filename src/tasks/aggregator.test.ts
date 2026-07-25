/**
 * TaskAggregator 测试
 *
 * 验收门（对齐 loop 的 Observation）：
 *   1. 任务卡片结构正确（项目/类别/状态/Agent/摘要/设备）
 *   2. 跨设备标记正确（devices.length > 1 → crossDevice=true）
 *   3. 无重复（同 project 仅一张卡片）
 *   4. 覆盖所有 live session（live session 必出现在某张卡片中且 status=live）
 *   5. 状态判定：live / idle / stopped / failed
 *   6. 类别分类：bugfix / feature / refactor / testing / docs / config / other
 *   7. activeOnly 过滤、时间窗口过滤
 *   8. 空库不崩
 *   9. classifyCategory 纯函数
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../store/index.js';
import type { SessionIngestInput } from '../store/index.js';
import { TaskAggregator, classifyCategory } from './aggregator.js';

const DEVICE_A = 'mac-001';
const DEVICE_B = 'mac-002';

function freshStore(): SessionStore {
  return new SessionStore(':memory:');
}

/** 构造并入库一个 session */
function mkSession(opts: {
  store: SessionStore;
  sourceInstanceId: string;
  device: string;
  source: string;
  project: string;
  startedAt: number;
  messages: { role: 'user' | 'assistant'; content: string }[];
  fileModifiedAt?: number;
  nativeId?: string;
}): string {
  const input: SessionIngestInput = {
    deviceId: opts.device,
    sourceInstanceId: opts.sourceInstanceId,
    nativeSessionId:
      opts.nativeId ?? `${opts.source}-${opts.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    source: opts.source,
    projectPath: opts.project,
    startedAt: opts.startedAt,
    messages: opts.messages,
    fileModifiedAt: opts.fileModifiedAt,
  };
  const res = opts.store.ingestSession(input);
  return res.sessionId;
}

describe('TaskAggregator', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = freshStore();
  });

  afterEach(() => {
    store.close();
  });

  it('空库不崩，返回空数组', () => {
    const agg = new TaskAggregator(store);
    const cards = agg.aggregate();
    expect(cards).toEqual([]);
  });

  it('单 session → 单卡片，结构字段齐全', () => {
    const t = Date.now();
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo1',
      startedAt: t,
      messages: [
        { role: 'user', content: 'implement feature X' },
        { role: 'assistant', content: 'ok' },
      ],
      fileModifiedAt: t,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate();
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c.projectPath).toBe('/repo1');
    expect(c.category).toBe('feature');
    expect(c.status).toBe('live'); // fileModifiedAt = now
    expect(c.agents).toEqual(['claude']);
    expect(c.devices).toEqual([DEVICE_A]);
    expect(c.crossDevice).toBe(false);
    expect(c.sessionCount).toBe(1);
    expect(c.summary).toBe('implement feature X');
    expect(c.sessions).toHaveLength(1);
    expect(c.sessions[0]!.status).toBe('live');
    expect(c.sessions[0]!.lastUserPreview).toBe('implement feature X');
    // id 确定性
    expect(c.id).toContain(':feature');
  });

  it('同项目多 session → 聚合成一张卡片', () => {
    const t = Date.now();
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo1',
      startedAt: t - 1000,
      messages: [{ role: 'user', content: 'old session' }],
      fileModifiedAt: t - 1000,
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo1',
      startedAt: t,
      messages: [{ role: 'user', content: 'new session' }],
      fileModifiedAt: t,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.sessionCount).toBe(2);
    expect(cards[0]!.sessions).toHaveLength(2);
    // 摘要取最新 session 的最后 user 消息
    expect(cards[0]!.summary).toBe('new session');
    // sessions 按最后活动倒序
    expect(cards[0]!.sessions[0]!.lastUserPreview).toBe('new session');
    expect(cards[0]!.sessions[1]!.lastUserPreview).toBe('old session');
  });

  it('跨设备检测：devices.length > 1 → crossDevice=true', () => {
    const t = Date.now();
    const instA = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    const instB = store.registerSourceInstance({
      deviceId: DEVICE_B,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: instA.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo-shared',
      startedAt: t,
      messages: [{ role: 'user', content: 'from A' }],
      fileModifiedAt: t,
    });
    mkSession({
      store,
      sourceInstanceId: instB.id,
      device: DEVICE_B,
      source: 'claude',
      project: '/repo-shared',
      startedAt: t,
      messages: [{ role: 'user', content: 'from B' }],
      fileModifiedAt: t,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate();
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c.crossDevice).toBe(true);
    expect(c.devices.sort()).toEqual([DEVICE_A, DEVICE_B]);
  });

  it('状态判定：live（fileModifiedAt 在 LIVE_THRESHOLD_MS 内）', () => {
    const t = Date.now();
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t,
      messages: [{ role: 'user', content: 'live now' }],
      fileModifiedAt: t,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate();
    expect(cards[0]!.status).toBe('live');
    expect(cards[0]!.sessions[0]!.status).toBe('live');
  });

  it('状态判定：idle（活跃窗口内但非 live）', () => {
    const now = Date.now();
    // idle：fileModifiedAt 在 LIVE_THRESHOLD_MS 之外、活跃窗口之内
    // LIVE_THRESHOLD_MS=120s，活跃窗口默认 30min
    const idleAt = now - 5 * 60_000; // 5 分钟前
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: idleAt,
      messages: [{ role: 'user', content: 'idle session' }],
      fileModifiedAt: idleAt,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate({ activeWithinMs: 30 * 60_000 });
    expect(cards[0]!.status).toBe('idle');
    expect(cards[0]!.sessions[0]!.status).toBe('idle');
  });

  it('状态判定：stopped（活跃窗口外）', () => {
    const now = Date.now();
    // stopped：fileModifiedAt 早于活跃窗口
    const oldAt = now - 60 * 60_000; // 60 分钟前
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: oldAt,
      messages: [{ role: 'user', content: 'just a normal stopped session' }],
      fileModifiedAt: oldAt,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate({ activeWithinMs: 30 * 60_000 });
    expect(cards[0]!.status).toBe('stopped');
    expect(cards[0]!.sessions[0]!.status).toBe('stopped');
  });

  it('状态判定：failed（stopped + 最后 user 消息含失败信号）', () => {
    const now = Date.now();
    const oldAt = now - 60 * 60_000; // stopped
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: oldAt,
      messages: [
        { role: 'user', content: 'run tests' },
        { role: 'assistant', content: '...' },
        { role: 'user', content: 'Error: panic, something failed: traceback' },
      ],
      fileModifiedAt: oldAt,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate({ activeWithinMs: 30 * 60_000 });
    expect(cards[0]!.status).toBe('failed');
  });

  it('覆盖所有 live session：每个 live session 必出现在某张卡片中且 status=live', () => {
    const t = Date.now();
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    const s1 = mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r1',
      startedAt: t,
      messages: [{ role: 'user', content: 'live one' }],
      fileModifiedAt: t,
    });
    const s2 = mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r2',
      startedAt: t,
      messages: [{ role: 'user', content: 'live two' }],
      fileModifiedAt: t,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate();
    expect(cards).toHaveLength(2);
    // 两张都是 live
    for (const c of cards) {
      expect(c.status).toBe('live');
    }
    // 收集所有 session id
    const allIds = new Set<string>();
    for (const c of cards) {
      for (const s of c.sessions) allIds.add(s.sessionId);
    }
    expect(allIds.has(s1)).toBe(true);
    expect(allIds.has(s2)).toBe(true);
  });

  it('activeOnly 过滤：只返回 live/idle/failed', () => {
    const now = Date.now();
    const liveAt = now;
    const oldAt = now - 60 * 60_000;
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r-live',
      startedAt: liveAt,
      messages: [{ role: 'user', content: 'live' }],
      fileModifiedAt: liveAt,
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r-stopped',
      startedAt: oldAt,
      messages: [{ role: 'user', content: 'plain stopped no failure signal' }],
      fileModifiedAt: oldAt,
    });

    const agg = new TaskAggregator(store);
    const all = agg.aggregate();
    expect(all).toHaveLength(2);

    const activeOnly = agg.aggregate({ activeOnly: true });
    // stopped（无失败信号）被过滤
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0]!.projectPath).toBe('/r-live');
    expect(activeOnly[0]!.status).toBe('live');
  });

  it('时间窗口过滤：from/to 生效', () => {
    const tOld = new Date(2026, 5, 1, 9, 0, 0).getTime(); // 6 月 1 日
    const tNew = new Date(2026, 6, 25, 9, 0, 0).getTime(); // 7 月 25 日
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r-old',
      startedAt: tOld,
      messages: [{ role: 'user', content: 'old' }],
      fileModifiedAt: tOld,
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r-new',
      startedAt: tNew,
      messages: [{ role: 'user', content: 'new' }],
      fileModifiedAt: tNew,
    });

    const agg = new TaskAggregator(store);
    // 只看 7 月
    const windowStart = new Date(2026, 6, 1, 0, 0, 0).getTime();
    const cards = agg.aggregate({ from: windowStart });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.projectPath).toBe('/r-new');

    // 只看 7 月 1 日之前
    const windowEnd = new Date(2026, 5, 30, 23, 59, 59).getTime();
    const cards2 = agg.aggregate({ to: windowEnd });
    expect(cards2).toHaveLength(1);
    expect(cards2[0]!.projectPath).toBe('/r-old');
  });

  it('卡片按 lastActivityAt 倒序', () => {
    const now = Date.now();
    const t1 = now - 1000;
    const t2 = now;
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r-old',
      startedAt: t1,
      messages: [{ role: 'user', content: 'old' }],
      fileModifiedAt: t1,
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r-new',
      startedAt: t2,
      messages: [{ role: 'user', content: 'new' }],
      fileModifiedAt: t2,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate();
    expect(cards[0]!.projectPath).toBe('/r-new');
    expect(cards[1]!.projectPath).toBe('/r-old');
    expect(cards[0]!.lastActivityAt).toBeGreaterThanOrEqual(cards[1]!.lastActivityAt);
  });

  it('类别多数票：同项目下多 session，取出现次数最多的类别', () => {
    const t = Date.now();
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    // 2 个 feature + 1 个 bugfix → feature
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t,
      messages: [{ role: 'user', content: 'add new feature' }],
      fileModifiedAt: t,
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t,
      messages: [{ role: 'user', content: 'implement feature Y' }],
      fileModifiedAt: t,
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t,
      messages: [{ role: 'user', content: 'fix bug Z' }],
      fileModifiedAt: t,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.category).toBe('feature');
  });

  it('无 projectPath 时回退 cwd，再回退 (unknown)', () => {
    const t = Date.now();
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    // 不传 projectPath，但传 cwd（SessionIngestInput.cwd 可选）
    store.ingestSession({
      deviceId: DEVICE_A,
      sourceInstanceId: inst.id,
      nativeSessionId: 'no-proj-1',
      source: 'claude',
      cwd: '/some/cwd',
      startedAt: t,
      messages: [{ role: 'user', content: 'hi' }],
      fileModifiedAt: t,
    });
    // 既无 projectPath 也无 cwd
    store.ingestSession({
      deviceId: DEVICE_A,
      sourceInstanceId: inst.id,
      nativeSessionId: 'no-proj-2',
      source: 'claude',
      startedAt: t,
      messages: [{ role: 'user', content: 'hi' }],
      fileModifiedAt: t,
    });

    const agg = new TaskAggregator(store);
    const cards = agg.aggregate();
    const paths = cards.map((c) => c.projectPath).sort();
    expect(paths).toEqual(['(unknown)', '/some/cwd']);
  });

  it('幂等：重复调用结果一致（无副作用）', () => {
    const t = Date.now();
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t,
      messages: [{ role: 'user', content: 'implement feature' }],
      fileModifiedAt: t,
    });

    const agg = new TaskAggregator(store);
    const a = agg.aggregate();
    const b = agg.aggregate();
    expect(a).toEqual(b);
  });
});

describe('classifyCategory（纯函数）', () => {
  it('bugfix 关键词命中', () => {
    expect(classifyCategory('fix the bug')).toBe('bugfix');
    expect(classifyCategory('error: crash on startup')).toBe('bugfix');
  });
  it('feature 关键词命中', () => {
    expect(classifyCategory('add new feature')).toBe('feature');
    expect(classifyCategory('implement X')).toBe('feature');
  });
  it('refactor 关键词命中', () => {
    expect(classifyCategory('refactor this module')).toBe('refactor');
    expect(classifyCategory('cleanup unused code')).toBe('refactor');
  });
  it('testing 关键词命中', () => {
    expect(classifyCategory('write a test')).toBe('testing');
    expect(classifyCategory('add vitest spec')).toBe('testing');
  });
  it('docs 关键词命中', () => {
    expect(classifyCategory('update readme')).toBe('docs');
    expect(classifyCategory('write documentation')).toBe('docs');
  });
  it('config 关键词命中', () => {
    expect(classifyCategory('change config setting')).toBe('config');
    expect(classifyCategory('set env variable')).toBe('config');
  });
  it('无命中 → other', () => {
    expect(classifyCategory('hello world')).toBe('other');
    expect(classifyCategory('')).toBe('other');
  });
  it('多类别命中取最高分', () => {
    // "fix" 命中 bugfix(1)，"add" 命中 feature(1)，并列取先到的（bugfix 在前）
    const r = classifyCategory('fix and add');
    // bugfix 在 CATEGORY_KEYWORDS 中先于 feature，同分时保持先到
    expect(['bugfix', 'feature']).toContain(r);
  });
});
