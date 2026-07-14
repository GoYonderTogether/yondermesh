/**
 * LOOP-013 需求与响应提取器 契约测试
 *
 * 覆盖验收门：
 *   1. extractProject：按 cwdPrefix 提取，user→requirements、assistant→responses，system/tool 被忽略
 *   2. NDJSONL 行号 = ID（1-based），文件每行一条 JSON
 *   3. queryExtracts：按 id（行号）精确索引
 *   4. queryExtracts：keyword 模糊匹配（大小写不敏感）
 *   5. queryExtracts：sessionId 过滤、limit/offset 分页
 *   6. queryExtracts：startedAtFrom/To 时间区间过滤
 *   7. 幂等：重复 extract 覆盖写入
 *   8. loadExtractIndex / listExtracts
 *   9. 时间区间过滤对齐 store 的 startedAt 闭区间语义
 *
 * 设计原则：用临时目录隔离 YONDERMESH_HOME 和 sqlite 文件，互不污染。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from '../src/store/index.js';
import type { SessionIngestInput } from '../src/store/index.js';
import {
  extractProject,
  queryExtracts,
  loadExtractIndex,
  listExtracts,
  projectHashOf,
  projectExtractDir,
} from '../src/extract/index.js';

const DEVICE = 'mac-test';
const PROJECT_CWD = '/fake/yondermesh-project';

let tempHome: string;
let dbPath: string;
let savedEnv: string | undefined;

/** 构造一个全新的临时环境：YONDERMESH_HOME + 空 sqlite db */
function freshEnv(): void {
  tempHome = mkdtempSync(join(tmpdir(), 'ymesh-extract-'));
  process.env.YONDERMESH_HOME = tempHome;
  dbPath = join(tempHome, 'test.db');
}

/** 注册一个 claude-code 来源实例并返回其 id */
function claudeInstance(store: SessionStore): string {
  return store.registerSourceInstance({
    deviceId: DEVICE,
    source: 'claude-code',
    rootPath: '/Users/zoran/.claude/projects',
    coverage: 'A',
  }).id;
}

/** 入库一个 session，返回 sessionId */
function ingest(
  store: SessionStore,
  sourceInstanceId: string,
  nativeId: string,
  cwd: string,
  startedAt: number,
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string; timestamp?: number }>,
): string {
  const input: SessionIngestInput = {
    deviceId: DEVICE,
    sourceInstanceId,
    nativeSessionId: nativeId,
    source: 'claude-code',
    cwd,
    startedAt,
    topology: 'root',
    messages,
  };
  return store.ingestSession(input).sessionId;
}

