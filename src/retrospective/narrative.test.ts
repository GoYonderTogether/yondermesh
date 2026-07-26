/**
 * narrative.test.ts — markdown 骨架渲染测试
 *
 * 验收门（loop build-retrospective §C）：
 *   C1. 输入 RetrospectiveFact，输出 markdown 字符串
 *   C2. 5 段标题齐全：背景 / 工具调用路径 / 弯路 / 用户故事 / 抽象能力建议
 *   C3. 用户故事段含 <FILL: ...> 槽位
 */

import { describe, it, expect } from 'vitest';
import { renderNarrative, NARRATIVE_SECTIONS } from './narrative.js';
import type { RetrospectiveFact } from './generator.js';

function mkFact(overrides: Partial<RetrospectiveFact> = {}): RetrospectiveFact {
  return {
    sessionId: '019f5fe4-b127-7de2-b8f1-efa45bee24cb',
    originalNeed: '帮我修复登录 bug',
    toolCalls: [
      { seq: 2, name: 'Read' },
      { seq: 4, name: 'Bash' },
    ],
    toolCallCount: 2,
    detours: [
      {
        seq: 5,
        snippet: 'Error: Cannot find module foo',
        pattern: '/(?:Error|Fatal|Panic)/i',
      },
    ],
    stuckSegments: [],
    sessionMeta: {
      source: 'claude-code',
      cwd: '/repo/test',
      projectPath: '/repo/test',
      startedAt: 1_000_000,
      lastSeenAt: 1_060_000,
      messageCount: 6,
    },
    firstUserMessageAt: 1_000_000,
    durationSec: 60,
    ...overrides,
  };
}

describe('renderNarrative — C1/C2/C3', () => {
  it('C1: 输出是字符串', () => {
    const md = renderNarrative(mkFact());
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(0);
  });

  it('C2: 含全部 5 段标题（按顺序）', () => {
    const md = renderNarrative(mkFact());
    for (const title of NARRATIVE_SECTIONS) {
      expect(md).toContain(title);
    }
    // 顺序检查
    const idx0 = md.indexOf(NARRATIVE_SECTIONS[0]);
    const idx1 = md.indexOf(NARRATIVE_SECTIONS[1]);
    const idx2 = md.indexOf(NARRATIVE_SECTIONS[2]);
    const idx3 = md.indexOf(NARRATIVE_SECTIONS[3]);
    const idx4 = md.indexOf(NARRATIVE_SECTIONS[4]);
    expect(idx0).toBeGreaterThan(-1);
    expect(idx1).toBeGreaterThan(idx0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
    expect(idx4).toBeGreaterThan(idx3);
  });

  it('C2: 标题精确为 5 段（不多不少）', () => {
    const md = renderNarrative(mkFact());
    // 标题数（## 开头行）应至少 5
    const headings = md.match(/^## /gm) ?? [];
    expect(headings.length).toBeGreaterThanOrEqual(5);
  });

  it('C3: 用户故事段含 <FILL: ...> 槽位', () => {
    const md = renderNarrative(mkFact());
    expect(md).toContain('<FILL:');
    // 用户故事段后的 FILL 至少 2 条
    const fillMatches = md.match(/<FILL:[^>]*>/g) ?? [];
    expect(fillMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('背景段含 originalNeed + sessionMeta', () => {
    const md = renderNarrative(mkFact());
    expect(md).toContain('帮我修复登录 bug');
    expect(md).toContain('claude-code');
    expect(md).toContain('/repo/test');
    expect(md).toContain('019f5fe4-b127-7de2-b8f1-efa45bee24cb');
  });

  it('工具调用段列出工具名 + 总数', () => {
    const md = renderNarrative(mkFact());
    expect(md).toContain('总调用次数: **2**');
    expect(md).toContain('`Read`');
    expect(md).toContain('`Bash`');
  });

  it('弯路段：有 detour 时列出 snippet + pattern', () => {
    const md = renderNarrative(mkFact());
    expect(md).toContain('Error: Cannot find module foo');
    expect(md).toContain('seq 5');
  });

  it('弯路段：无 detour 时打印 "(无明确弯路)"', () => {
    const md = renderNarrative(mkFact({ detours: [] }));
    expect(md).toContain('(无明确弯路)');
  });

  it('空 originalNeed 时不崩', () => {
    const md = renderNarrative(mkFact({ originalNeed: '' }));
    expect(md).toContain('(无首条 user 消息)');
  });

  it('工具调用超 20 条时折叠为 "其余 N 次"', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      seq: i + 1,
      name: `Tool${i}`,
    }));
    const md = renderNarrative(
      mkFact({ toolCalls: many, toolCallCount: 25 }),
    );
    expect(md).toContain('其余 5 次');
    expect(md).toContain('`Tool0`');
    expect(md).toContain('`Tool19`');
    expect(md).not.toContain('`Tool20`');
  });

  it('纯函数：相同输入相同输出', () => {
    const fact = mkFact();
    const a = renderNarrative(fact);
    const b = renderNarrative(fact);
    expect(a).toBe(b);
  });
});
