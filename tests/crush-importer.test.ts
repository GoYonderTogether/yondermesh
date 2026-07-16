/**
 * Crush 原生 importer 测试（覆盖等级 A）
 *
 * 覆盖：
 *   1. crush.db 解析：sessions + messages → 入库 + coverage=A source instance
 *   2. parent_session_id 拓扑：root vs subagent
 *   3. spawned_by 关系：subagent → parent
 *   4. 排除 is_summary_message=1（compaction 摘要）
 *   5. parts JSON 数组解析（type=text 块的 text/content）
 *   6. 元数据透传：model / promptTokens / completionTokens / cost
 *   7. 幂等：重复导入内容不变计入 unchanged
 *   8. schema 不匹配 → 明确错误
 *   9. crush.db 不可读 → 明确错误
 *  10. 路径解析：dbPath 选项优先 / cwd 拼接
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { CrushImporter, resolveCrushDbPath } from '../src/crush/index.js';
import type { CrushImportStats } from '../src/crush/index.js';

// node:sqlite 实验性内置，vitest 会误判为裸包；用 createRequire 运行时加载（同 store）
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');

const DEVICE = 'mac-test';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

interface FixtureSession {
  id: string;
  parentSessionId?: string | null;
  title?: string | null;
  messageCount?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cost?: number | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

interface FixtureMessage {
  id: string;
  sessionId: string;
  role: string;
  /** parts 已序列化为 JSON 字符串 */
  parts: string;
  model?: string | null;
  createdAt?: number | null;
  isSummaryMessage?: number | null;
}

/** 把文本包装为 crush parts JSON 数组：[{"type":"text","text":"..."}] */
function textParts(text: string): string {
  return JSON.stringify([{ type: 'text', text }]);
}

