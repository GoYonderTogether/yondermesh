/**
 * LOOP-001 Session Store 契约测试
 *
 * 覆盖验收门：
 *   1. :memory: 构造 + 6 张表 schema
 *   2. 来源实例注册幂等
 *   3. 身份三元组（device_id + source_instance_id + native_session_id）+ 首次入库
 *   4. 内容幂等 + 内容变化生成新 revision
 *   5. 关系写入与查询（双向、幂等）
 *   6. scan_runs 记录 + 多维查询
 *
 * 设计原则：全部在 :memory: 上运行，互不污染。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from '../src/store/index.js';
import type {
  SourceInstanceInput,
  SessionIngestInput,
  RelationType,
} from '../src/store/index.js';

const DEVICE = 'mac-001';
const DEVICE_OTHER = 'mac-002';

/** 构造一个全新的内存库 */
function freshStore(): SessionStore {
  return new SessionStore(':memory:');
}

/** 注册一个 claude-code 原生来源实例（覆盖等级 A） */
function claudeInstance(store: SessionStore, deviceId = DEVICE) {
  return store.registerSourceInstance({
    deviceId,
    source: 'claude-code',
    rootPath: '/Users/zoran/.claude/projects',
    coverage: 'A',
  });
}

function codexInstance(store: SessionStore, deviceId = DEVICE) {
  return store.registerSourceInstance({
    deviceId,
    source: 'codex',
    rootPath: '/Users/zoran/.codex/sessions',
    coverage: 'A',
  });
}

function baseMessages() {
  return [
    { role: 'user' as const, content: 'hello', timestamp: 1_000 },
    { role: 'assistant' as const, content: 'hi there', timestamp: 2_000 },
  ];
}

describe('LOOP-001 验收门 1：schema 与 :memory: 构造', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('支持 :memory: 构造且不抛错', () => {
    expect(() => new SessionStore(':memory:')).not.toThrow();
  });

  it('初始化后 6 张必需表全部存在', () => {
    const tables = store.listTables();
    for (const t of [
      'source_instances',
      'sessions',
      'session_revisions',
      'messages',
      'session_relationships',
      'scan_runs',
    ]) {
      expect(tables, `缺少表 ${t}`).toContain(t);
    }
  });

  it('重复初始化幂等（schema IF NOT EXISTS）', () => {
    // 再调一次 ensureSchema 不应抛错
    expect(() => store.ensureSchema()).not.toThrow();
    expect(store.listTables()).toHaveLength(7);
  });
});

describe('LOOP-001 验收门 2：来源实例注册幂等', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('首次注册返回带稳定 id 的来源实例', () => {
    const inst = claudeInstance(store);
    expect(inst.id).toBeTruthy();
    expect(inst.deviceId).toBe(DEVICE);
    expect(inst.source).toBe('claude-code');
    expect(inst.coverage).toBe('A');
  });

  it('相同 device+source+rootPath 重复注册返回同一 id（幂等）', () => {
    const a = claudeInstance(store);
    const b = claudeInstance(store);
    expect(b.id).toBe(a.id);
  });

  it('不同 rootPath 或不同 device 视为不同实例', () => {
    const a = claudeInstance(store);
    const b = store.registerSourceInstance({
      deviceId: DEVICE,
      source: 'claude-code',
      rootPath: '/other/path',
      coverage: 'A',
    });
    const c = claudeInstance(store, DEVICE_OTHER);
    expect(b.id).not.toBe(a.id);
    expect(c.id).not.toBe(a.id);
  });
});

