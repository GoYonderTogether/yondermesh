/**
 * Antigravity 原生 adapter 契约测试
 *
 * 覆盖验收门：
 *   1. 导入有效 conversation（transcript.jsonl 优先）：coverage=A，source='antigravity'
 *   2. transcript 缺失时回退 preview 字段，仍入库
 *   3. 重复扫描幂等：不新增 revision
 *   4. 内容变化（追加 transcript 行）生成新 revision
 *   5. 跳过无消息 conversation（既无 transcript 又无 preview）
 *   6. DB 不存在 → 明确错误
 *   7. schema 不匹配 → 明确错误
 *   8. 绝不写入 Antigravity DB（只读）
 *   9. 路径解析：dbPath 优先 / ANTIGRAVITY_DATA_DIR 覆盖 / 默认 macOS 路径
 *  10. parent_conversation_id + nesting_depth 拓扑：subagent + spawned_by 关系
 *  11. battle_id + winning_conversation_id → sidechain_of 关系
 *  12. killed 计数
 *
 * fixture：在临时 SQLite 文件上构建 conversation_summaries 表（17 列）+ 临时 transcript.jsonl。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { AntigravityImporter, resolveAntigravityDbPath } from '../src/antigravity/index.js';
import type { AntigravityImportStats } from '../src/antigravity/index.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');

const DEVICE = 'mac-test';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

interface FixtureConv {
  conversation_id: string;
  title?: string | null;
  preview?: string | null;
  step_count?: number | null;
  last_modified_time?: number | null;
  workspace_uris?: string | null;
  status?: string | null;
  source?: string | null;
  project_id?: string | null;
  agent_name?: string | null;
  parent_conversation_id?: string | null;
  nesting_depth?: number | null;
  battle_id?: string | null;
  winning_conversation_id?: string | null;
  not_fully_idle?: number | null;
  killed?: number | null;
  last_user_input_time?: number | null;
  last_user_input_step_index?: number | null;
  app_data_dir?: string | null;
  /** transcript.jsonl 内容（行数组）；提供则写入 app_data_dir/transcript.jsonl */
  transcript?: string[];
}

/** 在 dbPath 创建 conversation_summaries 表（17 列）并写入样本数据 */
function buildAntigravityDb(
  dbPath: string,
  opts: {
    conversations?: FixtureConv[];
    omitTable?: boolean;
    dropColumn?: string;
  } = {},
): void {
  const db = new DatabaseSync(dbPath);

  if (opts.omitTable) {
    db.close();
    return;
  }

  // 构造列声明（按需省略某列测 schema 校验）
  const allCols: Array<[string, string]> = [
    ['conversation_id', 'TEXT PRIMARY KEY'],
    ['title', 'TEXT'],
    ['preview', 'TEXT'],
    ['step_count', 'INTEGER'],
    ['last_modified_time', 'INTEGER'],
    ['workspace_uris', 'TEXT'],
    ['status', 'TEXT'],
    ['source', 'TEXT'],
    ['project_id', 'TEXT'],
    ['agent_name', 'TEXT'],
    ['parent_conversation_id', 'TEXT'],
    ['nesting_depth', 'INTEGER'],
    ['battle_id', 'TEXT'],
    ['winning_conversation_id', 'TEXT'],
    ['not_fully_idle', 'INTEGER'],
    ['killed', 'INTEGER'],
    ['last_user_input_time', 'INTEGER'],
    ['last_user_input_step_index', 'INTEGER'],
    ['app_data_dir', 'TEXT'],
  ];
  const cols = allCols.filter(([c]) => c !== opts.dropColumn);
  db.exec(`CREATE TABLE conversation_summaries (${cols.map(([n, t]) => `${n} ${t}`).join(', ')})`);

  for (const c of opts.conversations ?? []) {
    // 若提供 transcript，写入临时 app_data_dir
    let appDataDir = c.app_data_dir ?? null;
    if (c.transcript && c.transcript.length > 0) {
      appDataDir = appDataDir ?? path.join(path.dirname(dbPath), 'transcripts', c.conversation_id);
      fs.mkdirSync(appDataDir, { recursive: true });
      fs.writeFileSync(
        path.join(appDataDir, 'transcript.jsonl'),
        c.transcript.join('\n') + '\n',
        'utf-8',
      );
    }

    const colNames = [
      'conversation_id', 'title', 'preview', 'step_count', 'last_modified_time',
      'workspace_uris', 'status', 'source', 'project_id', 'agent_name',
      'parent_conversation_id', 'nesting_depth', 'battle_id', 'winning_conversation_id',
      'not_fully_idle', 'killed', 'last_user_input_time', 'last_user_input_step_index',
      'app_data_dir',
    ];
    const placeholders = colNames.map(() => '?').join(', ');
    db.prepare(
      `INSERT INTO conversation_summaries (${colNames.join(', ')}) VALUES (${placeholders})`,
    ).run(
      c.conversation_id,
      c.title ?? null,
      c.preview ?? null,
      c.step_count ?? null,
      c.last_modified_time ?? null,
      c.workspace_uris ?? null,
      c.status ?? null,
      c.source ?? null,
      c.project_id ?? null,
      c.agent_name ?? null,
      c.parent_conversation_id ?? null,
      c.nesting_depth ?? null,
      c.battle_id ?? null,
      c.winning_conversation_id ?? null,
      c.not_fully_idle ?? null,
      c.killed ?? null,
      c.last_user_input_time ?? null,
      c.last_user_input_step_index ?? null,
      appDataDir,
    );
  }
  db.close();
}