/** 读取 NDJSONL 文件并返回行数组（已 parse） */
function readNdjsonl(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf-8');
  if (raw === '') return [];
  return raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

describe('LOOP-013 需求与响应提取器', () => {
  beforeEach(() => {
    savedEnv = process.env.YONDERMESH_HOME;
    freshEnv();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.YONDERMESH_HOME;
    else process.env.YONDERMESH_HOME = savedEnv;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('extractProject：按角色拆分 user/assistant，忽略 system/tool', () => {
    // 种子：两个 session
    const store = new SessionStore(dbPath);
    const inst = claudeInstance(store);
    const aId = ingest(store, inst, 'sess-A', PROJECT_CWD, 1_000, [
      { role: 'user', content: '请加一个登录功能', timestamp: 1_100 },
      { role: 'assistant', content: '好的开始实现', timestamp: 1_200 },
      { role: 'system', content: 'system-preamble', timestamp: 1_250 },
      { role: 'user', content: '记得加测试', timestamp: 1_300 },
      { role: 'assistant', content: '测试已加', timestamp: 1_400 },
    ]);
    const bId = ingest(store, inst, 'sess-B', PROJECT_CWD, 2_000, [
      { role: 'user', content: '修复 bug #123', timestamp: 2_100 },
      { role: 'assistant', content: '已修复', timestamp: 2_200 },
    ]);
    store.close();
    void aId; void bId;

    const result = extractProject({ cwdPrefix: PROJECT_CWD, dbPath });

    expect(result.sessionCount).toBe(2);
    expect(result.requirementCount).toBe(3); // 2 (A) + 1 (B)
    expect(result.responseCount).toBe(3);    // 2 (A) + 1 (B)
    expect(result.projectHash).toBe(projectHashOf(PROJECT_CWD));
    expect(existsSync(result.requirementsFile)).toBe(true);
    expect(existsSync(result.responsesFile)).toBe(true);
    expect(existsSync(result.indexFile)).toBe(true);
    expect(result.requirementsFile).toBe(join(projectExtractDir(result.projectHash), 'requirements.ndjsonl'));
  });

  it('NDJSONL 行号 = ID（1-based），每行一条 JSON', () => {
    const store = new SessionStore(dbPath);
    const inst = claudeInstance(store);
    ingest(store, inst, 'sess-A', PROJECT_CWD, 1_000, [
      { role: 'user', content: '需求一', timestamp: 1_100 },
      { role: 'assistant', content: '响应一', timestamp: 1_200 },
      { role: 'user', content: '需求二', timestamp: 1_300 },
      { role: 'assistant', content: '响应二', timestamp: 1_400 },
    ]);
    store.close();

    const result = extractProject({ cwdPrefix: PROJECT_CWD, dbPath });
    const reqs = readNdjsonl(result.requirementsFile) as Array<{ id: number; content: string }>;
    const resps = readNdjsonl(result.responsesFile) as Array<{ id: number; content: string }>;

    expect(reqs).toHaveLength(2);
    expect(resps).toHaveLength(2);
    // 行号 = ID 契约
    reqs.forEach((e, i) => expect(e.id).toBe(i + 1));
    resps.forEach((e, i) => expect(e.id).toBe(i + 1));
  });

  it('queryExtracts：按 id（行号）精确索引，越界返回空', () => {
    const store = new SessionStore(dbPath);
    const inst = claudeInstance(store);
    ingest(store, inst, 'sess-A', PROJECT_CWD, 1_000, [
      { role: 'user', content: '需求一', timestamp: 1_100 },
      { role: 'assistant', content: '响应一', timestamp: 1_200 },
      { role: 'user', content: '需求二', timestamp: 1_300 },
    ]);
    store.close();

    const { projectHash } = extractProject({ cwdPrefix: PROJECT_CWD, dbPath });

    const r1 = queryExtracts(projectHash, 'requirements', { id: 1 });
    const r2 = queryExtracts(projectHash, 'requirements', { id: 2 });
    const r99 = queryExtracts(projectHash, 'requirements', { id: 99 });

    expect(r1).toHaveLength(1);
    expect(r1[0]!.id).toBe(1);
    expect(r2).toHaveLength(1);
    expect(r2[0]!.id).toBe(2);
    expect(r1[0]!.content).not.toBe(r2[0]!.content);
    expect(r99).toHaveLength(0);
  });

  it('queryExtracts：keyword 大小写不敏感模糊匹配', () => {
    const store = new SessionStore(dbPath);
    const inst = claudeInstance(store);
    ingest(store, inst, 'sess-A', PROJECT_CWD, 1_000, [
      { role: 'user', content: 'Please add Login feature', timestamp: 1_100 },
      { role: 'assistant', content: 'done', timestamp: 1_200 },
      { role: 'user', content: '另外修复 bug', timestamp: 1_300 },
    ]);
    store.close();

    const { projectHash } = extractProject({ cwdPrefix: PROJECT_CWD, dbPath });

    const hit = queryExtracts(projectHash, 'requirements', { keyword: 'login' });
    const hit2 = queryExtracts(projectHash, 'requirements', { keyword: '修复' });
    const none = queryExtracts(projectHash, 'requirements', { keyword: '不存在的词' });

    expect(hit).toHaveLength(1);
    expect(hit[0]!.content).toContain('Login');
    expect(hit2).toHaveLength(1);
    expect(hit2[0]!.content).toContain('修复');
    expect(none).toHaveLength(0);
  });

  it('queryExtracts：sessionId 过滤 + limit/offset 分页', () => {
    const store = new SessionStore(dbPath);
    const inst = claudeInstance(store);
    const aId = ingest(store, inst, 'sess-A', PROJECT_CWD, 1_000, [
      { role: 'user', content: 'A-需求1', timestamp: 1_100 },
      { role: 'assistant', content: 'A-响应1', timestamp: 1_200 },
      { role: 'user', content: 'A-需求2', timestamp: 1_300 },
    ]);
    ingest(store, inst, 'sess-B', PROJECT_CWD, 2_000, [
      { role: 'user', content: 'B-需求1', timestamp: 2_100 },
      { role: 'assistant', content: 'B-响应1', timestamp: 2_200 },
    ]);
    store.close();

    const { projectHash } = extractProject({ cwdPrefix: PROJECT_CWD, dbPath });

    // sessionId 过滤：A 贡献 2 条 user
    const aReqs = queryExtracts(projectHash, 'requirements', { sessionId: aId });
    expect(aReqs).toHaveLength(2);
    expect(aReqs.every((e) => e.sessionId === aId)).toBe(true);

    // 全量 3 条，分页
    const all = queryExtracts(projectHash, 'requirements', {});
    expect(all).toHaveLength(3);
    const page1 = queryExtracts(projectHash, 'requirements', { limit: 2, offset: 0 });
    const page2 = queryExtracts(projectHash, 'requirements', { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(1);
    expect(page1[0]!.id).toBe(all[0]!.id);
    expect(page2[0]!.id).toBe(all[2]!.id);
  });

  it('queryExtracts：startedAtFrom/To 时间区间过滤', () => {
    const store = new SessionStore(dbPath);
    const inst = claudeInstance(store);
    ingest(store, inst, 'sess-early', PROJECT_CWD, 1_000, [
      { role: 'user', content: '早期需求', timestamp: 1_100 },
    ]);
    ingest(store, inst, 'sess-late', PROJECT_CWD, 5_000, [
      { role: 'user', content: '后期需求', timestamp: 5_100 },
    ]);
    store.close();

    const { projectHash } = extractProject({ cwdPrefix: PROJECT_CWD, dbPath });

    // 仅早期
    const early = queryExtracts(projectHash, 'requirements', { startedAtTo: 2_000 });
    expect(early).toHaveLength(1);
    expect(early[0]!.content).toBe('早期需求');
    // 仅后期
    const late = queryExtracts(projectHash, 'requirements', { startedAtFrom: 2_000 });
    expect(late).toHaveLength(1);
    expect(late[0]!.content).toBe('后期需求');
    // 闭区间含端点
    const both = queryExtracts(projectHash, 'requirements', { startedAtFrom: 1_000, startedAtTo: 5_000 });
    expect(both).toHaveLength(2);
  });

  it('幂等：重复 extract 覆盖写入，不残留旧数据', () => {
    const store = new SessionStore(dbPath);
    const inst = claudeInstance(store);
    ingest(store, inst, 'sess-A', PROJECT_CWD, 1_000, [
      { role: 'user', content: '需求一', timestamp: 1_100 },
      { role: 'assistant', content: '响应一', timestamp: 1_200 },
    ]);
    store.close();

    const r1 = extractProject({ cwdPrefix: PROJECT_CWD, dbPath });
    expect(r1.requirementCount).toBe(1);

    // 再次提取（数据未变）→ 覆盖，计数不变
    const r2 = extractProject({ cwdPrefix: PROJECT_CWD, dbPath });
    expect(r2.requirementCount).toBe(1);
    const reqs = readNdjsonl(r2.requirementsFile);
    expect(reqs).toHaveLength(1);
  });

  it('loadExtractIndex / listExtracts', () => {
    const store = new SessionStore(dbPath);
    const inst = claudeInstance(store);
    ingest(store, inst, 'sess-A', PROJECT_CWD, 1_000, [
      { role: 'user', content: '需求一', timestamp: 1_100 },
    ]);
    store.close();

    const result = extractProject({ cwdPrefix: PROJECT_CWD, dbPath });

    const idx = loadExtractIndex(result.projectHash);
    expect(idx).toBeDefined();
    expect(idx!.projectHash).toBe(result.projectHash);
    expect(idx!.requirementCount).toBe(1);

    const list = listExtracts();
    expect(list).toHaveLength(1);
    expect(list[0]!.projectHash).toBe(result.projectHash);
  });

  it('queryExtracts：未提取过的项目返回空数组', () => {
    const ph = projectHashOf('/nonexistent/project');
    expect(queryExtracts(ph, 'requirements', { id: 1 })).toHaveLength(0);
    expect(loadExtractIndex(ph)).toBeUndefined();
  });

  it('不含目标项目 cwd 的 session 不被提取', () => {
    const store = new SessionStore(dbPath);
    const inst = claudeInstance(store);
    ingest(store, inst, 'sess-in', PROJECT_CWD, 1_000, [
      { role: 'user', content: '本项目需求', timestamp: 1_100 },
    ]);
    ingest(store, inst, 'sess-out', '/other/project', 2_000, [
      { role: 'user', content: '其它项目需求', timestamp: 2_100 },
    ]);
    store.close();

    const result = extractProject({ cwdPrefix: PROJECT_CWD, dbPath });
    expect(result.sessionCount).toBe(1);
    expect(result.requirementCount).toBe(1);
    const reqs = readNdjsonl(result.requirementsFile) as Array<{ content: string }>;
    expect(reqs[0]!.content).toBe('本项目需求');
  });
});