describe('LOOP-001 验收门 3：身份三元组与首次入库', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('首次 ingest 创建 session + revision 1 + 消息', () => {
    const inst = claudeInstance(store);
    const res = store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: 'sess-1',
      source: 'claude-code',
      cwd: '/repo',
      topology: 'root',
      messages: baseMessages(),
    });

    expect(res.created).toBe(true);
    expect(res.revisionNumber).toBe(1);
    expect(res.newRevision).toBe(true);
    expect(res.messageCount).toBe(2);

    const msgs = store.getMessages(res.sessionId);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi there'],
    ]);
  });

  it('身份 = device + source_instance + native_session（三元组区分）', () => {
    const claude = claudeInstance(store);
    const codex = codexInstance(store);

    // 相同 native id、相同 device、不同 source instance → 不同 session
    const a = store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: claude.id,
      nativeSessionId: 'shared-id',
      source: 'claude-code',
      messages: baseMessages(),
    });
    const b = store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: codex.id,
      nativeSessionId: 'shared-id',
      source: 'codex',
      messages: baseMessages(),
    });
    // 相同 native id、不同 device → 不同 session
    const claudeOnOther = claudeInstance(store, DEVICE_OTHER);
    const c = store.ingestSession({
      deviceId: DEVICE_OTHER,
      sourceInstanceId: claudeOnOther.id,
      nativeSessionId: 'shared-id',
      source: 'claude-code',
      messages: baseMessages(),
    });

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.sessionId).not.toBe(c.sessionId);
    expect(b.sessionId).not.toBe(c.sessionId);
    // 三者都应是首次创建
    expect(a.created && b.created && c.created).toBe(true);
  });
});

describe('LOOP-001 验收门 4：内容幂等与内容变化 revision', () => {
  let store: SessionStore;
  let inst: { id: string };
  let firstResult: { sessionId: string };

  beforeEach(() => {
    store = freshStore();
    inst = claudeInstance(store);
    firstResult = store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: 'sess-rev',
      source: 'claude-code',
      messages: baseMessages(),
    });
  });

  it('相同内容重复 ingest 幂等：不新增 revision', () => {
    const again = store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: 'sess-rev',
      source: 'claude-code',
      messages: baseMessages(),
    });

    expect(again.created).toBe(false);
    expect(again.newRevision).toBe(false);
    expect(again.revisionNumber).toBe(1);
    // 消息未被重复写入
    expect(store.getMessages(firstResult.sessionId)).toHaveLength(2);
  });

  it('内容变化（追加消息）生成新 revision，revision_number 递增', () => {
    const evolved = store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: 'sess-rev',
      source: 'claude-code',
      messages: [
        ...baseMessages(),
        { role: 'user', content: 'again', timestamp: 3_000 },
      ],
    });

    expect(evolved.created).toBe(false);
    expect(evolved.newRevision).toBe(true);
    expect(evolved.revisionNumber).toBe(2);
    expect(evolved.messageCount).toBe(3);

    // 当前 revision 反映最新内容
    expect(store.getMessages(firstResult.sessionId)).toHaveLength(3);
  });

  it('内容变化（仅改文本，条数不变）也触发新 revision —— hash 基于内容而非元数据', () => {
    // 第二次：内容文本不同，但消息条数仍为 2（次品 store 在此处会漏检）
    const changed = store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: 'sess-rev',
      source: 'claude-code',
      messages: [
        { role: 'user', content: 'hello', timestamp: 1_000 },
        { role: 'assistant', content: 'CHANGED ANSWER', timestamp: 2_000 },
      ],
    });

    expect(changed.newRevision).toBe(true);
    expect(changed.revisionNumber).toBe(2);

    const msgs = store.getMessages(firstResult.sessionId);
    expect(msgs[1]!.content).toBe('CHANGED ANSWER');
  });

  it('revision 历史可查，保留全部 revision 记录', () => {
    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: 'sess-rev',
      source: 'claude-code',
      messages: [
        ...baseMessages(),
        { role: 'user', content: 'more', timestamp: 3_000 },
      ],
    });

    const revs = store.getRevisions(firstResult.sessionId);
    expect(revs.map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(revs[0]!.contentHash).toBeTruthy();
    expect(revs[1]!.contentHash).not.toBe(revs[0]!.contentHash);
  });
});

