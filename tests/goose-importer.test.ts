/**
 * Goose 原生 adapter 契约测试
 *
 * 覆盖验收门：
 *   1. 导入有效 session：coverage=A，source='goose'，nativeSessionId=session_id
 *   2. 重复扫描幂等：不新增 revision
 *   3. 内容变化（追加消息）生成新 revision
 *   4. 跳过无消息 / 空正文 session 并计数
 *   5. Goose DB 不存在 → 明确错误
 *   6. schema 不匹配 → 明确错误
 *   7. 绝不写入 Goose DB（只读）
 *   8. 路径解析：dbPath 优先 / GOOSE_DATA_DIR 覆盖 / 默认 XDG 路径
 *   9. parent_session_id 拓扑：subagent + spawned_by 关系
 *  10. archived_at 计数（archived session 仍计入 scanned/archived，但无消息跳过）
 *
 * fixture：在临时 SQLite 文件上构建 goose 最小 schema（sessions/messages），
 * 不依赖真实 Goose DB。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { GooseImporter, resolveGooseDbPath } from '../src/goose/index.js';
import type { GooseImportStats } from '../src/goose/index.js';

// node:sqlite 实验性内置，vitest 会误判为裸包；用 createRequire 运行时加载（同 store）
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');

const DEVICE = 'mac-test';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

interface FixtureMessage {
  idx: number;
  role: string;
  content: string;
  created_at?: number | null;
}
interface FixtureSession {
  session_id: string;
  parent_session_id?: string | null;
  archived_at?: number | null;
  working_dir?: string | null;
  started_at?: number | null;
  model?: string | null;
  description?: string | null;
  messages?: FixtureMessage[];
}

/** 在 dbPath 创建 goose 最小 schema 并写入样本数据 */
function buildGooseDb(
  dbPath: string,
  opts: {
    sessions?: FixtureSession[];
    omitMessagesTable?: boolean;
    omitSessionsTable?: boolean;
    /** 故意省略 sessions 必需列（测 schema 校验） */
    dropSessionColumn?: 'parent_session_id' | 'archived_at' | 'session_id';
  } = {},
): void {
  const db = new DatabaseSync(dbPath);
  if (opts.omitSessionsTable && opts.omitMessagesTable) {
    db.close();
    return;
  }

  // sessions 表（按需省略列测 schema 校验）
  const dropCol = opts.dropSessionColumn;
  const sessionCols = [
    dropCol === 'session_id' ? null : 'session_id TEXT PRIMARY KEY',
    dropCol === 'parent_session_id' ? null : 'parent_session_id TEXT',
    dropCol === 'archived_at' ? null : 'archived_at INTEGER',
    'working_dir TEXT',
    'started_at INTEGER',
    'model TEXT',
    'description TEXT',
  ].filter(Boolean) as string[];
  if (!opts.omitSessionsTable) {
    db.exec(`CREATE TABLE sessions (${sessionCols.join(', ')})`);
  }
  if (!opts.omitMessagesTable) {
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER
      );
    `);
  }
  if (opts.omitSessionsTable && opts.omitMessagesTable) {
    db.close();
    return;
  }
  for (const s of opts.sessions ?? []) {
    if (!opts.omitSessionsTable) {
      db.prepare(
        `INSERT INTO sessions (session_id, parent_session_id, archived_at, working_dir, started_at, model, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.session_id,
        s.parent_session_id ?? null,
        s.archived_at ?? null,
        s.working_dir ?? null,
        s.started_at ?? null,
        s.model ?? null,
        s.description ?? null,
      );
    }
    if (!opts.omitMessagesTable) {
      for (const m of s.messages ?? []) {
        db.prepare(
          'INSERT INTO messages (session_id, idx, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(s.session_id, m.idx, m.role, m.content, m.created_at ?? null);
      }
    }
  }
  db.close();
}

