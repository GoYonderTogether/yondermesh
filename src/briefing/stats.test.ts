/**
 * StatsGenerator 测试
 *
 * 验收门：
 *   1. totalSessions / totalMessages / rootSessions / subagentSessions 与 store 一致
 *   2. byDay / byProject / byModel 切分计数与 store 一致
 *   3. 切分求和 = totalSessions
 *   4. 空库不崩
 *   5. 时间窗口过滤生效
 *   6. model 为 null 时归入 '(unknown)'
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../store/index.js';
import type { SessionIngestInput } from '../store/index.js';
import { StatsGenerator, sortedDays } from './stats.js';

const DEVICE_A = 'mac-001';
const DEVICE_B = 'mac-002';

function freshStore(): SessionStore {
  return new SessionStore(':memory:');
}

function mkSession(opts: {
  store: SessionStore;
  sourceInstanceId: string;
  device: string;
  source: string;
  project: string;
  startedAt: number;
  messages: { role: 'user' | 'assistant'; content: string }[];
  model?: string;
  topology?: 'root' | 'subagent';
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
    model: opts.model,
    topology: opts.topology,
  };
  opts.store.ingestSession(input);
}

describe('StatsGenerator', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = freshStore();
  });

  afterEach(() => {
    store.close();
  });

  it('totalSessions / totalMessages / root/subagent 与 store 一致', () => {
    const t0 = new Date(2026, 6, 25, 10, 0, 0).getTime();
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
      startedAt: t0,
      messages: [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'a' },
      ],
      model: 'gpt-5',
      topology: 'root',
    });
    mkSession({
      store,
      sourceInstanceId: codexInst.id,
      device: DEVICE_B,
      source: 'codex',
      project: '/repo2',
      startedAt: t0,
      messages: [{ role: 'user', content: 'B' }],
      model: 'gpt-5',
      topology: 'subagent',
    });

    const gen = new StatsGenerator(store);
    const s = gen.compute();

    const stats = store.getSessionStats({});
    expect(s.totalSessions).toBe(stats.totalSessions);
    expect(s.totalMessages).toBe(stats.totalMessages);
    expect(s.rootSessions).toBe(stats.rootSessions);
    expect(s.subagentSessions).toBe(stats.subagentSessions);
    expect(s.totalSessions).toBe(2);
    expect(s.totalMessages).toBe(3);
    expect(s.rootSessions).toBe(1);
    expect(s.subagentSessions).toBe(1);
    expect(s.agents.sort()).toEqual(['claude', 'codex']);
    expect(s.devices.sort()).toEqual([DEVICE_A, DEVICE_B]);
  });

  it('byDay / byProject / byModel 切分计数正确', () => {
    const tDay1 = new Date(2026, 6, 25, 10, 0, 0).getTime();
    const tDay2 = new Date(2026, 6, 26, 14, 0, 0).getTime();
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
      startedAt: tDay1,
      messages: [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'a' },
      ],
      model: 'gpt-5',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo1',
      startedAt: tDay1,
      messages: [{ role: 'user', content: 'B' }],
      model: 'claude-3',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo2',
      startedAt: tDay2,
      messages: [{ role: 'user', content: 'C' }],
      // model 不传 → null → '(unknown)'
    });

    const gen = new StatsGenerator(store);
    const s = gen.compute();

    // byDay
    expect(s.byDay['2026-07-25']!.sessions).toBe(2);
    expect(s.byDay['2026-07-25']!.messages).toBe(3);
    expect(s.byDay['2026-07-26']!.sessions).toBe(1);
    expect(s.byDay['2026-07-26']!.messages).toBe(1);

    // byProject
    expect(s.byProject['/repo1']!.sessions).toBe(2);
    expect(s.byProject['/repo1']!.messages).toBe(3);
    expect(s.byProject['/repo2']!.sessions).toBe(1);

    // byModel
    expect(s.byModel['gpt-5']!.sessions).toBe(1);
    expect(s.byModel['claude-3']!.sessions).toBe(1);
    expect(s.byModel['(unknown)']!.sessions).toBe(1);
  });

  it('切分求和 = totalSessions', () => {
    const t0 = new Date(2026, 6, 25, 10, 0, 0).getTime();
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
      project: '/r1',
      startedAt: t0,
      messages: [{ role: 'user', content: 'A' }],
      model: 'm1',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r2',
      startedAt: t0,
      messages: [{ role: 'user', content: 'B' }],
      model: 'm2',
    });

    const gen = new StatsGenerator(store);
    const s = gen.compute();
    const sumDay = Object.values(s.byDay).reduce((a, b) => a + b.sessions, 0);
    const sumProj = Object.values(s.byProject).reduce((a, b) => a + b.sessions, 0);
    const sumModel = Object.values(s.byModel).reduce((a, b) => a + b.sessions, 0);
    expect(sumDay).toBe(s.totalSessions);
    expect(sumProj).toBe(s.totalSessions);
    expect(sumModel).toBe(s.totalSessions);
  });

  it('空库不崩', () => {
    const gen = new StatsGenerator(store);
    const s = gen.compute();
    expect(s.totalSessions).toBe(0);
    expect(s.totalMessages).toBe(0);
    expect(s.rootSessions).toBe(0);
    expect(s.subagentSessions).toBe(0);
    expect(Object.keys(s.byDay)).toHaveLength(0);
    expect(Object.keys(s.byProject)).toHaveLength(0);
    expect(Object.keys(s.byModel)).toHaveLength(0);
    expect(s.agents).toHaveLength(0);
    expect(s.devices).toHaveLength(0);
  });

  it('时间窗口过滤生效', () => {
    const tOld = new Date(2026, 5, 1, 9, 0, 0).getTime();
    const tNew = new Date(2026, 6, 25, 9, 0, 0).getTime();
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

    const gen = new StatsGenerator(store);
    const windowStart = new Date(2026, 6, 1, 0, 0, 0).getTime();
    const s = gen.compute({ from: windowStart });
    expect(s.totalSessions).toBe(1);
    expect(s.from).toBe(windowStart);
    expect(s.to).toBeNull();
  });

  it('sortedDays 日期升序，(unknown) 排最后', () => {
    const byDay = {
      '2026-07-26': { sessions: 1, messages: 1 },
      '2026-07-25': { sessions: 2, messages: 3 },
      '(unknown)': { sessions: 1, messages: 1 },
    } as const;
    expect(sortedDays(byDay)).toEqual(['2026-07-25', '2026-07-26', '(unknown)']);
  });
});
