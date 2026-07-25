/**
 * LOOP build-check-prior-attempts 测试
 *
 * 验收门（loop §4）：
 *   1. 多个 session 含相同报错 → 返回历史尝试 + 结论
 *   2. 无历史时返回空数组而非崩
 *   3. 命中按相关性排序
 *   4. 同项目加权
 *   5. limit 截断
 *   6. minScore 阈值过滤
 *   7. 纯函数零副作用
 *   8. 边界：空 query / 空消息 / 仅 project 命中（无文本信号）不硬凑
 */

import { describe, it, expect } from 'vitest';
import {
  findPriorAttempts,
  DEFAULT_PRIOR_ATTEMPTS_LIMIT,
  DEFAULT_PRIOR_ATTEMPTS_MIN_SCORE,
} from '../src/derive/prior-attempts.js';
import type {
  PriorAttemptSession,
  PriorAttemptQuery,
} from '../src/derive/prior-attempts.js';

/** 构造 session */
function makeSession(over: Partial<PriorAttemptSession> & { id: string }): PriorAttemptSession {
  return {
    source: 'claude',
    cwd: '/repo',
    projectPath: '/repo',
    lastSeenAt: 0,
    messages: [],
    ...over,
  };
}

describe('build-check-prior-attempts: findPriorAttempts', () => {
  it('默认常量正确', () => {
    expect(DEFAULT_PRIOR_ATTEMPTS_LIMIT).toBe(5);
    expect(DEFAULT_PRIOR_ATTEMPTS_MIN_SCORE).toBe(0.1);
  });

  it('空 query 返回空数组（不崩）', () => {
    const sessions = [
      makeSession({
        id: 's-1',
        messages: [{ role: 'assistant', content: 'TypeError: x is not a function' }],
      }),
    ];
    expect(findPriorAttempts({ query: '' }, sessions)).toEqual([]);
    expect(findPriorAttempts({ query: '   ' }, sessions)).toEqual([]);
  });

  it('空 sessions 返回空数组（不崩）', () => {
    expect(findPriorAttempts({ query: 'TypeError' }, [])).toEqual([]);
  });

  it('无消息的 session 被跳过（不崩）', () => {
    const sessions = [makeSession({ id: 's-empty', messages: [] })];
    expect(findPriorAttempts({ query: 'TypeError' }, sessions)).toEqual([]);
  });

  it('多个 session 含相同报错 → 都被返回，按相关性排序', () => {
    const sessions = [
      makeSession({
        id: 's-strong',
        messages: [
          { role: 'user', content: '我跑这段代码报错' },
          { role: 'assistant', content: 'TypeError: x is not a function at foo (a.js:1:2)' },
        ],
      }),
      makeSession({
        id: 's-weak',
        messages: [
          { role: 'user', content: '帮忙看下' },
          { role: 'assistant', content: '另一个不相关的 task' },
        ],
      }),
      makeSession({
        id: 's-strong-2',
        messages: [
          { role: 'assistant', content: '之前遇到的 TypeError: x is not a function' },
        ],
      }),
    ];

    const results = findPriorAttempts({ query: 'TypeError: x is not a function' }, sessions);

    expect(results.length).toBeGreaterThanOrEqual(2);
    // s-strong 和 s-strong-2 都该命中 failure_pattern
    const ids = results.map((r) => r.sessionId);
    expect(ids).toContain('s-strong');
    expect(ids).toContain('s-strong-2');
    expect(ids).not.toContain('s-weak');
    // 排序：分数降序
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
    // 命中原因含 failure_pattern
    for (const r of results) {
      if (ids.includes(r.sessionId) && r.sessionId !== 's-weak') {
        expect(r.reasons).toContain('failure_pattern');
      }
    }
  });

  it('命中结果包含 conclusion（最后一条 assistant 消息预览）', () => {
    const sessions = [
      makeSession({
        id: 's-conclusion',
        messages: [
          { role: 'user', content: '遇到 TypeError 问题' },
          { role: 'assistant', content: 'TypeError: x is not a function' },
          { role: 'assistant', content: '已修复：把 x 改成函数调用' },
        ],
      }),
    ];
    const results = findPriorAttempts({ query: 'TypeError: x is not a function' }, sessions);
    expect(results).toHaveLength(1);
    expect(results[0]!.conclusion).toBe('已修复：把 x 改成函数调用');
    expect(results[0]!.matchedMessageIndex).toBeGreaterThanOrEqual(0);
    expect(results[0]!.messageCount).toBe(3);
  });

  it('无 assistant 消息时 conclusion 为 null', () => {
    const sessions = [
      makeSession({
        id: 's-no-assistant',
        messages: [
          { role: 'user', content: 'TypeError: x is not a function' },
          { role: 'tool', content: 'TypeError: x is not a function' },
        ],
      }),
    ];
    const results = findPriorAttempts({ query: 'TypeError: x is not a function' }, sessions);
    expect(results).toHaveLength(1);
    expect(results[0]!.conclusion).toBeNull();
  });

  it('同 projectPath 命中加权（同分基础上升序在前）', () => {
    // 两个 session 文本命中强度相同，但一个同项目一个不同项目
    const sessions = [
      makeSession({
        id: 's-diff-project',
        projectPath: '/other-repo',
        cwd: '/other-repo',
        messages: [
          { role: 'assistant', content: '遇到 TypeError: x is not a function' },
        ],
      }),
      makeSession({
        id: 's-same-project',
        projectPath: '/repo',
        cwd: '/repo',
        messages: [
          { role: 'assistant', content: '遇到 TypeError: x is not a function' },
        ],
      }),
    ];
    const results = findPriorAttempts(
      { query: 'TypeError: x is not a function', projectPath: '/repo', cwd: '/repo' },
      sessions,
    );
    expect(results).toHaveLength(2);
    // 同项目那个分数应该更高，排在前面
    expect(results[0]!.sessionId).toBe('s-same-project');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    expect(results[0]!.reasons).toContain('same_project');
    expect(results[0]!.reasons).toContain('same_cwd');
    expect(results[1]!.reasons).not.toContain('same_project');
  });

  it('仅 projectPath 命中（无文本信号）不硬凑返回', () => {
    // session 文本与 query 无任何重叠，仅 projectPath 相同
    const sessions = [
      makeSession({
        id: 's-unrelated',
        projectPath: '/repo',
        cwd: '/repo',
        messages: [
          { role: 'assistant', content: '今天天气不错，聊聊怎么做饭' },
        ],
      }),
    ];
    const results = findPriorAttempts(
      { query: 'TypeError: x is not a function', projectPath: '/repo', cwd: '/repo' },
      sessions,
    );
    // 文本不命中 → 不应返回（即便同项目）
    expect(results).toEqual([]);
  });

  it('limit 截断结果', () => {
    const sessions: PriorAttemptSession[] = [];
    for (let i = 0; i < 10; i++) {
      sessions.push(
        makeSession({
          id: `s-${i}`,
          messages: [
            { role: 'assistant', content: `TypeError: x is not a function (case ${i})` },
          ],
        }),
      );
    }
    const results = findPriorAttempts(
      { query: 'TypeError: x is not a function', limit: 3 },
      sessions,
    );
    expect(results).toHaveLength(3);
  });

  it('minScore 阈值过滤掉低分命中', () => {
    // 一个强命中 + 一个仅 token_overlap 弱命中
    const sessions = [
      makeSession({
        id: 's-strong',
        messages: [
          { role: 'assistant', content: 'TypeError: x is not a function' },
        ],
      }),
      makeSession({
        id: 's-weak-token',
        messages: [
          {
            role: 'user',
            content: 'the function is not working properly with type checks',
          },
        ],
      }),
    ];
    // 设很高的 minScore，弱命中应被过滤
    const results = findPriorAttempts(
      { query: 'TypeError: x is not a function', minScore: 0.5 },
      sessions,
    );
    // s-strong 命中 failure_pattern，归一化后应高于 0.5
    expect(results.some((r) => r.sessionId === 's-strong')).toBe(true);
    // s-weak-token 仅 token_overlap，分数应低于 0.5
    expect(results.some((r) => r.sessionId === 's-weak-token')).toBe(false);
  });

  it('matchedSnippet 截断到 SNIPPET_LENGTH', () => {
    const longContent = 'TypeError: x is not a function. ' + 'x'.repeat(500);
    const sessions = [
      makeSession({
        id: 's-long',
        messages: [{ role: 'assistant', content: longContent }],
      }),
    ];
    const results = findPriorAttempts(
      { query: 'TypeError: x is not a function' },
      sessions,
    );
    expect(results).toHaveLength(1);
    // 截断到 200 字符（SNIPPET_LENGTH）
    expect(results[0]!.matchedSnippet.length).toBeLessThanOrEqual(200);
  });

  it('稳定性：同分按 sessionId 升序', () => {
    // 两个文本完全相同的 session，分数相同
    const sessions = [
      makeSession({
        id: 's-b',
        messages: [
          { role: 'assistant', content: 'TypeError: x is not a function' },
        ],
      }),
      makeSession({
        id: 's-a',
        messages: [
          { role: 'assistant', content: 'TypeError: x is not a function' },
        ],
      }),
    ];
    const results = findPriorAttempts(
      { query: 'TypeError: x is not a function' },
      sessions,
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.sessionId).toBe('s-a');
    expect(results[1]!.sessionId).toBe('s-b');
    expect(results[0]!.score).toBe(results[1]!.score);
  });

  it('纯函数：不修改输入数组与输入对象', () => {
    const session = makeSession({
      id: 's-pure',
      messages: [{ role: 'assistant', content: 'TypeError: x is not a function' }],
    });
    const sessions = [session];
    const snapshot = JSON.parse(JSON.stringify(sessions));
    findPriorAttempts({ query: 'TypeError' }, sessions);
    expect(JSON.parse(JSON.stringify(sessions))).toEqual(snapshot);
    expect(sessions[0]).toBe(session);
    expect(session.messages[0]).toBe(session.messages[0]);
  });

  it('Exit code 风格的失败也能命中', () => {
    const sessions = [
      makeSession({
        id: 's-exit',
        messages: [
          { role: 'assistant', content: 'command exited with code 1' },
        ],
      }),
    ];
    const results = findPriorAttempts(
      { query: 'command exited with code 1' },
      sessions,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.reasons).toContain('failure_pattern');
  });

  it('默认 limit = DEFAULT_PRIOR_ATTEMPTS_LIMIT（5）', () => {
    const sessions: PriorAttemptSession[] = [];
    for (let i = 0; i < 8; i++) {
      sessions.push(
        makeSession({
          id: `s-${i}`,
          messages: [
            { role: 'assistant', content: `TypeError: x is not a function (${i})` },
          ],
        }),
      );
    }
    const results = findPriorAttempts(
      { query: 'TypeError: x is not a function' },
      sessions,
    );
    expect(results).toHaveLength(5);
  });

  it('默认 minScore = DEFAULT_PRIOR_ATTEMPTS_MIN_SCORE（0.1）', () => {
    // 强命中应通过默认阈值
    const sessions = [
      makeSession({
        id: 's-default',
        messages: [
          { role: 'assistant', content: 'TypeError: x is not a function' },
        ],
      }),
    ];
    const results = findPriorAttempts(
      { query: 'TypeError: x is not a function' },
      sessions,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeGreaterThanOrEqual(0.1);
  });

  it('query 中的报错文本与 message 中报错完全一致 → 强命中', () => {
    const errText = 'ReferenceError: yonder is not defined';
    const sessions = [
      makeSession({
        id: 's-exact',
        messages: [
          { role: 'user', content: 'help me debug' },
          { role: 'assistant', content: `I got: ${errText}` },
          { role: 'assistant', content: 'fixed by declaring yonder first' },
        ],
      }),
    ];
    const results = findPriorAttempts({ query: errText }, sessions);
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe('s-exact');
    expect(results[0]!.reasons).toContain('failure_pattern');
    expect(results[0]!.conclusion).toBe('fixed by declaring yonder first');
  });
});
