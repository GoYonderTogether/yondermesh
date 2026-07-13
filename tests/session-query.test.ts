/**
 * LOOP-005 多维切分与关系查询 契约测试（RED 优先）
 *
 * 覆盖验收门：
 *   1. 时间区间：startedAtFrom / startedAtTo 闭区间（含端点），单边可单独使用
 *   2. source / topology 过滤（root / subagent 区分）
 *   3. cwd / projectPath 精确值过滤
 *   4. 目录边界前缀：cwdPrefix / projectPrefix —— exact prefix 或 prefix + '/'
 *      （/foo 不得匹配 /foobar）
 *   5. LIKE 特殊字符安全：前缀含 _ % \ 时不被当作通配符
 *   6. 统计一致：getSessionStats 与 querySessions 同过滤语义；零结果各为 0
 *   7. getSession(id)：存在返回记录，不存在返回 undefined
 *   8. limit 截断
 *
 * 设计原则：全部在 :memory: 上运行，每个 it 独立 seed，互不污染。
 * 注：store/各 importer 始终用 Date.now() 填充 started_at，NULL 不可经公开 API 达成，
 *     故时间区间测试在真实非空 started_at 上验证闭区间语义。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from '../src/store/index.js';
import type {
  SessionIngestInput,
  SessionQuery,
  SessionStats,
} from '../src/store/index.js';

const DEVICE = 'mac-001';
const DEVICE_OTHER = 'mac-002';

/** 构造一个全新的内存库 */
function freshStore(): SessionStore {
  return new SessionStore(':memory:');
}

/** 注册一个 claude-code 来源实例，返回其 id */
function claudeInstance(store: SessionStore): string {
  return store
    .registerSourceInstance({
      deviceId: DEVICE,
      source: 'claude-code',
      rootPath: '/Users/zoran/.claude/projects',
      coverage: 'A',
    })
    .id;
}

/** 注册一个 codex 来源实例，返回其 id */
function codexInstance(store: SessionStore): string {
  return store
    .registerSourceInstance({
      deviceId: DEVICE,
      source: 'codex',
      rootPath: '/Users/zoran/.codex/sessions',
      coverage: 'A',
    })
    .id;
}

/** 便捷入库一条 session */
function ingest(store: SessionStore, instId: string, opts: Partial<SessionIngestInput>): string {
  return store
    .ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: instId,
      nativeSessionId: opts.nativeSessionId!,
      source: opts.source ?? 'claude-code',
      cwd: opts.cwd,
      projectPath: opts.projectPath,
      startedAt: opts.startedAt,
      topology: opts.topology ?? 'root',
      messages: opts.messages ?? [{ role: 'user', content: 'hi' }],
    })
    .sessionId;
}

const U = (content: string) => ({ role: 'user' as const, content });
const A = (content: string) => ({ role: 'assistant' as const, content });

/** seed 8 条 session（全 DEVICE），返回 claude 实例 id；覆盖时间/来源/拓扑/特殊字符路径 */
function seed(store: SessionStore): { claude: string; ids: Record<string, string> } {
  const claude = claudeInstance(store);
  const codex = codexInstance(store);
  const ids: Record<string, string> = {};

  ids.s1 = ingest(store, claude, {
    nativeSessionId: 'time-1', cwd: '/repo', projectPath: '/repo', startedAt: 1_000,
    messages: [U('a'), A('b')],
  });
  ids.s2 = ingest(store, claude, {
    nativeSessionId: 'time-2', cwd: '/repo/sub', projectPath: '/repo', startedAt: 2_000,
    topology: 'subagent', messages: [U('a'), A('b'), U('c')],
  });
  ids.s3 = ingest(store, codex, {
    nativeSessionId: 'time-3', source: 'codex', cwd: '/foobar', projectPath: '/foobar',
    startedAt: 3_000, messages: [U('a')],
  });
  ids.s4 = ingest(store, claude, {
    nativeSessionId: 'spec-1', cwd: '/data/my_proj/sub', projectPath: '/data/my_proj/sub',
    startedAt: 4_000, messages: [U('a')],
  });
  ids.s5 = ingest(store, claude, {
    nativeSessionId: 'spec-2', cwd: '/data/myXproj/sub', projectPath: '/data/myXproj/sub',
    startedAt: 5_000, messages: [U('a')],
  });
  ids.s6 = ingest(store, claude, {
    nativeSessionId: 'spec-3', cwd: '/data/50%off/sub', projectPath: '/data/50%off/sub',
    startedAt: 6_000, messages: [U('a')],
  });
  ids.s7 = ingest(store, claude, {
    nativeSessionId: 'spec-4', cwd: '/data/50Xoff/sub', projectPath: '/data/50Xoff/sub',
    startedAt: 7_000, messages: [U('a')],
  });
  // cwd 含字面反斜杠（JS 字面 '/data/a\\b/sub' = /data/a\b/sub）
  ids.s8 = ingest(store, claude, {
    nativeSessionId: 'spec-5', cwd: '/data/a\\b/sub', projectPath: '/data/a\\b/sub',
    startedAt: 8_000, messages: [U('a')],
  });

  return { claude, ids };
}

