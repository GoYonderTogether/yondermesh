/**
 * Cline 原生 importer 测试（覆盖等级 A）
 *
 * 覆盖：
 *   1. SQLite 通道：sessions.db + transcript_path JSONL → 入库 + coverage=A source instance
 *   2. JSON 回退通道：sessionsDir/<id>/*.json → 入库，sourceChannel='json'
 *   3. 拓扑：is_subagent=1 或 parent_session_id 非空 → subagent；否则 root
 *   4. spawned_by 关系：subagent 的 parent 在同次扫描已入库时写关系
 *   5. 幂等：重复导入内容不变计入 unchanged
 *   6. 跳过：无有效消息的 session 计入 skipped
 *   7. schema 不匹配 → 明确错误
 *   8. 路径解析：dbPath 选项优先 / dataDir 拼接
 *
 * fixture：在临时 SQLite 文件上构建 Cline 最小 schema（sessions 表），
 * transcript 用 NDJSON 文件模拟；不依赖真实 Cline 安装。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { ClineImporter, resolveClineDbPath, resolveClineSessionsDir } from '../src/cline/index.js';
import type { ClineImportStats } from '../src/cline/index.js';

// node:sqlite 实验性内置，vitest 会误判为裸包；用 createRequire 运行时加载（同 store）
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');

const DEVICE = 'mac-test';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

interface FixtureSession {
  sessionId: string;
  source?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  status?: string | null;
  provider?: string | null;
  model?: string | null;
  cwd?: string | null;
  workspaceRoot?: string | null;
  parentSessionId?: string | null;
  parentAgentId?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
  isSubagent?: number | null;
  prompt?: string | null;
  /** transcript 文件绝对路径；不传则不写消息文件 */
  transcriptPath?: string | null;
  messagesPath?: string | null;
  updatedAt?: string | null;
}

interface FixtureTranscriptLine {
  type?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  isMeta?: boolean;
}

/** 在 dbPath 创建 Cline sessions 表并写入样本数据 */
function buildClineDb(
  dbPath: string,
  sessions: FixtureSession[],
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      source TEXT,
      started_at TEXT,
      ended_at TEXT,
      status TEXT,
      provider TEXT,
      model TEXT,
      cwd TEXT,
      workspace_root TEXT,
      parent_session_id TEXT,
      parent_agent_id TEXT,
      agent_id TEXT,
      conversation_id TEXT,
      is_subagent INTEGER,
      prompt TEXT,
      transcript_path TEXT,
      messages_path TEXT,
      updated_at TEXT
    );
  `);
  const stmt = db.prepare(
    `INSERT INTO sessions
     (session_id, source, started_at, ended_at, status, provider, model, cwd, workspace_root,
      parent_session_id, parent_agent_id, agent_id, conversation_id, is_subagent, prompt,
      transcript_path, messages_path, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of sessions) {
    stmt.run(
      s.sessionId,
      s.source ?? null,
      s.startedAt ?? null,
      s.endedAt ?? null,
      s.status ?? null,
      s.provider ?? null,
      s.model ?? null,
      s.cwd ?? null,
      s.workspaceRoot ?? null,
      s.parentSessionId ?? null,
      s.parentAgentId ?? null,
      s.agentId ?? null,
      s.conversationId ?? null,
      s.isSubagent ?? null,
      s.prompt ?? null,
      s.transcriptPath ?? null,
      s.messagesPath ?? null,
      s.updatedAt ?? null,
    );
  }
  db.close();
}

/** 写一个 NDJSON transcript 文件 */
function writeNdjsonTranscript(filePath: string, lines: FixtureTranscriptLine[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, text, 'utf-8');
}

/** 写一个 JSON 数组 transcript 文件 */
function writeJsonArrayTranscript(filePath: string, lines: FixtureTranscriptLine[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(lines), 'utf-8');
}

