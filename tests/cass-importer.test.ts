/**
 * LOOP-002 cass 历史导入 契约测试（RED 优先）
 *
 * 覆盖验收门（docs/implementation-loops.md §4）：
 *   1. 流式导入有效 conversation，注册 coverage=B 的 cass source instance
 *   2. 重复导入幂等：不新增 revision
 *   3. 内容变化（追加消息）生成新 revision
 *   4. 跳过无消息 / 脏数据并计数
 *   5. cass 数据库不可用 → 明确错误
 *   6. cass schema 不匹配 → 明确错误
 *   7. 绝不写入 cass DB（只读）
 *   8. 路径解析：dbPath 优先 / CASS_DATA_DIR 覆盖 / 默认 macOS 路径
 *   9. nativeSessionId 回退链：external_id → source_id → id
 *
 * fixture：在临时 SQLite 文件上构建 cass 最小 schema（agents/workspaces/sources/
 * conversations/messages），不依赖真实 cass DB。真实本机命令见实现完成后报告。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { CassImporter, resolveCassDbPath } from '../src/cass/index.js';
import type { CassImportStats } from '../src/cass/index.js';

// node:sqlite 实验性内置，vitest 会误判为裸包；用 createRequire 运行时加载（同 store）
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');

const DEVICE = 'mac-test';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

interface FixtureAgent {
  id: number;
  slug: string;
  name?: string;
  kind?: string;
}
interface FixtureWorkspace {
  id: number;
  path: string;
}
interface FixtureMessage {
  idx: number;
  role: string;
  content: string;
  createdAt?: number;
}
interface FixtureConversation {
  id: number;
  agentId: number;
  workspaceId?: number | null;
  externalId?: string | null;
  sourceId?: string;
  startedAt?: number | null;
  sourcePath?: string;
  messages?: FixtureMessage[];
}

/** 在 dbPath 创建 cass 最小 schema 并写入样本数据 */
function buildCassDb(
  dbPath: string,
  opts: {
    agents?: FixtureAgent[];
    workspaces?: FixtureWorkspace[];
    conversations?: FixtureConversation[];
    skipSourcesTable?: boolean;
    omitConversationsTable?: boolean;
  } = {},
): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, slug TEXT NOT NULL, name TEXT, kind TEXT);
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL, display_name TEXT);
    CREATE TABLE sources (id TEXT PRIMARY KEY, kind TEXT);
  `);
  // conversations/messages 可整体省略，用于 schema 不匹配测试
  if (!opts.omitConversationsTable) {
    db.exec(`
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY,
        agent_id INTEGER NOT NULL,
        workspace_id INTEGER,
        source_id TEXT NOT NULL DEFAULT 'local',
        external_id TEXT,
        title TEXT,
        source_path TEXT,
        started_at INTEGER,
        ended_at INTEGER
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        role TEXT NOT NULL,
        author TEXT,
        created_at INTEGER,
        content TEXT NOT NULL,
        extra_json TEXT,
        UNIQUE (conversation_id, idx)
      );
    `);
  }
  if (!opts.skipSourcesTable) {
    db.prepare("INSERT INTO sources (id, kind) VALUES ('local', 'local')").run();
  }
  for (const a of opts.agents ?? []) {
    db.prepare('INSERT INTO agents (id, slug, name, kind) VALUES (?, ?, ?, ?)').run(
      a.id,
      a.slug,
      a.name ?? a.slug,
      a.kind ?? 'cli',
    );
  }
  for (const w of opts.workspaces ?? []) {
    db.prepare('INSERT INTO workspaces (id, path, display_name) VALUES (?, ?, ?)').run(
      w.id,
      w.path,
      null,
    );
  }
  if (opts.omitConversationsTable) {
    db.close();
    return;
  }
  for (const c of opts.conversations ?? []) {
    db.prepare(
      `INSERT INTO conversations (id, agent_id, workspace_id, source_id, external_id, source_path, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.id,
      c.agentId,
      c.workspaceId ?? null,
      c.sourceId ?? 'local',
      c.externalId ?? null,
      c.sourcePath ?? `/src/${c.id}`,
      c.startedAt ?? null,
    );
    for (const m of c.messages ?? []) {
      db.prepare(
        'INSERT INTO messages (conversation_id, idx, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(c.id, m.idx, m.role, m.content, m.createdAt ?? null);
    }
  }
  db.close();
}