describe('LOOP-005 验收门 1：时间区间（闭区间）', () => {
  let store: SessionStore;
  let ids: Record<string, string>;
  beforeEach(() => {
    store = freshStore();
    ids = seed(store).ids;
  });

  it('startedAtFrom + startedAtTo 闭区间：仅命中区间内', () => {
    const r = store.querySessions({ startedAtFrom: 1_500, startedAtTo: 2_500 });
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(ids.s2);
  });

  it('端点 inclusive：from === to === 某条 startedAt → 命中该条', () => {
    const r = store.querySessions({ startedAtFrom: 2_000, startedAtTo: 2_000 });
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(ids.s2);
  });

  it('仅 startedAtFrom（下界 inclusive）：排除更早的', () => {
    const r = store.querySessions({ startedAtFrom: 2_001 });
    expect(r).toHaveLength(6); // s3..s8（3000..8000）
  });

  it('仅 startedAtTo（上界 inclusive）：排除更晚的', () => {
    const r = store.querySessions({ startedAtTo: 2_000 });
    expect(r).toHaveLength(2); // s1(1000), s2(2000)
  });
});

describe('LOOP-005 验收门 2：source / topology 过滤', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = freshStore();
    seed(store);
  });

  it('按 source 过滤', () => {
    expect(store.querySessions({ source: 'codex' })).toHaveLength(1);
    expect(store.querySessions({ source: 'claude-code' })).toHaveLength(7);
  });

  it('按 topology 过滤（root / subagent 区分）', () => {
    expect(store.querySessions({ topology: 'subagent' })).toHaveLength(1);
    expect(store.querySessions({ topology: 'root' })).toHaveLength(7);
  });

  it('source + topology 组合', () => {
    const r = store.querySessions({ source: 'claude-code', topology: 'root' });
    expect(r).toHaveLength(6); // s1,s4,s5,s6,s7,s8
  });
});

describe('LOOP-005 验收门 3：cwd / projectPath 精确值', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = freshStore();
    seed(store);
  });

  it('cwd 精确：/repo 仅命中 s1（不含 /repo/sub）', () => {
    const r = store.querySessions({ cwd: '/repo' });
    expect(r).toHaveLength(1);
  });

  it('cwd 精确：/foobar 命中 s3', () => {
    expect(store.querySessions({ cwd: '/foobar' })).toHaveLength(1);
  });

  it('projectPath 精确：/repo 命中 s1 与 s2（两者 projectPath 均 /repo）', () => {
    expect(store.querySessions({ projectPath: '/repo' })).toHaveLength(2);
  });
});

describe('LOOP-005 验收门 4：目录边界前缀（/foo 不匹配 /foobar）', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = freshStore();
    seed(store);
  });

  it('cwdPrefix 命中 prefix 本身与 prefix/ 子树', () => {
    const r = store.querySessions({ cwdPrefix: '/repo' });
    expect(r).toHaveLength(2); // s1 /repo, s2 /repo/sub
  });

  it('cwdPrefix /foo 不得匹配 /foobar（路径边界）', () => {
    expect(store.querySessions({ cwdPrefix: '/foo' })).toHaveLength(0);
  });

  it('cwdPrefix 尾部斜杠被规范化（等价无尾斜杠）', () => {
    expect(store.querySessions({ cwdPrefix: '/repo/' })).toHaveLength(2);
  });

  it('projectPrefix 命中 prefix 本身与子树', () => {
    // projectPath /repo（s1,s2 精确）+ 无 /repo/ 子树 → 2
    expect(store.querySessions({ projectPrefix: '/repo' })).toHaveLength(2);
    // projectPath /data/... → s4..s8
    expect(store.querySessions({ projectPrefix: '/data' })).toHaveLength(5);
  });

  it('projectPrefix /data/my_proj 不匹配 /data/myXproj（边界）', () => {
    expect(store.querySessions({ projectPrefix: '/data/my_proj' })).toHaveLength(1);
  });
});

