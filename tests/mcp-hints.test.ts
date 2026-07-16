/**
 * MCP 工具返回指引 (tool-hints) TDD 测试
 *
 * 验收门：
 *   1. buildActiveSessionHints：空数据不产生 hint
 *   2. buildActiveSessionHints：有等待审阅 session -> review hint
 *   3. buildActiveSessionHints：有 live session -> action hint
 *   4. buildActiveSessionHints：有 idle session -> action hint
 *   5. buildActiveSessionHints：有 stopped session -> info hint
 *   6. buildActiveSessionHints：有 stale session -> info hint
 *   7. buildActiveSessionHints：多种状态混合 -> 全部对应 hint
 *   8. formatHintsAsText：空列表返回空字符串
 *   9. formatHintsAsText：非空列表包含优先级标签
 *  10. MCP whoIsWaiting：无 session 时返回"没有等待"
 *  11. MCP whoIsWaiting：有等待 session 时返回 [REVIEW] 标记和 hint
 *  12. MCP listActiveSessions：返回 JSON 含 _hints 字段
 *  13. MCP whoIsWorking：返回文本含"下一步建议"
 *  14. MCP listTools：包含 who_is_waiting 工具
 */

import { describe, it, expect } from 'vitest';
import {
  buildActiveSessionHints,
  formatHintsAsText,
} from '../src/mcp/tool-hints.js';
import type { ActiveSummary, AwaitingReviewSession } from '../src/store/types.js';
import { SessionStore } from '../src/store/index.js';
import { McpServer } from '../src/mcp/server.js';

// ─── 工厂函数 ────────────────────────────────────────────────────────────

function emptySummary(overrides: Partial<ActiveSummary> = {}): ActiveSummary {
  return {
    totalActive: 0,
    liveCount: 0,
    idleCount: 0,
    staleCount: 0,
    stoppedCount: 0,
    subagentActive: 0,
    rootActive: 0,
    bySource: {},
    sessions: [],
    ...overrides,
  };
}

function makeAwaitingReview(overrides: Partial<AwaitingReviewSession> = {}): AwaitingReviewSession {
  return {
    sessionId: 'sess-test-001',
    nativeSessionId: 'native-001',
    source: 'codex',
    cwd: '/projects/test',
    projectPath: '/projects/test',
    topology: 'root',
    messageCount: 10,
    fileModifiedAt: Date.now() - 5000,
    lastRole: 'assistant',
    lastMessagePreview: 'I have completed the task. Please review.',
    ...overrides,
  };
}

/**
 * 构造一个带近期活跃 session（含 fileModifiedAt）的内存 store。
 * 用于 MCP 工具集成测试。
 */
function seededActiveStore(): SessionStore {
  const store = new SessionStore(':memory:');

  const inst = store.registerSourceInstance({
    deviceId: 'test-device',
    source: 'codex',
    rootPath: '/fake/.codex',
    coverage: 'A',
  });

  const now = Date.now();

  // 一个等待审阅的 root session（最后一条是 assistant + 近期 mtime）
  store.ingestSession({
    deviceId: 'test-device',
    sourceInstanceId: inst.id,
    nativeSessionId: 'sess-awaiting-1',
    source: 'codex',
    cwd: '/projects/alpha',
    projectPath: '/projects/alpha',
    startedAt: now - 600_000,
    topology: 'root',
    fileModifiedAt: now - 5000,
    messages: [
      { role: 'user', content: 'fix the bug', timestamp: now - 600_000 },
      { role: 'assistant', content: 'Done, please review the changes.', timestamp: now - 5000 },
    ],
  });

  // 另一个等待审阅的 root session
  store.ingestSession({
    deviceId: 'test-device',
    sourceInstanceId: inst.id,
    nativeSessionId: 'sess-awaiting-2',
    source: 'codex',
    cwd: '/projects/beta',
    projectPath: '/projects/beta',
    startedAt: now - 900_000,
    topology: 'root',
    fileModifiedAt: now - 60_000,
    messages: [
      { role: 'user', content: 'add tests', timestamp: now - 900_000 },
      { role: 'assistant', content: 'Tests added. Should I also update docs?', timestamp: now - 60_000 },
    ],
  });

  return store;
}

// ─── buildActiveSessionHints 单元测试 ────────────────────────────────────