/** 打开已存在的 goose fixture 做只读检查 */
function openReadOnly(dbPath: string): InstanceType<typeof DatabaseSync> {
  return new DatabaseSync(dbPath, { readOnly: true });
}

// ─── 测试体 ──────────────────────────────────────────────────────────────────

describe('Goose 原生 adapter 契约测试', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goose-test-'));
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

  // ── 验收门 1：导入有效 session，coverage=A，nativeSessionId=session_id ──

  it('导入有效 session，注册 coverage=A 的 goose source instance，nativeSessionId=session_id', () => {
    const dbPath = path.join(tmpDir, 'sessions.db');
    buildGooseDb(dbPath, {
      sessions: [
        {
          session_id: 'sess-100',
          working_dir: '/repo/a',
          started_at: 1_000,
          model: 'zhipu/glm-5.2',
          messages: [
            { idx: 0, role: 'user', content: 'hello goose', created_at: 1_000 },
            { idx: 1, role: 'assistant', content: 'hi', created_at: 2_000 },
          ],
        },
      ],
    });

    const importer = new GooseImporter(store, { dbPath, deviceId: DEVICE });
    const stats: GooseImportStats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);
    expect(stats.skipped).toBe(0);

    // goose source instance：coverage=A，rootPath=db 目录
    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst).toBeDefined();
    expect(inst!.source).toBe('goose');
    expect(inst!.coverage).toBe('A');
    expect(inst!.rootPath).toBe(tmpDir);

    // session：source=goose，nativeSessionId=session_id，cwd=working_dir
    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.source).toBe('goose');
    expect(s.nativeSessionId).toBe('sess-100');
    expect(s.cwd).toBe('/repo/a');
    expect(s.projectPath).toBe('/repo/a');
    expect(s.startedAt).toBe(1_000);
    expect(s.model).toBe('zhipu/glm-5.2');
    expect(s.topology).toBe('root');
    expect(s.sourceInstanceId).toBe(stats.sourceInstanceId);

    // 消息按序入库
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello goose'],
      ['assistant', 'hi'],
    ]);
    expect(msgs[0]!.timestamp).toBe(1_000);

    // scan_run 已记录完成
    const run = store.getScanRun(stats.scanRunId);
    expect(run.status).toBe('completed');
    expect(run.sessionsSeen).toBe(1);
    expect(run.sessionsNew).toBe(1);
    expect(run.endedAt).toBeGreaterThan(0);
  });

  // ── 验收门 2：重复扫描幂等 ───────────────────────────────────────────────

  it('相同内容重复导入幂等：不新增 revision，计入 unchanged', () => {
    const dbPath = path.join(tmpDir, 'sessions.db');
    buildGooseDb(dbPath, {
      sessions: [
        {
          session_id: 'dup-1',
          messages: [
            { idx: 0, role: 'user', content: 'q' },
            { idx: 1, role: 'assistant', content: 'a' },
          ],
        },
      ],
    });

    const importer = new GooseImporter(store, { dbPath, deviceId: DEVICE });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    const second = importer.import();
    expect(second.scanned).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    expect(store.getMessages(sessions[0]!.id)).toHaveLength(2);
    expect(store.getRevisions(sessions[0]!.id)).toHaveLength(1);
  });

  // ── 验收门 3：内容变化生成新 revision ────────────────────────────────────

  it('内容变化（追加消息）生成新 revision，revision_number 递增', () => {
    const dbPath = path.join(tmpDir, 'sessions.db');
    buildGooseDb(dbPath, {
      sessions: [
        {
          session_id: 'rev-5',
          messages: [
            { idx: 0, role: 'user', content: 'first' },
            { idx: 1, role: 'assistant', content: 'resp' },
          ],
        },
      ],
    });

    const importer = new GooseImporter(store, { dbPath, deviceId: DEVICE });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    // 模拟 goose 追加一条消息
    const write = new DatabaseSync(dbPath);
    write.prepare(
      'INSERT INTO messages (session_id, idx, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('rev-5', 2, 'user', 'follow up', 3_000);
    write.close();

    const second = importer.import();
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(0);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const revs = store.getRevisions(sessions[0]!.id);
    expect(revs.map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(revs[1]!.contentHash).not.toBe(revs[0]!.contentHash);
    expect(store.getMessages(sessions[0]!.id)).toHaveLength(3);
  });

  // ── 验收门 4：跳过无消息 / 空正文 session ────────────────────────────────

  it('跳过无消息与空正文 session，计入 skipped，有效 session 正常入库', () => {
    const dbPath = path.join(tmpDir, 'sessions.db');
    buildGooseDb(dbPath, {
      sessions: [
        {
          session_id: 'good-1',
          messages: [{ idx: 0, role: 'user', content: 'real content' }],
        },
        // 无消息
        { session_id: 'empty-2', messages: [] },
        // 全部空正文
        {
          session_id: 'blank-3',
          messages: [
            { idx: 0, role: 'user', content: '' },
            { idx: 1, role: 'assistant', content: '   ' },
          ],
        },
      ],
    });

    const importer = new GooseImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(3);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(2);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.nativeSessionId).toBe('good-1');
  });

  // ── 验收门 5：Goose DB 不存在 → 明确错误 ────────────────────────────────

  it('Goose DB 不存在时抛出明确错误，且不遗留 running 状态的 scan_run', () => {
    const importer = new GooseImporter(store, {
      dbPath: path.join(tmpDir, 'nope', 'sessions.db'),
      deviceId: DEVICE,
    });
    expect(() => importer.import()).toThrowError(/goose/i);

    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 验收门 6：schema 不匹配 → 明确错误 ───────────────────────────────────

  it('Goose DB 缺少 sessions 表时抛出 schema 不匹配错误', () => {
    const dbPath = path.join(tmpDir, 'sessions.db');
    buildGooseDb(dbPath, { omitSessionsTable: true });

    const importer = new GooseImporter(store, { dbPath, deviceId: DEVICE });
    expect(() => importer.import()).toThrowError(/goose.*schema|schema.*goose|sessions/i);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  it('Goose DB 缺少 parent_session_id 列时抛出 schema 不匹配错误', () => {
    const dbPath = path.join(tmpDir, 'sessions.db');
    buildGooseDb(dbPath, {
      sessions: [],
      dropSessionColumn: 'parent_session_id',
    });

    const importer = new GooseImporter(store, { dbPath, deviceId: DEVICE });
    expect(() => importer.import()).toThrowError(/goose.*schema|schema.*goose|parent_session_id/i);
  });

  // ── 验收门 7：绝不写入 Goose DB（只读） ──────────────────────────────────

  it('导入后 Goose DB 不含任何 yondermesh 表，且原始行数不变', () => {
    const dbPath = path.join(tmpDir, 'sessions.db');
    buildGooseDb(dbPath, {
      sessions: [
        {
          session_id: 'ro-1',
          messages: [{ idx: 0, role: 'user', content: 'x' }],
        },
      ],
    });

    new GooseImporter(store, { dbPath, deviceId: DEVICE }).import();

    const ro = openReadOnly(dbPath);
    const ymTables = ro
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN
         ('sessions','session_revisions','source_instances','scan_runs','session_relationships')`,
      )
      .all() as { name: string }[];
    // yondermesh 自身的 sessions 表名与 goose 的同名，但不应该出现在 goose DB 里
    // —— goose DB 只有 sessions/messages 两张表（无 session_revisions 等）
    expect(ymTables.filter((t) => t.name !== 'sessions' && t.name !== 'messages')).toHaveLength(0);
    expect((ro.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
    expect((ro.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
    ro.close();
  });

  // ── 验收门 8：路径解析 ───────────────────────────────────────────────────

  describe('resolveGooseDbPath', () => {
    const envBackup = { ...process.env };

    afterEach(() => {
      for (const k of Object.keys(process.env)) {
        if (!(k in envBackup)) delete process.env[k];
      }
      Object.assign(process.env, envBackup);
    });

    it('dbPath 选项优先级最高，忽略 GOOSE_DATA_DIR', () => {
      process.env.GOOSE_DATA_DIR = '/some/other/dir';
      expect(resolveGooseDbPath({ dbPath: '/explicit/path.db' })).toBe('/explicit/path.db');
    });

    it('GOOSE_DATA_DIR 覆盖默认数据目录', () => {
      process.env.GOOSE_DATA_DIR = path.join(tmpDir, 'custom-goose');
      const resolved = resolveGooseDbPath();
      expect(resolved).toBe(path.join(tmpDir, 'custom-goose', 'sessions.db'));
    });

    it('无 dbPath 与 GOOSE_DATA_DIR 时回退到默认 XDG 路径', () => {
      delete process.env.GOOSE_DATA_DIR;
      const resolved = resolveGooseDbPath();
      expect(resolved).toContain('.local');
      expect(resolved).toContain('goose');
      expect(resolved.endsWith('sessions.db')).toBe(true);
    });
  });

  // ── 验收门 9：parent_session_id 拓扑 ─────────────────────────────────────

  it('parent_session_id 非空 → topology=subagent 并建 spawned_by 关系', () => {
    const dbPath = path.join(tmpDir, 'sessions.db');
    buildGooseDb(dbPath, {
      sessions: [
        {
          session_id: 'root-1',
          messages: [{ idx: 0, role: 'user', content: 'parent' }],
        },
        {
          session_id: 'sub-1',
          parent_session_id: 'root-1',
          messages: [{ idx: 0, role: 'user', content: 'child' }],
        },
        {
          session_id: 'sub-2',
          parent_session_id: 'root-1',
          messages: [{ idx: 0, role: 'user', content: 'child2' }],
        },
      ],
    });

    const importer = new GooseImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(3);
    expect(stats.inserted).toBe(3);
    expect(stats.subagents).toBe(2);
    expect(stats.relationships).toBe(2);
    expect(stats.unlinkedSubagents).toBe(0);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(3);
    const subs = sessions.filter((s) => s.topology === 'subagent');
    expect(subs).toHaveLength(2);
    const roots = sessions.filter((s) => s.topology === 'root');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.nativeSessionId).toBe('root-1');
  });

  it('parent_session_id 指向不存在的父 → unlinkedSubagents 计数，不建关系', () => {
    const dbPath = path.join(tmpDir, 'sessions.db');
    buildGooseDb(dbPath, {
      sessions: [
        {
          session_id: 'orphan-1',
          parent_session_id: 'ghost-parent',
          messages: [{ idx: 0, role: 'user', content: 'orphan' }],
        },
      ],
    });

    const importer = new GooseImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.inserted).toBe(1);
    expect(stats.subagents).toBe(1);
    expect(stats.unlinkedSubagents).toBe(1);
    expect(stats.relationships).toBe(0);
  });

  // ── 验收门 10：archived_at 计数 ──────────────────────────────────────────

  it('archived_at 非空的 session 仍计入 scanned 与 archived 计数', () => {
    const dbPath = path.join(tmpDir, 'sessions.db');
    buildGooseDb(dbPath, {
      sessions: [
        {
          session_id: 'live-1',
          archived_at: null,
          messages: [{ idx: 0, role: 'user', content: 'live' }],
        },
        {
          session_id: 'archived-1',
          archived_at: 5_000,
          messages: [{ idx: 0, role: 'user', content: 'archived' }],
        },
      ],
    });

    const importer = new GooseImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(2);
    expect(stats.archived).toBe(1);
    // 两条都有消息，均入库
    expect(stats.inserted).toBe(2);
  });
});