/** 用户/助手消息对（content 数组形态，Cline 常见） */
function userMsg(text: string, ts = '2026-07-15T10:00:00Z'): FixtureTranscriptLine {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: ts };
}
function assistantMsg(text: string, ts = '2026-07-15T10:00:05Z'): FixtureTranscriptLine {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts };
}

// ─── 测试体 ──────────────────────────────────────────────────────────────────

describe('Cline 原生 importer', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-imp-'));
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

  // ── 1. SQLite 通道 ──────────────────────────────────────────────────────

  it('SQLite 通道：sessions.db + transcript_path NDJSON → 入库，coverage=A，sourceChannel=db', () => {
    const transcriptPath = path.join(tmpDir, 'transcripts', 's1.jsonl');
    writeNdjsonTranscript(transcriptPath, [
      userMsg('hello cline'),
      assistantMsg('hi there'),
    ]);

    const dbPath = path.join(tmpDir, 'data', 'db', 'sessions.db');
    buildClineDb(dbPath, [
      {
        sessionId: 's1',
        source: 'cli',
        startedAt: '2026-07-15T10:00:00Z',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        cwd: '/repo/cline',
        workspaceRoot: '/repo/cline',
        transcriptPath,
      },
    ]);

    const importer = new ClineImporter(store, { dbPath, deviceId: DEVICE });
    const stats: ClineImportStats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.sourceChannel).toBe('db');
    expect(stats.subagents).toBe(0);
    expect(stats.relationships).toBe(0);

    // coverage=A source instance
    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst).toBeDefined();
    expect(inst!.source).toBe('cline');
    expect(inst!.coverage).toBe('A');

    // session 字段
    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.source).toBe('cline');
    expect(s.nativeSessionId).toBe('s1');
    expect(s.cwd).toBe('/repo/cline');
    expect(s.topology).toBe('root');
    expect(s.model).toBe('claude-sonnet-4');
    expect(s.entrySource).toBe('cli');

    // 消息
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello cline'],
      ['assistant', 'hi there'],
    ]);
  });

  // ── 2. JSON 数组 transcript 兼容 ────────────────────────────────────────

  it('JSON 数组 transcript 文件也能正确解析消息', () => {
    const transcriptPath = path.join(tmpDir, 't-arr.json');
    writeJsonArrayTranscript(transcriptPath, [
      userMsg('arr hello'),
      assistantMsg('arr reply'),
    ]);

    const dbPath = path.join(tmpDir, 'sessions.db');
    buildClineDb(dbPath, [
      { sessionId: 'arr-s', transcriptPath },
    ]);

    const importer = new ClineImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();
    expect(stats.inserted).toBe(1);

    const sessions = store.querySessions({ deviceId: DEVICE });
    const msgs = store.getMessages(sessions[0]!.id);
    expect(msgs.map((m) => m.content)).toEqual(['arr hello', 'arr reply']);
  });

  // ── 3. JSON 回退通道（无 sessions.db，仅 sessionsDir/<id>/*.json） ───────

  it('JSON 回退通道：sessionsDir/<id>/*.json → sourceChannel=json', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const sessionDir = path.join(sessionsDir, 'json-s1');
    // 两个段文件，按文件名排序合并
    writeNdjsonTranscript(path.join(sessionDir, '01.json'), [
      userMsg('seg1 q'),
    ]);
    writeNdjsonTranscript(path.join(sessionDir, '02.json'), [
      assistantMsg('seg2 a'),
    ]);

    // dbPath 不存在，sessionsDir 存在 → 走 JSON 回退
    const dbPath = path.join(tmpDir, 'data', 'db', 'sessions.db');
    const importer = new ClineImporter(store, {
      dbPath,
      sessionsDir,
      deviceId: DEVICE,
    });
    const stats = importer.import();

    expect(stats.sourceChannel).toBe('json');
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.nativeSessionId).toBe('json-s1');
    const msgs = store.getMessages(sessions[0]!.id);
    expect(msgs.map((m) => m.content)).toEqual(['seg1 q', 'seg2 a']);
  });

  // ── 4. 拓扑 + spawned_by 关系 ──────────────────────────────────────────

  it('is_subagent=1 的 session 标为 subagent，parent 在同次扫描 → 写 spawned_by 关系', () => {
    const rootTranscript = path.join(tmpDir, 'root.jsonl');
    const subTranscript = path.join(tmpDir, 'sub.jsonl');
    writeNdjsonTranscript(rootTranscript, [userMsg('root q'), assistantMsg('root a')]);
    writeNdjsonTranscript(subTranscript, [userMsg('sub q'), assistantMsg('sub a')]);

    const dbPath = path.join(tmpDir, 'sessions.db');
    buildClineDb(dbPath, [
      {
        sessionId: 'root-1',
        startedAt: '2026-07-15T10:00:00Z',
        cwd: '/repo',
        transcriptPath: rootTranscript,
      },
      {
        sessionId: 'sub-1',
        startedAt: '2026-07-15T10:01:00Z',
        cwd: '/repo',
        parentSessionId: 'root-1',
        isSubagent: 1,
        transcriptPath: subTranscript,
      },
    ]);

    const importer = new ClineImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(2);
    expect(stats.subagents).toBe(1);
    expect(stats.unlinkedSubagents).toBe(0);
    expect(stats.relationships).toBe(1);

    const sessions = store.querySessions({ deviceId: DEVICE });
    const root = sessions.find((s) => s.nativeSessionId === 'root-1')!;
    const sub = sessions.find((s) => s.nativeSessionId === 'sub-1')!;
    expect(root.topology).toBe('root');
    expect(sub.topology).toBe('subagent');

    // spawned_by 关系：sub → root（outgoing）
    const rels = store.queryRelationships(sub.id);
    const outgoing = rels.filter((r) => r.direction === 'outgoing' && r.relationType === 'spawned_by');
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.toSessionId).toBe(root.id);
  });

  it('parent 未入库的 subagent → unlinkedSubagents，不写关系', () => {
    const subTranscript = path.join(tmpDir, 'orphan-sub.jsonl');
    writeNdjsonTranscript(subTranscript, [userMsg('orphan q'), assistantMsg('orphan a')]);

    const dbPath = path.join(tmpDir, 'sessions.db');
    buildClineDb(dbPath, [
      {
        sessionId: 'orphan-sub',
        parentSessionId: 'missing-parent',
        isSubagent: 1,
        transcriptPath: subTranscript,
      },
    ]);

    const importer = new ClineImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();
    expect(stats.subagents).toBe(1);
    expect(stats.unlinkedSubagents).toBe(1);
    expect(stats.relationships).toBe(0);
  });

  // ── 5. 幂等 ─────────────────────────────────────────────────────────────

  it('重复导入相同内容幂等：inserted=1 → unchanged=1', () => {
    const transcriptPath = path.join(tmpDir, 'dup.jsonl');
    writeNdjsonTranscript(transcriptPath, [userMsg('dup q'), assistantMsg('dup a')]);

    const dbPath = path.join(tmpDir, 'sessions.db');
    buildClineDb(dbPath, [
      { sessionId: 'dup-1', transcriptPath },
    ]);

    const importer = new ClineImporter(store, { dbPath, deviceId: DEVICE });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    const second = importer.import();
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  // ── 6. 跳过无消息 session ───────────────────────────────────────────────

  it('transcript 文件无有效消息 → skipped', () => {
    const emptyTranscript = path.join(tmpDir, 'empty.jsonl');
    // 只有 meta 行和 tool 事件，无可显示文本
    writeNdjsonTranscript(emptyTranscript, [
      { isMeta: true, type: 'system', message: { role: 'system' } },
      { type: 'tool', message: { role: 'tool', content: 'tool output' } },
    ]);

    const dbPath = path.join(tmpDir, 'sessions.db');
    buildClineDb(dbPath, [
      { sessionId: 'empty-s', transcriptPath: emptyTranscript },
      { sessionId: 'no-file-s' }, // 无 transcript 文件
    ]);

    const importer = new ClineImporter(store, { dbPath, deviceId: DEVICE });
    const stats = importer.import();
    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(2);
  });

  // ── 7. schema 不匹配 → 错误 ─────────────────────────────────────────────

  it('sessions 表缺少必需列 → 抛 schema 不匹配错误', () => {
    const dbPath = path.join(tmpDir, 'bad-schema.db');
    const db = new DatabaseSync(dbPath);
    // 故意缺少 parent_session_id / is_subagent / transcript_path 列
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        started_at TEXT,
        provider TEXT,
        model TEXT,
        cwd TEXT,
        workspace_root TEXT,
        parent_agent_id TEXT,
        agent_id TEXT,
        messages_path TEXT
      );
    `);
    db.close();

    const importer = new ClineImporter(store, { dbPath, deviceId: DEVICE });
    expect(() => importer.import()).toThrow(/schema 不匹配/);
  });

  it('sessions.db 文件存在但无 sessions 表 → 抛 schema 不匹配错误', () => {
    const dbPath = path.join(tmpDir, 'no-table.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE unrelated (id INTEGER);');
    db.close();

    const importer = new ClineImporter(store, { dbPath, deviceId: DEVICE });
    expect(() => importer.import()).toThrow(/schema 不匹配/);
  });

  // ── 8. 两个数据源都不存在 → 空扫描不报错 ─────────────────────────────────

  it('sessions.db 与 sessionsDir 都不存在 → 空扫描，不抛错', () => {
    const importer = new ClineImporter(store, {
      dbPath: path.join(tmpDir, 'missing.db'),
      sessionsDir: path.join(tmpDir, 'missing-sessions'),
      deviceId: DEVICE,
    });
    const stats = importer.import();
    expect(stats.scanned).toBe(0);
    expect(stats.inserted).toBe(0);
    expect(stats.sourceChannel).toBe('db');
  });

  // ── 9. 路径解析 ─────────────────────────────────────────────────────────

  it('resolveClineDbPath：dbPath 选项优先于 dataDir 拼接', () => {
    expect(resolveClineDbPath({ dbPath: '/explicit/sessions.db' })).toBe('/explicit/sessions.db');
    const p = resolveClineDbPath({ dataDir: '/custom/cline' });
    expect(p).toBe(path.join('/custom/cline', 'data', 'db', 'sessions.db'));
  });

  it('resolveClineSessionsDir：sessionsDir 选项优先于 dataDir 拼接', () => {
    expect(resolveClineSessionsDir({ sessionsDir: '/explicit/sessions' })).toBe('/explicit/sessions');
    const p = resolveClineSessionsDir({ dataDir: '/custom/cline' });
    expect(p).toBe(path.join('/custom/cline', 'data', 'sessions'));
  });

  // ── 10. content 字符串形态 + isMeta 过滤 ─────────────────────────────────

  it('content 字符串形态与 isMeta 过滤：只保留 user/assistant 文本', () => {
    const transcriptPath = path.join(tmpDir, 'mixed.jsonl');
    writeNdjsonTranscript(transcriptPath, [
      { isMeta: true, type: 'user', message: { role: 'user', content: 'meta-hidden' } },
      userMsg('visible q'),
      { type: 'assistant', message: { role: 'assistant', content: 'string reply' } }, // 字符串 content
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', text: 'skip' }] } }, // 无 text 块
    ]);

    const dbPath = path.join(tmpDir, 'sessions.db');
    buildClineDb(dbPath, [{ sessionId: 'mixed-s', transcriptPath }]);

    const importer = new ClineImporter(store, { dbPath, deviceId: DEVICE });
    importer.import();

    const sessions = store.querySessions({ deviceId: DEVICE });
    const msgs = store.getMessages(sessions[0]!.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'visible q'],
      ['assistant', 'string reply'],
    ]);
  });
});