/** 在 dbPath 创建 crush schema 并写入样本数据 */
function buildCrushDb(
  dbPath: string,
  opts: {
    sessions?: FixtureSession[];
    messages?: FixtureMessage[];
    omitMessagesTable?: boolean;
    omitRequiredColumn?: boolean;
  } = {},
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  if (opts.omitRequiredColumn) {
    // 故意缺少 parent_session_id 列（用于 schema 不匹配测试）
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER,
        message_count INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cost REAL
      );
    `);
  } else {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT,
        title TEXT,
        message_count INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cost REAL,
        created_at INTEGER,
        updated_at INTEGER,
        summary_message_id TEXT,
        todos TEXT
      );
    `);
  }

  if (!opts.omitMessagesTable) {
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        parts TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        finished_at INTEGER,
        provider TEXT,
        is_summary_message INTEGER DEFAULT 0
      );
    `);
  }

  // 仅在表结构完整时插入数据（omitRequiredColumn / omitMessagesTable 时跳过）
  if (!opts.omitRequiredColumn) {
    const sessStmt = db.prepare(
      `INSERT INTO sessions
       (id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of opts.sessions ?? []) {
      sessStmt.run(
        s.id,
        s.parentSessionId ?? null,
        s.title ?? null,
        s.messageCount ?? null,
        s.promptTokens ?? null,
        s.completionTokens ?? null,
        s.cost ?? null,
        s.createdAt ?? null,
        s.updatedAt ?? null,
      );
    }
  }

  if (!opts.omitMessagesTable) {
    const msgStmt = db.prepare(
      `INSERT INTO messages
       (id, session_id, role, parts, model, created_at, is_summary_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of opts.messages ?? []) {
      msgStmt.run(
        m.id,
        m.sessionId,
        m.role,
        m.parts,
        m.model ?? null,
        m.createdAt ?? null,
        m.isSummaryMessage ?? 0,
      );
    }
  }

  db.close();
}

// ─── 测试体 ──────────────────────────────────────────────────────────────────

describe('Crush 原生 importer', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-imp-'));
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. 基本解析 ─────────────────────────────────────────────────────────

  it('crush.db 解析：sessions + messages → 入库，coverage=A', () => {
    const dbPath = path.join(tmpDir, '.crush', 'crush.db');
    buildCrushDb(dbPath, {
      sessions: [
        {
          id: 's1',
          title: 'My Crush Session',
          messageCount: 2,
          promptTokens: 100,
          completionTokens: 200,
          cost: 0.005,
          createdAt: 1_700_000_000,
        },
      ],
      messages: [
        { id: 'm1', sessionId: 's1', role: 'user', parts: textParts('hello crush'), createdAt: 1_700_000_000, model: 'gpt-5' },
        { id: 'm2', sessionId: 's1', role: 'assistant', parts: textParts('hi from crush'), createdAt: 1_700_000_005 },
      ],
    });

    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    const stats: CrushImportStats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.subagents).toBe(0);
    expect(stats.relationships).toBe(0);

    // coverage=A source instance，rootPath=cwd
    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst).toBeDefined();
    expect(inst!.source).toBe('crush');
    expect(inst!.coverage).toBe('A');
    expect(inst!.rootPath).toBe(tmpDir);

    // session 字段
    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.source).toBe('crush');
    expect(s.nativeSessionId).toBe('s1');
    expect(s.topology).toBe('root');
    expect(s.model).toBe('gpt-5');
    expect(s.totalInputTokens).toBe(100);
    expect(s.totalOutputTokens).toBe(200);
    expect(s.estimatedCostUsd).toBe(0.005);

    // 消息
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello crush'],
      ['assistant', 'hi from crush'],
    ]);
  });

  // ── 2. 拓扑 + spawned_by 关系 ──────────────────────────────────────────

  it('parent_session_id 非空 → subagent，parent 在同次扫描 → 写 spawned_by', () => {
    const dbPath = path.join(tmpDir, '.crush', 'crush.db');
    buildCrushDb(dbPath, {
      sessions: [
        { id: 'root-s', createdAt: 1_000 },
        { id: 'sub-s', parentSessionId: 'root-s', createdAt: 1_100 },
      ],
      messages: [
        { id: 'rm1', sessionId: 'root-s', role: 'user', parts: textParts('root q') },
        { id: 'rm2', sessionId: 'root-s', role: 'assistant', parts: textParts('root a') },
        { id: 'sm1', sessionId: 'sub-s', role: 'user', parts: textParts('sub q') },
        { id: 'sm2', sessionId: 'sub-s', role: 'assistant', parts: textParts('sub a') },
      ],
    });

    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(2);
    expect(stats.subagents).toBe(1);
    expect(stats.unlinkedSubagents).toBe(0);
    expect(stats.relationships).toBe(1);

    const sessions = store.querySessions({ deviceId: DEVICE });
    const root = sessions.find((s) => s.nativeSessionId === 'root-s')!;
    const sub = sessions.find((s) => s.nativeSessionId === 'sub-s')!;
    expect(root.topology).toBe('root');
    expect(sub.topology).toBe('subagent');

    const rels = store.queryRelationships(sub.id);
    const outgoing = rels.filter((r) => r.direction === 'outgoing' && r.relationType === 'spawned_by');
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.toSessionId).toBe(root.id);
    expect(outgoing[0]!.evidence).toContain('parent_session_id');
  });

  it('parent 未入库的 subagent → unlinkedSubagents', () => {
    const dbPath = path.join(tmpDir, '.crush', 'crush.db');
    buildCrushDb(dbPath, {
      sessions: [
        { id: 'orphan', parentSessionId: 'missing-parent', createdAt: 1_000 },
      ],
      messages: [
        { id: 'om1', sessionId: 'orphan', role: 'user', parts: textParts('orphan q') },
        { id: 'om2', sessionId: 'orphan', role: 'assistant', parts: textParts('orphan a') },
      ],
    });

    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    const stats = importer.import();
    expect(stats.subagents).toBe(1);
    expect(stats.unlinkedSubagents).toBe(1);
    expect(stats.relationships).toBe(0);
  });

  // ── 3. 排除 is_summary_message ─────────────────────────────────────────

  it('is_summary_message=1 的 compaction 摘要被排除', () => {
    const dbPath = path.join(tmpDir, '.crush', 'crush.db');
    buildCrushDb(dbPath, {
      sessions: [{ id: 'sum-s', createdAt: 1_000 }],
      messages: [
        { id: 'u1', sessionId: 'sum-s', role: 'user', parts: textParts('real q') },
        { id: 'a1', sessionId: 'sum-s', role: 'assistant', parts: textParts('real a') },
        // compaction 摘要（应被排除）
        { id: 's1', sessionId: 'sum-s', role: 'assistant', parts: textParts('compaction summary'), isSummaryMessage: 1 },
        { id: 's2', sessionId: 'sum-s', role: 'user', parts: textParts('user summary'), isSummaryMessage: 1 },
      ],
    });

    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    importer.import();

    const sessions = store.querySessions({ deviceId: DEVICE });
    const msgs = store.getMessages(sessions[0]!.id);
    expect(msgs.map((m) => m.content)).toEqual(['real q', 'real a']);
    expect(msgs.some((m) => m.content.includes('compaction'))).toBe(false);
  });

  // ── 4. parts 解析（content 字段兼容 + 空数组）────────────────────────────

  it('parts 支持 {"type":"text","content":"..."} 兼容形态，空数组跳过', () => {
    const dbPath = path.join(tmpDir, '.crush', 'crush.db');
    buildCrushDb(dbPath, {
      sessions: [{ id: 'parts-s', createdAt: 1_000 }],
      messages: [
        // text + content 形态
        { id: 'p1', sessionId: 'parts-s', role: 'user', parts: JSON.stringify([{ type: 'text', content: 'content-form' }]) },
        { id: 'p2', sessionId: 'parts-s', role: 'assistant', parts: JSON.stringify([{ type: 'text', text: 'text-form' }]) },
        // 非 text 块 + 空数组 → 该消息无文本，跳过
        { id: 'p3', sessionId: 'parts-s', role: 'user', parts: JSON.stringify([{ type: 'tool_use', id: 'x' }]) },
        { id: 'p4', sessionId: 'parts-s', role: 'assistant', parts: '[]' },
        // 非法 JSON → 跳过该消息
        { id: 'p5', sessionId: 'parts-s', role: 'user', parts: 'not-json' },
      ],
    });

    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    importer.import();

    const sessions = store.querySessions({ deviceId: DEVICE });
    const msgs = store.getMessages(sessions[0]!.id);
    expect(msgs.map((m) => m.content)).toEqual(['content-form', 'text-form']);
  });

  // ── 5. 仅 system/tool 角色被过滤（只保留 user/assistant 可显示）─────────

  it('system/tool 角色消息不保留为可显示文本', () => {
    const dbPath = path.join(tmpDir, '.crush', 'crush.db');
    buildCrushDb(dbPath, {
      sessions: [{ id: 'roles-s', createdAt: 1_000 }],
      messages: [
        { id: 'r1', sessionId: 'roles-s', role: 'user', parts: textParts('u') },
        { id: 'r2', sessionId: 'roles-s', role: 'assistant', parts: textParts('a') },
        { id: 'r3', sessionId: 'roles-s', role: 'system', parts: textParts('sys') },
        { id: 'r4', sessionId: 'roles-s', role: 'tool', parts: textParts('tool') },
      ],
    });

    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    importer.import();

    const sessions = store.querySessions({ deviceId: DEVICE });
    const msgs = store.getMessages(sessions[0]!.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'u'],
      ['assistant', 'a'],
    ]);
  });

  // ── 6. 幂等 ─────────────────────────────────────────────────────────────

  it('重复导入相同内容幂等：inserted=1 → unchanged=1', () => {
    const dbPath = path.join(tmpDir, '.crush', 'crush.db');
    buildCrushDb(dbPath, {
      sessions: [{ id: 'dup-s', createdAt: 1_000 }],
      messages: [
        { id: 'd1', sessionId: 'dup-s', role: 'user', parts: textParts('dup q') },
        { id: 'd2', sessionId: 'dup-s', role: 'assistant', parts: textParts('dup a') },
      ],
    });

    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    const second = importer.import();
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  // ── 7. 跳过无消息 session ───────────────────────────────────────────────

  it('无有效消息的 session → skipped', () => {
    const dbPath = path.join(tmpDir, '.crush', 'crush.db');
    buildCrushDb(dbPath, {
      sessions: [
        { id: 'empty-s', createdAt: 1_000 },
        { id: 'only-summary-s', createdAt: 2_000 },
      ],
      messages: [
        // only-summary-s 只有 compaction 摘要 → 无有效消息
        { id: 'os1', sessionId: 'only-summary-s', role: 'assistant', parts: textParts('summary'), isSummaryMessage: 1 },
      ],
    });

    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    const stats = importer.import();
    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(2);
  });

  // ── 8. schema 不匹配 → 错误 ─────────────────────────────────────────────

  it('sessions 表缺少必需列 → 抛 schema 不匹配错误', () => {
    const dbPath = path.join(tmpDir, '.crush', 'crush.db');
    buildCrushDb(dbPath, { omitRequiredColumn: true });

    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    expect(() => importer.import()).toThrow(/schema 不匹配/);
  });

  it('缺少 messages 表 → 抛 schema 不匹配错误', () => {
    const dbPath = path.join(tmpDir, '.crush', 'crush.db');
    buildCrushDb(dbPath, { omitMessagesTable: true });

    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    expect(() => importer.import()).toThrow(/schema 不匹配/);
  });

  // ── 9. crush.db 不可读 → 错误 ───────────────────────────────────────────

  it('crush.db 不存在 → 抛"数据库不可读"错误', () => {
    const dbPath = path.join(tmpDir, '.crush', 'missing.db');
    const importer = new CrushImporter(store, { dbPath, cwd: tmpDir, deviceId: DEVICE });
    expect(() => importer.import()).toThrow(/数据库不可读/);
  });

  // ── 10. 路径解析 ─────────────────────────────────────────────────────────

  it('resolveCrushDbPath：dbPath 选项优先于 cwd 拼接', () => {
    expect(resolveCrushDbPath({ dbPath: '/explicit/crush.db' })).toBe('/explicit/crush.db');
    const p = resolveCrushDbPath({ cwd: '/repo' });
    expect(p).toBe(path.join('/repo', '.crush', 'crush.db'));
  });

  it('resolveCrushDbPath：cwd 默认 process.cwd()', () => {
    const p = resolveCrushDbPath({});
    expect(p).toBe(path.join(process.cwd(), '.crush', 'crush.db'));
  });
});
