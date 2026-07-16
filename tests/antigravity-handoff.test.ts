/**
 * Antigravity session handoff 验证测试
 *
 * 验证：尽管 Antigravity 硬绑 Google OAuth（GLM-5.2 ❌），
 * 其 session 内容可被完整提取用于跨 agent handoff。
 *
 * 覆盖：
 *   1. exportSession 提取 transcript.jsonl 原文 + DB 元数据
 *   2. 提取的内容包含完整消息序列（可被其他 agent 接力）
 *   3. transcript 缺失时仍可提取 preview 元数据
 *   4. 会话不存在时返回 ok=false
 *   5. listSessions 读取 DB 返回会话列表
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AntigravityCliWrapper } from '../src/antigravity/index.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');

describe('Antigravity session handoff 验证', () => {
  let tmpDir: string;
  let dbPath: string;
  let wrapper: AntigravityCliWrapper;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-handoff-'));
    dbPath = path.join(tmpDir, 'conversation_summaries.db');
    wrapper = new AntigravityCliWrapper({ dbPath });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 构建含 transcript 的 fixture DB */
  function buildDbWithTranscript(): string {
    const appDataDir = path.join(tmpDir, 'transcripts', 'conv-handoff-1');
    fs.mkdirSync(appDataDir, { recursive: true });
    const transcriptContent = [
      JSON.stringify({ role: 'user', content: '请帮我实现一个排序算法', timestamp: 1_000 }),
      JSON.stringify({ role: 'model', content: '好的，我来实现快速排序...', timestamp: 2_000 }),
      JSON.stringify({ role: 'user', content: '改用归并排序', timestamp: 3_000 }),
      JSON.stringify({ role: 'model', content: '这是归并排序的实现...', timestamp: 4_000 }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(appDataDir, 'transcript.jsonl'), transcriptContent, 'utf-8');

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT, preview TEXT, step_count INTEGER, last_modified_time INTEGER,
        workspace_uris TEXT, status TEXT, source TEXT, project_id TEXT, agent_name TEXT,
        parent_conversation_id TEXT, nesting_depth INTEGER, battle_id TEXT,
        winning_conversation_id TEXT, not_fully_idle INTEGER, killed INTEGER,
        last_user_input_time INTEGER, last_user_input_step_index INTEGER, app_data_dir TEXT
      )
    `);
    db.prepare(
      `INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, agent_name, last_modified_time, app_data_dir)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('conv-handoff-1', '排序算法实现', 'file:///repo/sort', 'antigravity-cli/1.1.2', 4_000, appDataDir);
    db.close();
    return appDataDir;
  }

  // ── 验收门 1：exportSession 提取 transcript + 元数据 ─────────────────────

  it('exportSession 提取 transcript.jsonl 原文 + DB 元数据', () => {
    buildDbWithTranscript();
    const res = wrapper.exportSession('conv-handoff-1');

    expect(res.ok).toBe(true);
    expect(res.data).toBeDefined();
    expect(res.data!.conversationId).toBe('conv-handoff-1');
    expect(res.data!.transcript.length).toBeGreaterThan(0);
    expect(res.data!.transcriptPath).toContain('transcript.jsonl');
    expect(res.data!.metadata).toBeDefined();
    expect((res.data!.metadata as Record<string, unknown>).title).toBe('排序算法实现');
    expect((res.data!.metadata as Record<string, unknown>).workspace_uris).toBe('file:///repo/sort');
  });

  // ── 验收门 2：提取内容含完整消息序列 ────────────────────────────────────

  it('提取的 transcript 含完整消息序列（4 条），可被其他 agent 接力', () => {
    buildDbWithTranscript();
    const res = wrapper.exportSession('conv-handoff-1');

    expect(res.ok).toBe(true);
    const lines = res.data!.transcript.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(4);

    // 解析每行验证角色与内容
    const events = lines.map((l) => JSON.parse(l) as { role: string; content: string });
    expect(events[0]!.role).toBe('user');
    expect(events[0]!.content).toContain('排序算法');
    expect(events[1]!.role).toBe('model');
    expect(events[2]!.role).toBe('user');
    expect(events[2]!.content).toContain('归并排序');
    expect(events[3]!.role).toBe('model');
  });

  // ── 验收门 3：transcript 缺失时仍可提取元数据 ───────────────────────────

  it('transcript 缺失时仍可提取 DB 元数据（无 transcript 字段）', () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT, preview TEXT, step_count INTEGER, last_modified_time INTEGER,
        workspace_uris TEXT, status TEXT, source TEXT, project_id TEXT, agent_name TEXT,
        parent_conversation_id TEXT, nesting_depth INTEGER, battle_id TEXT,
        winning_conversation_id TEXT, not_fully_idle INTEGER, killed INTEGER,
        last_user_input_time INTEGER, last_user_input_step_index INTEGER, app_data_dir TEXT
      )
    `);
    db.prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, preview) VALUES (?, ?, ?)',
    ).run('conv-meta-only', '仅元数据', 'preview content here');
    db.close();

    const res = wrapper.exportSession('conv-meta-only');
    expect(res.ok).toBe(true);
    expect(res.data!.metadata).toBeDefined();
    expect((res.data!.metadata as Record<string, unknown>).title).toBe('仅元数据');
    expect(res.data!.transcript).toBe('');
  });

  // ── 验收门 4：会话不存在时返回 ok=false ─────────────────────────────────

  it('会话不存在时返回 ok=false', () => {
    buildDbWithTranscript();
    const res = wrapper.exportSession('nonexistent-conv');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not found');
  });

  // ── 验收门 5：listSessions 读取 DB 返回会话列表 ─────────────────────────

  it('listSessions 读取 DB 返回会话列表', () => {
    buildDbWithTranscript();
    const res = wrapper.listSessions();

    expect(res.ok).toBe(true);
    expect(res.data).toBeDefined();
    expect(res.data!.length).toBe(1);
    expect(res.data![0]!.conversationId).toBe('conv-handoff-1');
    expect(res.data![0]!.title).toBe('排序算法实现');
  });

  // ── 验收门 6：DB 不存在时 listSessions 返回 ok=false ────────────────────

  it('DB 不存在时 listSessions 返回 ok=false', () => {
    const res = wrapper.listSessions();
    expect(res.ok).toBe(false);
    expect(res.error).toBe('db not found');
  });

  // ── 关键结论：Antigravity session 可被提取用于 handoff ─────────────────

  it('关键结论：GLM-5.2 不可用但 session 可被完整提取用于跨 agent handoff', () => {
    buildDbWithTranscript();
    const res = wrapper.exportSession('conv-handoff-1');

    // 提取的 handoff 包含：
    // 1. 完整 transcript（消息序列）
    // 2. DB 元数据（title, workspace, agent_name 等）
    // 3. transcript 文件路径（供后续读取）
    expect(res.ok).toBe(true);
    expect(res.data!.transcript.length).toBeGreaterThan(0);
    expect(res.data!.metadata).not.toBeNull();
    expect(res.data!.transcriptPath).not.toBeNull();

    // 这个 handoff 包可被传给 OpenHands（GLM-5.2 ✅）或 Goose（GLM-5.2 ✅）接力
    // 证明：Antigravity 虽硬绑 Google OAuth，但其 session 数据不锁定，
    // 可被 yondermesh 提取并交给支持 GLM-5.2 的 agent 接力。
  });
});