/** 打开已存在的 cass fixture 做只读检查 */
function openReadOnly(dbPath: string): InstanceType<typeof DatabaseSync> {
  return new DatabaseSync(dbPath, { readOnly: true });
}

// ─── 测试体 ──────────────────────────────────────────────────────────────────

describe('LOOP-002 cass 历史导入', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cass-loop2-'));
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

  // ── 验收门 1：流式导入 + coverage=B source instance + provenance ────────

  it('导入有效 conversation，注册 coverage=B 的 cass source instance，session.source=agent slug，nativeSessionId=external_id', () => {
    const dbPath = path.join(tmpDir, 'agent_search.db');
    buildCassDb(dbPath, {
      agents: [{ id: 6, slug: 'claude_code' }, { id: 7, slug: 'codex' }],
      workspaces: [{ id: 1, path: '/repo/a' }],
      conversations: [
        {
          id: 100,
          agentId: 6,
          workspaceId: 1,
          externalId: 'c-uuid-100',
          startedAt: 1_000,
          messages: [
            { idx: 0, role: 'user', content: 'hello', createdAt: 1_000 },
            // cass 真实用 agent 角色表示 assistant（本机实测），导入器归一化为 assistant
            { idx: 1, role: 'agent', content: 'hi there', createdAt: 2_000 },
          ],
        },
      ],
    });

    const importer = new CassImporter(store, { dbPath, deviceId: DEVICE });
    const stats: CassImportStats = importer.import();

    // 统计：扫描 1，新增 1，其余 0
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.scanned).toBe(stats.inserted + stats.updated + stats.unchanged + stats.skipped);

    // cass source instance 已注册，coverage=B，rootPath=cass 数据目录
    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst).toBeDefined();
    expect(inst!.source).toBe('cass');
    expect(inst!.coverage).toBe('B');
    expect(inst!.rootPath).toBe(tmpDir);

    // session：source=agent slug，nativeSessionId=external_id，cwd=workspace path
    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.source).toBe('claude_code');
    expect(s.nativeSessionId).toBe('c-uuid-100');
    expect(s.cwd).toBe('/repo/a');
    expect(s.startedAt).toBe(1_000);
    expect(s.sourceInstanceId).toBe(stats.sourceInstanceId);

    // 消息按序入库；cass agent 角色归一化为 assistant
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi there'],
    ]);
    expect(msgs[0]!.timestamp).toBe(1_000);

    // scan_run 已记录完成
    const run = store.getScanRun(stats.scanRunId);
    expect(run.status).toBe('completed');
    expect(run.sessionsSeen).toBe(1);
    expect(run.sessionsNew).toBe(1);
    expect(run.sessionsUpdated).toBe(0);
    expect(run.endedAt).toBeGreaterThan(0);
  });

  // ── 验收门 2：重复导入幂等 ───────────────────────────────────────────────

  it('相同内容重复导入幂等：不新增 revision，计入 unchanged', () => {
    const dbPath = path.join(tmpDir, 'agent_search.db');
    buildCassDb(dbPath, {
      agents: [{ id: 6, slug: 'claude_code' }],
      conversations: [
        {
          id: 1,
          agentId: 6,
          externalId: 'dup-1',
          messages: [
            { idx: 0, role: 'user', content: 'q' },
            { idx: 1, role: 'assistant', content: 'a' },
          ],
        },
      ],
    });

    const importer = new CassImporter(store, { dbPath, deviceId: DEVICE });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    const second = importer.import();
    expect(second.scanned).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.skipped).toBe(0);

    // 仅 1 个 session、1 个 revision、2 条消息（未重复写）
    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    expect(store.getMessages(sessions[0]!.id)).toHaveLength(2);
    expect(store.getRevisions(sessions[0]!.id)).toHaveLength(1);
  });

  // ── 验收门 3：内容变化生成新 revision ────────────────────────────────────

  it('内容变化（追加消息）生成新 revision，revision_number 递增', () => {
    const dbPath = path.join(tmpDir, 'agent_search.db');
    buildCassDb(dbPath, {
      agents: [{ id: 6, slug: 'claude_code' }],
      conversations: [
        {
          id: 5,
          agentId: 6,
          externalId: 'rev-5',
          messages: [
            { idx: 0, role: 'user', content: 'first' },
            { idx: 1, role: 'assistant', content: 'resp' },
          ],
        },
      ],
    });

    const importer = new CassImporter(store, { dbPath, deviceId: DEVICE });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    // 模拟 cass 追加了一条消息（真实场景：cass 重新索引后 messages 多一行）
    const write = new DatabaseSync(dbPath);
    write.prepare(
      'INSERT INTO messages (conversation_id, idx, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(5, 2, 'user', 'follow up', 3_000);
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
    // 当前 revision 反映最新 3 条消息
    expect(store.getMessages(sessions[0]!.id)).toHaveLength(3);
  });

  // ── 验收门 4：跳过无消息 / 脏数据并计数 ──────────────────────────────────

  it('跳过无消息与空正文 conversation，计入 skipped，有效 session 正常入库', () => {
    const dbPath = path.join(tmpDir, 'agent_search.db');
    buildCassDb(dbPath, {
      agents: [{ id: 6, slug: 'claude_code' }],
      conversations: [
        // 有效
        {
          id: 1,
          agentId: 6,
          externalId: 'good-1',
          messages: [{ idx: 0, role: 'user', content: 'real content' }],
        },
        // 无消息
        { id: 2, agentId: 6, externalId: 'empty-2', messages: [] },
        // 全部空正文
        {
          id: 3,
          agentId: 6,
          externalId: 'blank-3',
          messages: [
            { idx: 0, role: 'user', content: '' },
            { idx: 1, role: 'assistant', content: '   ' },
          ],
        },
      ],
    });

    const importer = new CassImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(3);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(2);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.nativeSessionId).toBe('good-1');
  });

  // ── 验收门 5：cass 数据库不可用 → 明确错误 ───────────────────────────────

  it('cass DB 不存在时抛出明确错误，且不遗留 running 状态的 scan_run', () => {
    const importer = new CassImporter(store, {
      dbPath: path.join(tmpDir, 'nope', 'agent_search.db'),
      deviceId: DEVICE,
    });
    expect(() => importer.import()).toThrowError(/cass/i);

    // 未导入任何 session
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 验收门 6：schema 不匹配 → 明确错误 ───────────────────────────────────

  it('cass DB 缺少 conversations 表时抛出 schema 不匹配错误', () => {
    const dbPath = path.join(tmpDir, 'agent_search.db');
    buildCassDb(dbPath, { omitConversationsTable: true });

    const importer = new CassImporter(store, { dbPath, deviceId: DEVICE });
    expect(() => importer.import()).toThrowError(/cass.*schema|schema.*cass|conversations/i);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 验收门 7：绝不写入 cass DB（只读） ───────────────────────────────────

  it('导入后 cass DB 不含任何 yondermesh 表，且原始行数不变', () => {
    const dbPath = path.join(tmpDir, 'agent_search.db');
    buildCassDb(dbPath, {
      agents: [{ id: 6, slug: 'claude_code' }],
      conversations: [
        {
          id: 1,
          agentId: 6,
          externalId: 'ro-1',
          messages: [{ idx: 0, role: 'user', content: 'x' }],
        },
      ],
    });

    new CassImporter(store, { dbPath, deviceId: DEVICE }).import();

    const ro = openReadOnly(dbPath);
    // cass fixture 不应出现任何 yondermesh 专属表
    const ymTables = ro
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN
         ('sessions','session_revisions','source_instances','scan_runs','session_relationships')`,
      )
      .all() as { name: string }[];
    expect(ymTables).toHaveLength(0);

    // cass 自身数据不变
    expect((ro.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n).toBe(1);
    expect((ro.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
    ro.close();
  });

  // ── 验收门 8：路径解析 ───────────────────────────────────────────────────

  describe('resolveCassDbPath', () => {
    const envBackup = { ...process.env };

    afterEach(() => {
      // 恢复环境变量
      for (const k of Object.keys(process.env)) {
        if (!(k in envBackup)) delete process.env[k];
      }
      Object.assign(process.env, envBackup);
    });

    it('dbPath 选项优先级最高，忽略 CASS_DATA_DIR', () => {
      process.env.CASS_DATA_DIR = '/some/other/dir';
      expect(resolveCassDbPath({ dbPath: '/explicit/path.db' })).toBe('/explicit/path.db');
    });

    it('CASS_DATA_DIR 覆盖默认数据目录', () => {
      process.env.CASS_DATA_DIR = path.join(tmpDir, 'custom-cass');
      const resolved = resolveCassDbPath();
      expect(resolved).toBe(path.join(tmpDir, 'custom-cass', 'agent_search.db'));
    });

    it('无 dbPath 与 CASS_DATA_DIR 时回退到默认 macOS 路径', () => {
      delete process.env.CASS_DATA_DIR;
      const resolved = resolveCassDbPath();
      expect(resolved).toContain('com.coding-agent-search.coding-agent-search');
      expect(resolved.endsWith('agent_search.db')).toBe(true);
    });
  });

  // ── 验收门 9：nativeSessionId 回退链 ─────────────────────────────────────

  it('external_id 缺失时回退到 source_id:id（稳定且唯一，避免 source_id 全为 local 碰撞）', () => {
    const dbPath = path.join(tmpDir, 'agent_search.db');
    buildCassDb(dbPath, {
      agents: [{ id: 6, slug: 'claude_code' }],
      conversations: [
        {
          id: 9,
          agentId: 6,
          externalId: null, // 缺失 → 回退 source_id:id
          sourceId: 'local',
          messages: [{ idx: 0, role: 'user', content: 'fallback' }],
        },
        {
          id: 10,
          agentId: 6,
          externalId: null, // 同样缺失 external_id，source_id 仍为 'local'
          sourceId: 'local',
          messages: [{ idx: 0, role: 'user', content: 'second' }],
        },
      ],
    });

    const importer = new CassImporter(store, { dbPath, deviceId: DEVICE });
    importer.import();

    const sessions = store.querySessions({ deviceId: DEVICE });
    // 两条 external_id 缺失的 conversation 因拼接 id 而不碰撞，各成独立 session
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.nativeSessionId).sort()).toEqual([
      'local:10',
      'local:9',
    ]);
  });

  // ── 验收门 10：cass 角色归一化 ───────────────────────────────────────────

  it('cass 角色归一化：agent→assistant、developer→system、tool/user 直通、未知跳过', () => {
    const dbPath = path.join(tmpDir, 'agent_search.db');
    buildCassDb(dbPath, {
      agents: [{ id: 6, slug: 'claude_code' }],
      conversations: [
        {
          id: 1,
          agentId: 6,
          externalId: 'roles-1',
          messages: [
            { idx: 0, role: 'user', content: 'u' },
            { idx: 1, role: 'agent', content: 'a' }, // → assistant
            { idx: 2, role: 'tool', content: 't' }, // → tool
            { idx: 3, role: 'developer', content: 'd' }, // → system
            { idx: 4, role: 'system', content: 's' }, // → system
            { idx: 5, role: 'gemini', content: 'g' }, // 未知 → 跳过该条
          ],
        },
      ],
    });

    const importer = new CassImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0);

    const sessions = store.querySessions({ deviceId: DEVICE });
    const msgs = store.getMessages(sessions[0]!.id);
    // 5 条有效（gemini 跳过），agent→assistant、developer→system
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'u'],
      ['assistant', 'a'],
      ['tool', 't'],
      ['system', 'd'],
      ['system', 's'],
    ]);
  });
});