describe('tool-hints: buildActiveSessionHints', () => {
  it('空数据不产生 hint', () => {
    const hints = buildActiveSessionHints(emptySummary(), []);
    expect(hints).toHaveLength(0);
  });

  it('有等待审阅 session -> review hint', () => {
    const summary = emptySummary();
    const awaiting = [makeAwaitingReview()];
    const hints = buildActiveSessionHints(summary, awaiting);
    const reviewHints = hints.filter((h) => h.priority === 'review');
    expect(reviewHints.length).toBeGreaterThanOrEqual(2);
    expect(reviewHints[0].text).toContain('等待用户审阅');
    expect(reviewHints[0].text).toContain('get_session_detail');
  });

  it('等待审阅 hint 包含 session 列表预览', () => {
    const summary = emptySummary();
    const awaiting = [
      makeAwaitingReview({ nativeSessionId: 'abc-123-def456', lastMessagePreview: 'task completed' }),
    ];
    const hints = buildActiveSessionHints(summary, awaiting);
    const listHint = hints.find((h) => h.text.includes('等待审阅的 session'));
    expect(listHint).toBeDefined();
    expect(listHint!.text).toContain('abc-123-def4');
    expect(listHint!.text).toContain('task completed');
  });

  it('有 live session -> action hint', () => {
    const summary = emptySummary({ liveCount: 2, totalActive: 2 });
    const hints = buildActiveSessionHints(summary, []);
    const actionHints = hints.filter((h) => h.priority === 'action');
    expect(actionHints.length).toBeGreaterThanOrEqual(1);
    expect(actionHints[0].text).toContain('正在运行中');
  });

  it('有 idle session -> action hint', () => {
    const summary = emptySummary({ idleCount: 3, totalActive: 3 });
    const hints = buildActiveSessionHints(summary, []);
    const actionHints = hints.filter((h) => h.priority === 'action' && h.text.includes('空闲'));
    expect(actionHints.length).toBeGreaterThanOrEqual(1);
    expect(actionHints[0].text).toContain('3');
  });

  it('有 stopped session -> info hint', () => {
    const summary = emptySummary({ stoppedCount: 1, totalActive: 1 });
    const hints = buildActiveSessionHints(summary, []);
    const infoHints = hints.filter((h) => h.priority === 'info' && h.text.includes('停止'));
    expect(infoHints.length).toBeGreaterThanOrEqual(1);
  });

  it('有 stale session -> info hint', () => {
    const summary = emptySummary({ staleCount: 5, totalActive: 5 });
    const hints = buildActiveSessionHints(summary, []);
    const infoHints = hints.filter((h) => h.priority === 'info' && h.text.includes('30 分钟'));
    expect(infoHints.length).toBeGreaterThanOrEqual(1);
  });

  it('多种状态混合 -> 全部对应 hint', () => {
    const summary = emptySummary({
      liveCount: 1,
      idleCount: 2,
      stoppedCount: 3,
      staleCount: 4,
      totalActive: 10,
    });
    const awaiting = [makeAwaitingReview()];
    const hints = buildActiveSessionHints(summary, awaiting);
    const priorities = new Set(hints.map((h) => h.priority));
    expect(priorities.has('review')).toBe(true);
    expect(priorities.has('action')).toBe(true);
    expect(priorities.has('info')).toBe(true);
    expect(hints.length).toBeGreaterThanOrEqual(6);
  });

  it('review hint 指引调用方主动向用户提议操作', () => {
    const summary = emptySummary();
    const awaiting = [makeAwaitingReview()];
    const hints = buildActiveSessionHints(summary, awaiting);
    const firstReview = hints.find((h) => h.priority === 'review');
    expect(firstReview).toBeDefined();
    expect(firstReview!.text).toContain('主动向用户');
    expect(firstReview!.text).toContain('提议');
  });
});

// ─── formatHintsAsText 单元测试 ──────────────────────────────────────────

describe('tool-hints: formatHintsAsText', () => {
  it('空列表返回空字符串', () => {
    expect(formatHintsAsText([])).toBe('');
  });

  it('非空列表包含优先级标签', () => {
    const hints = buildActiveSessionHints(
      emptySummary({ liveCount: 1, totalActive: 1 }),
      [makeAwaitingReview()],
    );
    const text = formatHintsAsText(hints);
    expect(text).toContain('--- 下一步建议 ---');
    expect(text).toContain('[!]'); // review
    expect(text).toContain('[>]'); // action
  });
});

// ─── MCP 工具集成测试 ────────────────────────────────────────────────────

describe('MCP whoIsWaiting 工具', () => {
  it('无等待 session 时返回提示', async () => {
    const mcp = new McpServer(new SessionStore(':memory:'));
    const result = await mcp.callTool('who_is_waiting', {});
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('没有等待');
  });

  it('有等待 session 时返回 [REVIEW] 标记和 hint', async () => {
    const mcp = new McpServer(seededActiveStore());
    const result = await mcp.callTool('who_is_waiting', {});
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('[REVIEW]');
    expect(result.content).toContain('下一步建议');
    expect(result.content).toContain('主动向用户');
  });

  it('返回的消息预览被截断到合理长度', async () => {
    const mcp = new McpServer(seededActiveStore());
    const result = await mcp.callTool('who_is_waiting', {});
    const reviewLines = result.content.split('\n').filter((l) => l.includes('"'));
    for (const line of reviewLines) {
      expect(line.length).toBeLessThan(120);
    }
  });
});

describe('MCP listActiveSessions 工具含 _hints', () => {
  it('JSON 返回包含 _hints 字段', async () => {
    const mcp = new McpServer(seededActiveStore());
    const result = await mcp.callTool('list_active_sessions', {});
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveProperty('_hints');
    expect(Array.isArray(parsed._hints)).toBe(true);
    expect(parsed._hints.length).toBeGreaterThan(0);
  });

  it('空 store 时 _hints 为空数组', async () => {
    const mcp = new McpServer(new SessionStore(':memory:'));
    const result = await mcp.callTool('list_active_sessions', {});
    const parsed = JSON.parse(result.content);
    expect(parsed._hints).toEqual([]);
  });
});

describe('MCP whoIsWorking 工具含下一步建议', () => {
  it('有活跃 session 时文本含"下一步建议"', async () => {
    const mcp = new McpServer(seededActiveStore());
    const result = await mcp.callTool('who_is_working', {});
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('下一步建议');
    expect(result.content).toContain('[!]'); // review hint
  });
});

describe('MCP listTools 包含 who_is_waiting', () => {
  it('listTools 返回 who_is_waiting', () => {
    const mcp = new McpServer(new SessionStore(':memory:'));
    const tools = mcp.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('who_is_waiting');
  });
});