describe('LOOP-005 验收门 5：LIKE 特殊字符安全（_ % \\）', () => {
  let store: SessionStore;
  let ids: Record<string, string>;
  beforeEach(() => {
    store = freshStore();
    ids = seed(store).ids;
  });

  it('下划线 _ 不被当作单字符通配：/data/my_proj 仅命中 s4，不命中 s5(myXproj)', () => {
    const r = store.querySessions({ cwdPrefix: '/data/my_proj' });
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(ids.s4);
  });

  it('百分号 % 不被当作通配：/data/50%off 仅命中 s6，不命中 s7(50Xoff)', () => {
    const r = store.querySessions({ cwdPrefix: '/data/50%off' });
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(ids.s6);
  });

  it('反斜杠 \\ 被转义为字面量：/data/a\\b 仅命中 s8', () => {
    // JS 字面 '/data/a\\b' = /data/a\b
    const r = store.querySessions({ cwdPrefix: '/data/a\\b' });
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(ids.s8);
  });

  it('反斜杠路径边界：/data/a 不匹配 /data/a\\b/sub（\\ 非边界 /）', () => {
    expect(store.querySessions({ cwdPrefix: '/data/a' })).toHaveLength(0);
  });
});

describe('LOOP-005 验收门 6：getSessionStats 一致性与零结果', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = freshStore();
    seed(store);
  });

  it('无过滤：total=8 root=7 subagent=1 messages=11', () => {
    const st: SessionStats = store.getSessionStats({});
    expect(st.totalSessions).toBe(8);
    expect(st.rootSessions).toBe(7);
    expect(st.subagentSessions).toBe(1);
    expect(st.totalMessages).toBe(11);
  });

  it('source=claude-code：total=7 root=6 subagent=1 messages=10', () => {
    const st = store.getSessionStats({ source: 'claude-code' });
    expect(st).toEqual({ totalSessions: 7, rootSessions: 6, subagentSessions: 1, totalMessages: 10 });
  });

  it('topology=subagent：total=1 root=0 subagent=1 messages=3', () => {
    const st = store.getSessionStats({ topology: 'subagent' });
    expect(st).toEqual({ totalSessions: 1, rootSessions: 0, subagentSessions: 1, totalMessages: 3 });
  });

  it('零结果：各计数为 0', () => {
    const st = store.getSessionStats({ deviceId: 'nope' });
    expect(st).toEqual({ totalSessions: 0, rootSessions: 0, subagentSessions: 0, totalMessages: 0 });
  });

  it('统计与列表同过滤语义一致（多组 query）', () => {
    const queries: SessionQuery[] = [
      {},
      { source: 'claude-code' },
      { topology: 'root' },
      { cwdPrefix: '/data' },
      { startedAtFrom: 2_001 },
      { projectPath: '/repo' },
    ];
    for (const q of queries) {
      const st = store.getSessionStats(q);
      const list = store.querySessions(q);
      expect(st.totalSessions, JSON.stringify(q)).toBe(list.length);
      expect(st.totalMessages, JSON.stringify(q)).toBe(
        list.reduce((n, s) => n + s.messageCount, 0),
      );
    }
  });
});

describe('LOOP-005 验收门 7：getSession(id)', () => {
  let store: SessionStore;
  let ids: Record<string, string>;
  beforeEach(() => {
    store = freshStore();
    ids = seed(store).ids;
  });

  it('存在 → 返回该 session 记录', () => {
    const s = store.getSession(ids.s1);
    expect(s).toBeDefined();
    expect(s!.id).toBe(ids.s1);
    expect(s!.nativeSessionId).toBe('time-1');
    expect(s!.cwd).toBe('/repo');
    expect(s!.projectPath).toBe('/repo');
  });

  it('不存在 → undefined', () => {
    expect(store.getSession('nonexistent-id')).toBeUndefined();
  });
});

describe('LOOP-005 验收门 8：limit 截断', () => {
  it('limit 截断结果数量', () => {
    const store = freshStore();
    seed(store);
    expect(store.querySessions({ limit: 3 })).toHaveLength(3);
    expect(store.querySessions({ limit: 100 })).toHaveLength(8);
  });
});

describe('LOOP-005 验收门 9：deviceId 过滤', () => {
  it('按 deviceId 区分设备', () => {
    const store = freshStore();
    seed(store); // 8 条全在 DEVICE
    // 额外入库一条 DEVICE_OTHER 上的 session
    const otherInst = store.registerSourceInstance({
      deviceId: DEVICE_OTHER,
      source: 'claude-code',
      rootPath: '/x',
      coverage: 'A',
    });
    store.ingestSession({
      deviceId: DEVICE_OTHER,
      sourceInstanceId: otherInst.id,
      nativeSessionId: 'other-1',
      source: 'claude-code',
      cwd: '/other',
      messages: [U('a')],
    });

    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(8);
    expect(store.querySessions({ deviceId: DEVICE_OTHER })).toHaveLength(1);
  });
});