/** 打开已存在的 Antigravity fixture 做只读检查 */
function openReadOnly(dbPath: string): InstanceType<typeof DatabaseSync> {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** 构造 transcript 事件 JSON 行 */
function transcriptLine(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

// ─── 测试体 ──────────────────────────────────────────────────────────────────

describe('Antigravity 原生 adapter 契约测试', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-test-'));
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

  // ── 验收门 1：transcript.jsonl 优先导入 ──────────────────────────────────

  it('导入有效 conversation（transcript.jsonl 优先）：coverage=A，nativeSessionId=conversation_id', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [
        {
          conversation_id: 'conv-aaa',
          title: 'Test Conv',
          workspace_uris: 'file:///repo/a',
          agent_name: 'antigravity-cli/1.1.2',
          last_modified_time: 1_700_000_000_000,
          transcript: [
            transcriptLine({ role: 'user', content: 'hello antigravity', timestamp: 1_700_000_000_000 }),
            transcriptLine({ role: 'model', content: 'hi back', timestamp: 1_700_000_001_000 }),
          ],
        },
      ],
    });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    const stats: AntigravityImportStats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.transcriptsRead).toBe(1);
    expect(stats.transcriptFallbacks).toBe(0);

    // source instance：coverage=A
    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst).toBeDefined();
    expect(inst!.source).toBe('antigravity');
    expect(inst!.coverage).toBe('A');

    // session：nativeSessionId=conversation_id，cwd=workspace
    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.source).toBe('antigravity');
    expect(s.nativeSessionId).toBe('conv-aaa');
    expect(s.cwd).toBe('/repo/a');
    expect(s.projectPath).toBe('/repo/a');
    expect(s.topology).toBe('root');
    expect(s.cliVersion).toBe('antigravity-cli/1.1.2');

    // 消息按序入库
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello antigravity'],
      ['assistant', 'hi back'],
    ]);
  });

  // ── 验收门 2：transcript 缺失回退 preview ────────────────────────────────

  it('transcript 缺失时回退 preview 字段，仍入库', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [
        {
          conversation_id: 'conv-preview',
          preview: 'this is a preview',
          last_modified_time: 1_000,
          // 无 transcript
        },
      ],
    });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.inserted).toBe(1);
    expect(stats.transcriptsRead).toBe(0);
    expect(stats.transcriptFallbacks).toBe(1);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const msgs = store.getMessages(sessions[0]!.id);
    // preview 作为单条 user 消息
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('this is a preview');
  });

  // ── 验收门 3：重复扫描幂等 ───────────────────────────────────────────────

  it('相同内容重复导入幂等：不新增 revision', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [
        {
          conversation_id: 'dup-1',
          transcript: [
            transcriptLine({ role: 'user', content: 'q' }),
            transcriptLine({ role: 'model', content: 'a' }),
          ],
        },
      ],
    });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    const second = importer.import();
    expect(second.scanned).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    expect(store.getRevisions(sessions[0]!.id)).toHaveLength(1);
  });

  // ── 验收门 4：内容变化生成新 revision ────────────────────────────────────

  it('transcript 追加内容生成新 revision', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [
        {
          conversation_id: 'rev-1',
          transcript: [
            transcriptLine({ role: 'user', content: 'first' }),
          ],
        },
      ],
    });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    importer.import();

    // 追加 transcript 行
    const conv = store.querySessions({ deviceId: DEVICE })[0]!;
    // 通过 store 反查不到 app_data_dir，直接读 fixture 的 transcripts 目录
    const transcriptPath = path.join(tmpDir, 'transcripts', 'rev-1', 'transcript.jsonl');
    fs.appendFileSync(transcriptPath, transcriptLine({ role: 'model', content: 'reply' }) + '\n', 'utf-8');

    const second = importer.import();
    expect(second.updated).toBe(1);

    const revs = store.getRevisions(conv.id);
    expect(revs.map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(store.getMessages(conv.id)).toHaveLength(2);
  });

  // ── 验收门 5：跳过无消息 conversation ────────────────────────────────────

  it('跳过既无 transcript 又无 preview 的 conversation', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [
        { conversation_id: 'empty-1' }, // 无 transcript 无 preview
      ],
    });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  // ── 验收门 6：DB 不存在 → 明确错误 ───────────────────────────────────────

  it('Antigravity DB 不存在时抛出明确错误', () => {
    const importer = new AntigravityImporter(store, {
      dbPath: path.join(tmpDir, 'nope', 'conversation_summaries.db'),
      deviceId: DEVICE,
    });
    expect(() => importer.import()).toThrowError(/antigravity/i);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 验收门 7：schema 不匹配 → 明确错误 ───────────────────────────────────

  it('Antigravity DB 缺少 conversation_summaries 表时抛出 schema 错误', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, { omitTable: true });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    expect(() => importer.import()).toThrowError(/antigravity.*schema|schema.*antigravity|conversation_summaries/i);
  });

  it('Antigravity DB 缺少 parent_conversation_id 列时抛出 schema 错误', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [],
      dropColumn: 'parent_conversation_id',
    });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    expect(() => importer.import()).toThrowError(/schema|parent_conversation_id/i);
  });

  // ── 验收门 8：绝不写入 Antigravity DB ────────────────────────────────────

  it('导入后 Antigravity DB 不含任何 yondermesh 专属表，且原始行数不变', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [
        {
          conversation_id: 'ro-1',
          transcript: [transcriptLine({ role: 'user', content: 'x' })],
        },
      ],
    });

    new AntigravityImporter(store, { dbPath, deviceId: DEVICE }).import();

    const ro = openReadOnly(dbPath);
    const ymTables = ro
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN
         ('session_revisions','source_instances','scan_runs','session_relationships')`,
      )
      .all() as { name: string }[];
    expect(ymTables).toHaveLength(0);
    expect(
      (ro.prepare('SELECT COUNT(*) AS n FROM conversation_summaries').get() as { n: number }).n,
    ).toBe(1);
    ro.close();
  });

  // ── 验收门 9：路径解析 ───────────────────────────────────────────────────

  describe('resolveAntigravityDbPath', () => {
    const envBackup = { ...process.env };

    afterEach(() => {
      for (const k of Object.keys(process.env)) {
        if (!(k in envBackup)) delete process.env[k];
      }
      Object.assign(process.env, envBackup);
    });

    it('dbPath 选项优先级最高', () => {
      process.env.ANTIGRAVITY_DATA_DIR = '/some/other/dir';
      expect(resolveAntigravityDbPath({ dbPath: '/explicit/path.db' })).toBe('/explicit/path.db');
    });

    it('ANTIGRAVITY_DATA_DIR 覆盖默认数据目录', () => {
      process.env.ANTIGRAVITY_DATA_DIR = path.join(tmpDir, 'custom-agy');
      const resolved = resolveAntigravityDbPath();
      expect(resolved).toBe(path.join(tmpDir, 'custom-agy', 'conversation_summaries.db'));
    });

    it('无选项时回退到默认 macOS 路径', () => {
      delete process.env.ANTIGRAVITY_DATA_DIR;
      const resolved = resolveAntigravityDbPath();
      expect(resolved).toContain('Antigravity');
      expect(resolved.endsWith('conversation_summaries.db')).toBe(true);
    });
  });

  // ── 验收门 10：parent_conversation_id + nesting_depth 拓扑 ───────────────

  it('parent_conversation_id 非空 + nesting_depth>0 → subagent + spawned_by 关系', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [
        {
          conversation_id: 'root-1',
          nesting_depth: 0,
          transcript: [transcriptLine({ role: 'user', content: 'parent' })],
        },
        {
          conversation_id: 'sub-1',
          parent_conversation_id: 'root-1',
          nesting_depth: 1,
          transcript: [transcriptLine({ role: 'user', content: 'child1' })],
        },
        {
          conversation_id: 'sub-2',
          parent_conversation_id: 'root-1',
          nesting_depth: 2,
          transcript: [transcriptLine({ role: 'user', content: 'child2' })],
        },
      ],
    });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.inserted).toBe(3);
    expect(stats.subagents).toBe(2);
    expect(stats.spawnedByRelationships).toBe(2);
    expect(stats.unlinkedSubagents).toBe(0);

    const sessions = store.querySessions({ deviceId: DEVICE });
    const subs = sessions.filter((s) => s.topology === 'subagent');
    expect(subs).toHaveLength(2);
    const roots = sessions.filter((s) => s.topology === 'root');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.nativeSessionId).toBe('root-1');
  });

  it('parent 不存在 → unlinkedSubagents 计数，不建关系', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [
        {
          conversation_id: 'orphan-1',
          parent_conversation_id: 'ghost-parent',
          nesting_depth: 1,
          transcript: [transcriptLine({ role: 'user', content: 'orphan' })],
        },
      ],
    });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.subagents).toBe(1);
    expect(stats.unlinkedSubagents).toBe(1);
    expect(stats.spawnedByRelationships).toBe(0);
  });

  // ── 验收门 11：battle_id + winning_conversation_id → sidechain_of ────────

  it('battle 模式：非 winner → winner 建 sidechain_of 关系', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [
        {
          conversation_id: 'battle-winner',
          battle_id: 'battle-1',
          winning_conversation_id: 'battle-winner',
          transcript: [transcriptLine({ role: 'user', content: 'winner' })],
        },
        {
          conversation_id: 'battle-loser-1',
          battle_id: 'battle-1',
          winning_conversation_id: 'battle-winner',
          transcript: [transcriptLine({ role: 'user', content: 'loser1' })],
        },
        {
          conversation_id: 'battle-loser-2',
          battle_id: 'battle-1',
          winning_conversation_id: 'battle-winner',
          transcript: [transcriptLine({ role: 'user', content: 'loser2' })],
        },
      ],
    });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.inserted).toBe(3);
    expect(stats.battles).toBe(3);
    // 2 个 loser 各建一条 sidechain_of → winner
    expect(stats.sidechainRelationships).toBe(2);
  });

  // ── 验收门 12：killed 计数 ──────────────────────────────────────────────

  it('killed 非零的 conversation 仍入库但计入 killed', () => {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    buildAntigravityDb(dbPath, {
      conversations: [
        {
          conversation_id: 'live-1',
          killed: 0,
          transcript: [transcriptLine({ role: 'user', content: 'live' })],
        },
        {
          conversation_id: 'killed-1',
          killed: 1,
          transcript: [transcriptLine({ role: 'user', content: 'killed' })],
        },
      ],
    });

    const importer = new AntigravityImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(2);
    expect(stats.killed).toBe(1);
    expect(stats.inserted).toBe(2);
  });
});
