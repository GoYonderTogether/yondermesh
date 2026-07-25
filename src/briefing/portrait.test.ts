/**
 * PortraitGenerator 测试
 *
 * 验收门：
 *   1. topAgent / topProject / peakHour 与 store 实际值一致
 *   2. workBreakdown（调研 vs 写代码）计数正确（基于 toolCallCount 启发式）
 *   3. bySource / byProject / byHour 切分求和 = totalSessions
 *   4. 空库不崩，topAgent / topProject / peakHour 均为 null
 *   5. 时间窗口过滤生效
 *   6. 并列时按消息数 / key 排序确定
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../store/index.js';
import type { SessionIngestInput } from '../store/index.js';
import { PortraitGenerator } from './portrait.js';

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
  toolCallCount?: number;
  nativeId?: string;
}): void {
  const input: SessionIngestInput = {
    deviceId: opts.device,
    sourceInstanceId: opts.sourceInstanceId,
    nativeSessionId:
      opts.nativeId ?? `${opts.source}-${opts.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    source: opts.source,
    projectPath: opts.project,
    startedAt: opts.startedAt,
    messages: opts.messages,
    toolCallCount: opts.toolCallCount,
  };
  opts.store.ingestSession(input);
}

describe('PortraitGenerator', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = freshStore();
  });

  afterEach(() => {
    store.close();
  });

  it('topAgent / topProject / peakHour 与 store 一致', () => {
    // 构造一个固定时刻，使小时可预测：2026-07-25T10:00:00 本地时间
    const t10 = new Date(2026, 6, 25, 10, 0, 0).getTime();
    const t14 = new Date(2026, 6, 25, 14, 0, 0).getTime();
    const claudeInst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      rootPath: '/home/.claude/projects',
      coverage: 'A',
    });
    const codexInst = store.registerSourceInstance({
      deviceId: DEVICE_B,
      source: 'codex',
      rootPath: '/home/.codex/sessions',
      coverage: 'A',
    });

    // claude @ /repo1 两次（10 点、14 点），codex @ /repo2 一次（10 点）
    mkSession({
      store,
      sourceInstanceId: claudeInst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo1',
      startedAt: t10,
      messages: [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'a' },
      ],
      toolCallCount: 5,
    });
    mkSession({
      store,
      sourceInstanceId: claudeInst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo1',
      startedAt: t14,
      messages: [{ role: 'user', content: 'B' }],
      toolCallCount: 2,
    });
    mkSession({
      store,
      sourceInstanceId: codexInst.id,
      device: DEVICE_B,
      source: 'codex',
      project: '/repo2',
      startedAt: t10,
      messages: [{ role: 'user', content: 'C' }],
      toolCallCount: 0,
    });

    const gen = new PortraitGenerator(store);
    const p = gen.compute();

    // 总数
    expect(p.totalSessions).toBe(3);
    const stats = store.getSessionStats({});
    expect(p.totalSessions).toBe(stats.totalSessions);
    expect(p.totalMessages).toBe(stats.totalMessages);

    // topAgent = claude（2 sessions）
    expect(p.topAgent).not.toBeNull();
    expect(p.topAgent!.key).toBe('claude');
    expect(p.topAgent!.sessions).toBe(2);

    // topProject = /repo1（2 sessions）
    expect(p.topProject).not.toBeNull();
    expect(p.topProject!.key).toBe('/repo1');
    expect(p.topProject!.sessions).toBe(2);

    // peakHour = 10（2 sessions，14 点只有 1）
    expect(p.peakHour).not.toBeNull();
    expect(p.peakHour!.hour).toBe(10);
    expect(p.peakHour!.sessions).toBe(2);

    // agents / devices
    expect(p.agents.sort()).toEqual(['claude', 'codex']);
    expect(p.devices.sort()).toEqual([DEVICE_A, DEVICE_B]);
  });

  it('workBreakdown 计数正确（toolCallCount 启发式）', () => {
    const t0 = Date.now();
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });

    // 2 个 coding（toolCallCount > 0），3 个 research（0 / null）
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t0,
      messages: [{ role: 'user', content: 'a' }],
      toolCallCount: 5,
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t0,
      messages: [{ role: 'user', content: 'b' }],
      toolCallCount: 1,
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t0,
      messages: [{ role: 'user', content: 'c' }],
      toolCallCount: 0,
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t0,
      messages: [{ role: 'user', content: 'd' }],
      // 不传 toolCallCount → null
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t0,
      messages: [{ role: 'user', content: 'e' }],
      toolCallCount: 0,
    });

    const gen = new PortraitGenerator(store);
    const p = gen.compute();

    expect(p.totalSessions).toBe(5);
    expect(p.workBreakdown.coding).toBe(2);
    expect(p.workBreakdown.research).toBe(3);
    expect(p.workBreakdown.codingRate).toBeCloseTo(2 / 5, 5);
    expect(p.workBreakdown.researchRate).toBeCloseTo(3 / 5, 5);
  });

  it('切分求和 = totalSessions', () => {
    const t10 = new Date(2026, 6, 25, 10, 0, 0).getTime();
    const t11 = new Date(2026, 6, 25, 11, 0, 0).getTime();
    const claudeInst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    const codexInst = store.registerSourceInstance({
      deviceId: DEVICE_B,
      source: 'codex',
      coverage: 'A',
    });

    mkSession({
      store,
      sourceInstanceId: claudeInst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo1',
      startedAt: t10,
      messages: [{ role: 'user', content: 'A' }],
    });
    mkSession({
      store,
      sourceInstanceId: codexInst.id,
      device: DEVICE_B,
      source: 'codex',
      project: '/repo2',
      startedAt: t11,
      messages: [{ role: 'user', content: 'B' }],
    });

    const gen = new PortraitGenerator(store);
    const p = gen.compute();

    const sumSource = Object.values(p.bySource).reduce((a, b) => a + b.sessions, 0);
    const sumProject = Object.values(p.byProject).reduce((a, b) => a + b.sessions, 0);
    const sumHour = Object.values(p.byHour).reduce((a, b) => a + b, 0);
    expect(sumSource).toBe(p.totalSessions);
    expect(sumProject).toBe(p.totalSessions);
    expect(sumHour).toBe(p.totalSessions);
  });

  it('空库不崩，topAgent/topProject/peakHour 为 null', () => {
    const gen = new PortraitGenerator(store);
    const p = gen.compute();
    expect(p.totalSessions).toBe(0);
    expect(p.totalMessages).toBe(0);
    expect(p.topAgent).toBeNull();
    expect(p.topProject).toBeNull();
    expect(p.peakHour).toBeNull();
    expect(p.workBreakdown.coding).toBe(0);
    expect(p.workBreakdown.research).toBe(0);
    expect(p.workBreakdown.codingRate).toBe(0);
    expect(p.workBreakdown.researchRate).toBe(0);
    expect(p.agents).toHaveLength(0);
    expect(p.devices).toHaveLength(0);
  });

  it('时间窗口过滤生效（from/to）', () => {
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
      project: '/r',
      startedAt: tOld,
      messages: [{ role: 'user', content: 'old' }],
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: tNew,
      messages: [{ role: 'user', content: 'new' }],
    });

    const gen = new PortraitGenerator(store);
    // 只看 7 月：tNew 在窗口内
    const windowStart = new Date(2026, 6, 1, 0, 0, 0).getTime();
    const p = gen.compute({ from: windowStart });
    expect(p.totalSessions).toBe(1);
    expect(p.from).toBe(windowStart);
    expect(p.to).toBeNull();

    // 只看 7 月 1 日之前：tOld
    const windowEnd = new Date(2026, 5, 30, 23, 59, 59).getTime();
    const p2 = gen.compute({ to: windowEnd });
    expect(p2.totalSessions).toBe(1);
    expect(p2.to).toBe(windowEnd);
  });

  it('并列时按消息数降序、key 升序确定 topAgent', () => {
    const t0 = Date.now();
    const claudeInst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    const codexInst = store.registerSourceInstance({
      deviceId: DEVICE_B,
      source: 'codex',
      coverage: 'A',
    });
    // 两者 session 数都是 1，codex 消息数更多 → topAgent = codex
    mkSession({
      store,
      sourceInstanceId: claudeInst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      startedAt: t0,
      messages: [{ role: 'user', content: 'x' }],
    });
    mkSession({
      store,
      sourceInstanceId: codexInst.id,
      device: DEVICE_B,
      source: 'codex',
      project: '/r',
      startedAt: t0,
      messages: [
        { role: 'user', content: 'y1' },
        { role: 'assistant', content: 'y2' },
        { role: 'user', content: 'y3' },
      ],
    });

    const gen = new PortraitGenerator(store);
    const p = gen.compute();
    expect(p.topAgent).not.toBeNull();
    expect(p.topAgent!.key).toBe('codex');
    expect(p.topAgent!.messages).toBe(3);
  });
});
