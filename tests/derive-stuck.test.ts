/**
 * LOOP build-stuck-detection 测试
 *
 * 验收门（loop §4）：
 *   1. 有“卡住”特征的被标出
 *   2. 活跃的不被标
 *   3. 阈值边界——刚好 staleHours 处——判定正确
 *   4. 阈值可配
 *   5. requireAssistantEnding=false 退化为纯时间判定
 *   6. fileModifiedAt 优先于 lastSeenAt
 *   7. 无 lastMessage 时仅时间命中（requireAssistantEnding=false）
 *   8. contentPreview 截断到 100 字符
 *   9. 零写入副作用（纯函数）
 */

import { describe, it, expect } from 'vitest';
import {
  detectStuckSessions,
  DEFAULT_STUCK_STALE_HOURS,
} from '../src/derive/stuck.js';
import type { StuckSessionInput } from '../src/derive/stuck.js';

const NOW = 1_700_000_000_000; // 固定 now，避免 wall-clock 抖动
const HOUR_MS = 3_600_000;

/** 构造一个 session 输入；缺省字段用合理默认 */
function makeSession(over: Partial<StuckSessionInput> & { id: string }): StuckSessionInput {
  return {
    lastSeenAt: NOW,
    lastMessage: { role: 'assistant', content: '请确认是否继续' },
    ...over,
  };
}

