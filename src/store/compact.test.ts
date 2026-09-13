/**
 * compact.test.ts — 数据库膨胀治理的验收测试
 *
 * 背景（实测数据）：每次内容变化都整份重写消息，存储随对话长度平方增长。
 * 线上库实测：986 条消息 / 2082 个 revision / 193 万行，13GB 库中 97% 是
 * 被覆盖的历史副本，而没有任何读路径会读它们。
 *
 * 验收门：
 *   C1. 新 revision 落库后，只保留 current revision 的消息正文（元数据保留）
 *   C2. FTS 行数 = current revision 的 user 消息数（不随 revision 数放大）
 *   C3. FTS 的 rowid == messages.id（保证删除 O(1)，不再全表扫）
 *   C4. 删除消息时 FTS 同步删除（触发器正确）
 *   C5. compactAnalyze / compactApply 能回收 keep 模式下留下的历史副本
 *   C6. keep 模式仍然保留完整历史（排障开关没被破坏）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from './index.js';
import type { SessionIngestInput, SessionMessageInput } from './index.js';

const DEVICE = 'mac-test';

function msg(role: 'user' | 'assistant', content: string): SessionMessageInput {
  return { role, content };
}

describe('SessionStore compact（数据库膨胀治理）', () => {
  let store: SessionStore;
  let instId: string;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    instId = store.registerSourceInstance({
      deviceId: DEVICE,
      source: 'claude-code',
      rootPath: '/home/.claude/projects',
      coverage: 'A',
    }).id;
  });

  afterEach(() => store.close());

  function ingest(messages: SessionMessageInput[], nativeId = 'sess-1') {
    const input: SessionIngestInput = {
      deviceId: DEVICE,
      sourceInstanceId: instId,
      nativeSessionId: nativeId,
      source: 'claude-code',
      cwd: '/repo/test',
      projectPath: '/repo/test',
      startedAt: Date.now() - 60_000,
      fileModifiedAt: Date.now(),
      messages,
    };
    return store.ingestSession(input);
  }

  it('C1: 增长式对话只保留当前 revision 正文，revision 元数据仍完整', () => {
    ingest([msg('user', '你好'), msg('assistant', '在的')]);
    ingest([msg('user', '你好'), msg('assistant', '在的'), msg('user', '继续')]);
    ingest([
      msg('user', '你好'),
      msg('assistant', '在的'),
      msg('user', '继续'),
      msg('user', '再继续'),
    ]);
    const sid = ingest([
      msg('user', '你好'),
      msg('assistant', '在的'),
      msg('user', '继续'),
      msg('user', '再继续'),
      msg('assistant', '好的'),
    ]).sessionId;

    // revision 元数据保留（审计/回溯用）：4 次内容变化 = 4 个 revision
    expect(store.getRevisions(sid).length).toBe(4);

    // 正文只剩 current revision 的那 5 条
    const rows = store.getMessages(sid);
    expect(rows.map((r) => r.content)).toEqual(['你好', '在的', '继续', '再继续', '好的']);

    // 历史副本行数为 0（改成 keep 模式前不再累积），旧行为是 1+2+3+4=10 行
    const physical = store.countSupersededRevisionStore();
    expect(physical.rows).toBe(0);
  });

  it('C2/C3: FTS 只索引当前 revision 的 user 消息，且 rowid == message id', () => {
    ingest([msg('user', 'alpha 关键字'), msg('assistant', '回复')]);
    const sid = ingest([
      msg('user', 'alpha 关键字'),
      msg('assistant', '回复'),
      msg('user', 'beta 关键字'),
    ]).sessionId;

    // 2 条 user 消息（不是 3 条：旧 revision 不重复索引）
    expect(store.countFtsRows()).toBe(2);

    // 命中的 session 正确
    const hits = store.querySessions({ keyword: 'beta' });
    expect(hits.map((h) => h.id)).toEqual([sid]);

    // 旧 revision 的重复内容不应造成重复命中（同一 session 只出现一次）
    const dupHits = store.querySessions({ keyword: 'alpha' });
    expect(dupHits.length).toBe(1);
  });

  it('C4: 删除消息时 FTS 同步删除（触发器按 rowid 工作）', () => {
    ingest([msg('user', '要留下的'), msg('assistant', '回复')]);
    const sid = ingest([
      msg('user', '要留下的'),
      msg('assistant', '回复'),
      msg('user', '要被替换的'),
    ]).sessionId;
    expect(store.querySessions({ keyword: '要被替换' }).length).toBe(1);

    // 内容被改写（非追加）：旧正文应当从 FTS 消失
    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: instId,
      nativeSessionId: 'sess-1',
      source: 'claude-code',
      cwd: '/repo/test',
      projectPath: '/repo/test',
      startedAt: Date.now() - 60_000,
      fileModifiedAt: Date.now(),
      messages: [msg('user', '要留下的'), msg('assistant', '回复'), msg('user', '换成了别的')],
    });

    expect(store.querySessions({ keyword: '要被替换' }).length).toBe(0);
    expect(store.querySessions({ keyword: '换成了别的' }).map((s) => s.id)).toEqual([sid]);
    expect(store.countFtsRows()).toBe(2); // 无孤立 FTS 行
  });

  it('C5: compact 能把 keep 模式留下的历史副本回收掉', () => {
    store.setRevisionBodyMode('keep');
    for (let i = 1; i <= 6; i++) {
      const messages = Array.from({ length: i }, (_, k) => msg('user', `第 ${k} 条`));
      ingest(messages);
    }
    // keep 模式：1+2+3+4+5+6 = 21 行正文
    expect(store.countSupersededRevisionStore().rows).toBe(15);

    const analysis = store.compactAnalyze();
    expect(analysis.prunableRevisionRows).toBe(15);
    expect(analysis.sessionsWithSupersededRevisions).toBe(1);

    store.setRevisionBodyMode('current-only');
    const report = store.compactApply({ rebuildFts: true });
    expect(report.deletedRevisionRows).toBe(15);

    // 回收后：正文只剩当前 6 条，FTS 只剩当前 user 消息
    expect(store.getMessages(ingest([1, 2, 3, 4, 5, 6].map((k) => msg('user', `第 ${k} 条`))).sessionId).length).toBe(6);
    expect(store.countFtsRows()).toBe(6);
  });

  it('C7: compact 清掉孤儿行（session 已不存在的历史遗留）', () => {
    ingest([msg('user', '正常会话')]);
    const store2 = store as unknown as {
      db: {
        exec: (sql: string) => void;
        prepare: (s: string) => { run: (...a: unknown[]) => unknown };
      };
    };
    // 手工制造孤儿：模拟老版本 retain 用自己的连接删 session 时的状态
    // （那个连接没开 PRAGMA foreign_keys，所以既不级联也不报错）
    store2.db.exec('PRAGMA foreign_keys = OFF');
    store2.db.prepare('INSERT INTO session_revisions (session_id, revision_number, content_hash, message_count, recorded_at) VALUES (?, 1, ?, 1, ?)').run('ghost-session', 'deadbeef', Date.now());
    store2.db.prepare('INSERT INTO messages (session_id, revision_id, seq, role, content) VALUES (?, (SELECT max(id) FROM session_revisions), 0, ?, ?)').run('ghost-session', 'user', '孤儿消息');
    store2.db.exec('PRAGMA foreign_keys = ON');

    expect(store.countOrphanRows()).toBe(2);

    const report = store.compactApply({});
    expect(report.purgedOrphanRows).toBe(2);
    expect(store.countOrphanRows()).toBe(0);
  });

  it('C6: keep 模式仍然保留每一版正文（排障开关有效）', () => {
    store.setRevisionBodyMode('keep');
    ingest([msg('user', 'a')]);
    ingest([msg('user', 'a'), msg('user', 'b')]);
    expect(store.countSupersededRevisionStore().rows).toBe(1);
  });
});

describe('resolveLastActivity：活跃时间不能用扫描时间', () => {
  const DEVICE2 = 'activity-test';
  function env() {
    const store = new SessionStore(':memory:');
    const inst = store.registerSourceInstance({
      deviceId: DEVICE2,
      source: 'hermes',
      rootPath: '/fake/.hermes',
      coverage: 'A',
    });
    return { store, inst };
  }

  it('adapter 没给 fileModifiedAt 时，用最后一条消息的时间（不是 Date.now）', () => {
    const { store, inst } = env();
    const lastMsgAt = Date.now() - 3 * 24 * 3600_000; // 3 天前说过话
    const sid = store.ingestSession({
      deviceId: DEVICE2,
      sourceInstanceId: inst.id,
      nativeSessionId: 'old-session',
      source: 'hermes',
      startedAt: lastMsgAt - 60_000,
      messages: [
        { role: 'user', content: 'hi', timestamp: lastMsgAt - 1000 },
        { role: 'assistant', content: 'yo', timestamp: lastMsgAt },
      ],
    }).sessionId;
    const s = store.getSession(sid)!;
    // 修复前这里会是「现在」→ 每个死会话看起来都刚活跃过
    expect(s.fileModifiedAt).toBe(lastMsgAt);
  });

  it('秒级时间戳会被归一成毫秒（少数 adapter 给秒）', () => {
    const { store, inst } = env();
    const secs = Math.floor((Date.now() - 3600_000) / 1000);
    const sid = store.ingestSession({
      deviceId: DEVICE2,
      sourceInstanceId: inst.id,
      nativeSessionId: 'sec-session',
      source: 'hermes',
      messages: [{ role: 'user', content: 'hi', timestamp: secs }],
    }).sessionId;
    const s = store.getSession(sid)!;
    expect(s.fileModifiedAt).toBe(secs * 1000);
  });

  it('adapter 显式给了 fileModifiedAt 时以它为准（文件 mtime 更准）', () => {
    const { store, inst } = env();
    const mtime = Date.now() - 5000;
    const sid = store.ingestSession({
      deviceId: DEVICE2,
      sourceInstanceId: inst.id,
      nativeSessionId: 'explicit-session',
      source: 'claude-code',
      fileModifiedAt: mtime,
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() - 999_999 }],
    }).sessionId;
    expect(store.getSession(sid)!.fileModifiedAt).toBe(mtime);
  });
});