describe('LOOP-001 验收门 5：关系写入与查询', () => {
  let store: SessionStore;
  let rootSession: string;
  let subSession: string;

  beforeEach(() => {
    store = freshStore();
    const inst = claudeInstance(store);
    rootSession = store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: 'root-1',
      source: 'claude-code',
      topology: 'root',
      messages: baseMessages(),
    }).sessionId;
    subSession = store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: 'sub-1',
      source: 'claude-code',
      topology: 'subagent',
      messages: [{ role: 'assistant', content: 'working', timestamp: 1 }],
    }).sessionId;
  });

  it('写入 spawned_by 关系并双向查询', () => {
    store.addRelationship({
      fromSessionId: subSession,
      toSessionId: rootSession,
      relationType: 'spawned_by',
      evidence: 'subagents/sub-1.jsonl',
    });

    const fromSub = store.queryRelationships(subSession);
    expect(fromSub).toContainEqual(
      expect.objectContaining({
        fromSessionId: subSession,
        toSessionId: rootSession,
        relationType: 'spawned_by',
        direction: 'outgoing',
      }),
    );

    const fromRoot = store.queryRelationships(rootSession);
    expect(fromRoot).toContainEqual(
      expect.objectContaining({
        fromSessionId: subSession,
        toSessionId: rootSession,
        relationType: 'spawned_by',
        direction: 'incoming',
      }),
    );
  });

  it('相同关系重复写入幂等（不重复）', () => {
    const rel = {
      fromSessionId: subSession,
      toSessionId: rootSession,
      relationType: 'spawned_by' as RelationType,
    };
    store.addRelationship(rel);
    store.addRelationship(rel);
    store.addRelationship(rel);

    expect(store.queryRelationships(subSession)).toHaveLength(1);
  });

  it('支持多种关系类型共存', () => {
    store.addRelationship({
      fromSessionId: subSession,
      toSessionId: rootSession,
      relationType: 'spawned_by',
    });
    store.addRelationship({
      fromSessionId: subSession,
      toSessionId: rootSession,
      relationType: 'continued_from',
    });

    const rels = store.queryRelationships(subSession);
    expect(rels.map((r) => r.relationType).sort()).toEqual([
      'continued_from',
      'spawned_by',
    ]);
  });
});

describe('LOOP-001 验收门 6：scan_runs 与多维查询', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = freshStore();
    const claude = claudeInstance(store); // DEVICE / claude-code / rootPath A
    const codex = codexInstance(store);

    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: claude.id,
      nativeSessionId: 'c-root',
      source: 'claude-code',
      topology: 'root',
      cwd: '/repo',
      messages: baseMessages(),
    });
    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: claude.id,
      nativeSessionId: 'c-sub',
      source: 'claude-code',
      topology: 'subagent',
      cwd: '/repo',
      messages: [{ role: 'assistant', content: 'x', timestamp: 1 }],
    });
    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: codex.id,
      nativeSessionId: 'x-root',
      source: 'codex',
      topology: 'root',
      cwd: '/other',
      messages: [{ role: 'user', content: 'y', timestamp: 1 }],
    });
  });

  it('scan_runs 记录开始与结束', () => {
    const runId = store.startScanRun({ deviceId: DEVICE });
    expect(runId).toBeGreaterThan(0);

    store.finishScanRun(runId, {
      status: 'completed',
      sessionsSeen: 3,
      sessionsNew: 3,
      sessionsUpdated: 0,
    });

    const run = store.getScanRun(runId);
    expect(run.status).toBe('completed');
    expect(run.sessionsSeen).toBe(3);
    expect(run.sessionsNew).toBe(3);
    expect(run.endedAt).toBeGreaterThan(0);
  });

  it('scan_runs 失败路径可记录 error', () => {
    const runId = store.startScanRun({ deviceId: DEVICE });
    store.finishScanRun(runId, { status: 'failed', error: 'disk full' });
    const run = store.getScanRun(runId);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('disk full');
  });

  it('querySessions 按 source 过滤', () => {
    const result = store.querySessions({ source: 'claude-code' });
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.source === 'claude-code')).toBe(true);
  });

  it('querySessions 按 topology 过滤（区分 root/subagent）', () => {
    const roots = store.querySessions({ topology: 'root' });
    const subs = store.querySessions({ topology: 'subagent' });
    expect(roots).toHaveLength(2);
    expect(subs).toHaveLength(1);
  });

  it('querySessions 按 deviceId 过滤', () => {
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(3);
    expect(store.querySessions({ deviceId: DEVICE_OTHER })).toHaveLength(0);
  });
});