describe('build-stuck-detection: detectStuckSessions', () => {
  it('DEFAULT_STUCK_STALE_HOURS = 2', () => {
    expect(DEFAULT_STUCK_STALE_HOURS).toBe(2);
  });

  it('活跃 session（刚更新 + assistant 结尾）不被标为卡住', () => {
    const sessions = [
      makeSession({ id: 's-active', lastSeenAt: NOW - 10 * 60_000 }), // 10 分钟前
    ];
    const results = detectStuckSessions(sessions, { now: NOW });
    expect(results).toEqual([]);
  });

  it('卡住 session（超阈值 + assistant 结尾）被标出，reasons 含 stale + assistant_ending', () => {
    const sessions = [
      makeSession({ id: 's-stuck', lastSeenAt: NOW - 3 * HOUR_MS }), // 3 小时前
    ];
    const results = detectStuckSessions(sessions, { now: NOW });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.sessionId).toBe('s-stuck');
    expect(r.reasons).toContain('stale');
    expect(r.reasons).toContain('assistant_ending');
    expect(r.hoursSinceUpdate).toBeCloseTo(3, 2);
    expect(r.lastMessage?.role).toBe('assistant');
    expect(r.lastMessage?.contentPreview).toBe('请确认是否继续');
  });

  it('边界：刚好 staleHours（=）判定为 stale / 卡住', () => {
    // 严格 >=：刚好 2 小时也算 stale
    const sessions = [
      makeSession({ id: 's-boundary', lastSeenAt: NOW - 2 * HOUR_MS }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW, staleHours: 2 });
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe('s-boundary');
    expect(results[0]!.hoursSinceUpdate).toBe(2);
  });

  it('边界：略低于 staleHours 不算 stale', () => {
    const sessions = [
      makeSession({ id: 's-just-under', lastSeenAt: NOW - (2 * HOUR_MS - 1) }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW, staleHours: 2 });
    expect(results).toEqual([]);
  });

  it('阈值可配：staleHours=0.5 时 1 小时前算卡住', () => {
    const sessions = [
      makeSession({ id: 's-half', lastSeenAt: NOW - HOUR_MS }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW, staleHours: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0]!.reasons).toContain('stale');
  });

  it('requireAssistantEnding=true（默认）时 stale 但 user 结尾不算卡住', () => {
    const sessions = [
      makeSession({
        id: 's-user-end',
        lastSeenAt: NOW - 3 * HOUR_MS,
        lastMessage: { role: 'user', content: '继续' },
      }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW });
    // stale 命中但 assistant_ending 不命中，AND 不成立
    expect(results).toEqual([]);
  });

  it('requireAssistantEnding=false 退化为纯时间判定（user 结尾也卡住）', () => {
    const sessions = [
      makeSession({
        id: 's-user-end-2',
        lastSeenAt: NOW - 3 * HOUR_MS,
        lastMessage: { role: 'user', content: '继续' },
      }),
    ];
    const results = detectStuckSessions(sessions, {
      now: NOW,
      requireAssistantEnding: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.reasons).toContain('stale');
    // user 结尾不该出现 assistant_ending
    expect(results[0]!.reasons).not.toContain('assistant_ending');
  });

  it('fileModifiedAt 优先于 lastSeenAt 作为「上次活动」', () => {
    // lastSeenAt 久远（3h 前），但 fileModifiedAt 新（10min 前）→ 不卡住
    const sessions = [
      makeSession({
        id: 's-filemtime-priority',
        lastSeenAt: NOW - 3 * HOUR_MS,
        fileModifiedAt: NOW - 10 * 60_000,
      }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW });
    expect(results).toEqual([]);
  });

  it('fileModifiedAt 同样久远时仍按 stale 判定', () => {
    const sessions = [
      makeSession({
        id: 's-filemtime-old',
        lastSeenAt: NOW - 10 * 60_000, // 10 分钟前
        fileModifiedAt: NOW - 3 * HOUR_MS, // 3 小时前（优先用此）
      }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0]!.lastSeenAt).toBe(NOW - 3 * HOUR_MS);
  });

  it('无 lastMessage 且 requireAssistantEnding=true（默认）时不卡住（即便 stale）', () => {
    const sessions = [
      makeSession({
        id: 's-no-msg',
        lastSeenAt: NOW - 3 * HOUR_MS,
        lastMessage: null,
      }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW });
    // assistant_ending 不命中 → AND 不成立
    expect(results).toEqual([]);
  });

  it('无 lastMessage + requireAssistantEnding=false 时 stale 即卡住，lastMessage=null', () => {
    const sessions = [
      makeSession({
        id: 's-no-msg-2',
        lastSeenAt: NOW - 3 * HOUR_MS,
        lastMessage: null,
      }),
    ];
    const results = detectStuckSessions(sessions, {
      now: NOW,
      requireAssistantEnding: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.lastMessage).toBeNull();
    expect(results[0]!.reasons).toEqual(['stale']);
  });

  it('contentPreview 截断到前 100 字符', () => {
    const longContent = 'x'.repeat(250);
    const sessions = [
      makeSession({
        id: 's-long',
        lastSeenAt: NOW - 3 * HOUR_MS,
        lastMessage: { role: 'assistant', content: longContent },
      }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0]!.lastMessage?.contentPreview).toHaveLength(100);
    expect(results[0]!.lastMessage?.contentPreview).toBe('x'.repeat(100));
  });

  it('保留输入顺序', () => {
    const sessions = [
      makeSession({ id: 's-1', lastSeenAt: NOW - 5 * HOUR_MS }),
      makeSession({ id: 's-active', lastSeenAt: NOW - 1 * 60_000 }), // 不卡
      makeSession({ id: 's-2', lastSeenAt: NOW - 4 * HOUR_MS }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW });
    expect(results.map((r) => r.sessionId)).toEqual(['s-1', 's-2']);
  });

  it('空输入返回空数组', () => {
    expect(detectStuckSessions([], { now: NOW })).toEqual([]);
  });

  it('默认 staleHours = DEFAULT_STUCK_STALE_HOURS（2 小时）', () => {
    // 1.99 小时前不算，2.0 小时前算（覆盖默认值路径）
    const justUnder = [
      makeSession({ id: 's-under', lastSeenAt: NOW - (2 * HOUR_MS - 1) }),
    ];
    expect(detectStuckSessions(justUnder, { now: NOW })).toEqual([]);

    const justOver = [
      makeSession({ id: 's-over', lastSeenAt: NOW - 2 * HOUR_MS }),
    ];
    expect(detectStuckSessions(justOver, { now: NOW })).toHaveLength(1);
  });

  it('纯函数：不修改输入数组与输入对象', () => {
    const s = makeSession({ id: 's-pure', lastSeenAt: NOW - 3 * HOUR_MS });
    const sessions = [s];
    const snapshot = JSON.parse(JSON.stringify(sessions));
    detectStuckSessions(sessions, { now: NOW });
    expect(JSON.parse(JSON.stringify(sessions))).toEqual(snapshot);
    // 引用未变
    expect(sessions[0]).toBe(s);
  });

  it('hoursSinceUpdate 保留 2 位小数（无浮点噪音）', () => {
    const sessions = [
      makeSession({ id: 's-frac', lastSeenAt: NOW - 90 * 60_000 }), // 1.5h
    ];
    const results = detectStuckSessions(sessions, {
      now: NOW,
      staleHours: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.hoursSinceUpdate).toBe(1.5);
  });

  it('tool 结尾的消息不算 assistant_ending', () => {
    const sessions = [
      makeSession({
        id: 's-tool-end',
        lastSeenAt: NOW - 3 * HOUR_MS,
        lastMessage: { role: 'tool', content: 'result' },
      }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW });
    expect(results).toEqual([]);
  });

  it('保留 source / cwd / projectPath 字段', () => {
    const sessions = [
      makeSession({
        id: 's-fields',
        source: 'claude',
        cwd: '/repo',
        projectPath: '/repo',
        lastSeenAt: NOW - 3 * HOUR_MS,
      }),
    ];
    const results = detectStuckSessions(sessions, { now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe('claude');
    expect(results[0]!.cwd).toBe('/repo');
    expect(results[0]!.projectPath).toBe('/repo');
  });
});
