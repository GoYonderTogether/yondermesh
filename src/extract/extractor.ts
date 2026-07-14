/**
 * 需求与响应提取器核心实现
 *
 * 从 SessionStore 中按项目（cwdPrefix / projectPath）提取全部 user 消息（需求）
 * 与 assistant 消息（响应），分别写入两个 NDJSONL 文件：
 *   ~/.yondermesh/extracts/<projectHash>/requirements.ndjsonl
 *   ~/.yondermesh/extracts/<projectHash>/responses.ndjsonl
 *   ~/.yondermesh/extracts/<projectHash>/index.json
 *
 * 每行一条 JSON 记录，行号 = ID（1-based），可按 ID/行号精确索引，也可按
 * 关键词 / sessionId / 时间区间过滤查询。
 *
 * 极简、无外部依赖，仅用 node:fs / node:crypto / node:path。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SessionStore } from '../store/session-store.js';
import { defaultDataDir } from '../daemon/config.js';
import type {
  ExtractEntry,
  ExtractKind,
  ExtractOptions,
  ExtractResult,
  QueryEntry,
  QueryOptions,
} from './types.js';

/** NDJSONL 文件名 */
const REQUIREMENTS_FILE = 'requirements.ndjsonl';
const RESPONSES_FILE = 'responses.ndjsonl';
const INDEX_FILE = 'index.json';

/** 提取结果存放根目录：~/.yondermesh/extracts（受 YONDERMESH_HOME 覆盖） */
export function extractsBaseDir(): string {
  return join(defaultDataDir(), 'extracts');
}

/** 项目哈希：sha256(projectPath) 前 16 位 hex，作为目录名，稳定可复现 */
export function projectHashOf(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
}

/** 某项目的提取结果目录 */
export function projectExtractDir(projectHash: string): string {
  return join(extractsBaseDir(), projectHash);
}

/** 按 kind 解析文件名 */
function fileNameOf(kind: ExtractKind): string {
  return kind === 'requirements' ? REQUIREMENTS_FILE : RESPONSES_FILE;
}

/**
 * 提取某项目的全部需求（user 消息）与响应（assistant 消息）到 NDJSONL 文件。
 * 幂等：每次调用覆盖写入该项目的两个文件与 index.json。
 */
export function extractProject(options: ExtractOptions): ExtractResult {
  const projectPath = options.cwdPrefix ?? options.projectPath;
  if (!projectPath) {
    throw new Error('extractProject: 必须提供 cwdPrefix 或 projectPath');
  }
  const projectHash = projectHashOf(projectPath);
  const dir = projectExtractDir(projectHash);
  mkdirSync(dir, { recursive: true });

  const dbPath = options.dbPath ?? join(defaultDataDir(), 'yondermesh.db');
  const store = new SessionStore(dbPath);
  try {
    const sessions = store.querySessions({
      cwdPrefix: options.cwdPrefix,
      projectPath: options.projectPath,
      startedAtFrom: options.startedAtFrom,
      startedAtTo: options.startedAtTo,
      includeArchived: false,
      limit: 1_000_000,
    });

    const requirements: ExtractEntry[] = [];
    const responses: ExtractEntry[] = [];
    let reqId = 0;
    let respId = 0;

    for (const s of sessions) {
      const msgs = store.getMessages(s.id);
      for (const m of msgs) {
        const base = {
          sessionId: s.id,
          sessionNativeId: s.nativeSessionId,
          source: s.source,
          seq: m.seq,
          role: m.role,
          timestamp: m.timestamp,
          sessionStartedAt: s.startedAt ?? undefined,
          cwd: s.cwd,
          content: m.content,
        };
        if (m.role === 'user') {
          reqId++;
          requirements.push({ id: reqId, ...base });
        } else if (m.role === 'assistant') {
          respId++;
          responses.push({ id: respId, ...base });
        }
      }
    }

    const requirementsFile = join(dir, REQUIREMENTS_FILE);
    const responsesFile = join(dir, RESPONSES_FILE);
    const indexFile = join(dir, INDEX_FILE);

    writeNdjsonl(requirementsFile, requirements);
    writeNdjsonl(responsesFile, responses);

    const result: ExtractResult = {
      projectHash,
      projectPath,
      requirementsFile,
      responsesFile,
      indexFile,
      requirementCount: requirements.length,
      responseCount: responses.length,
      sessionCount: sessions.length,
      extractedAt: Date.now(),
    };
    writeFileSync(indexFile, JSON.stringify(result, null, 2) + '\n', 'utf-8');
    return result;
  } finally {
    store.close();
  }
}

/** 写入 NDJSONL：每行一条 JSON，行末换行；空数组写空文件 */
function writeNdjsonl(file: string, entries: ExtractEntry[]): void {
  const text = entries.length > 0
    ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    : '';
  writeFileSync(file, text, 'utf-8');
}

/**
 * 查询某项目某类型（requirements / responses）的提取记录。
 * id 命中时直接按行号定位并返回单条（忽略其它过滤）。
 */
export function queryExtracts(
  projectHash: string,
  kind: ExtractKind,
  options: QueryOptions = {},
): QueryEntry[] {
  const file = join(projectExtractDir(projectHash), fileNameOf(kind));
  if (!existsSync(file)) return [];

  const raw = readFileSync(file, 'utf-8');
  if (raw === '') return [];
  const lines = raw.split('\n');
  // 末尾换行会产生一个空串，过滤掉
  const entries: ExtractEntry[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    entries.push(JSON.parse(line) as ExtractEntry);
  }

  // id = 行号（1-based）：直接索引，优先级最高
  if (options.id !== undefined) {
    const e = entries[options.id - 1];
    return e ? [e] : [];
  }

  let filtered = entries;
  if (options.sessionId !== undefined) {
    filtered = filtered.filter((e) => e.sessionId === options.sessionId);
  }
  if (options.keyword !== undefined) {
    const kw = options.keyword.toLowerCase();
    filtered = filtered.filter((e) => e.content.toLowerCase().includes(kw));
  }
  if (options.startedAtFrom !== undefined) {
    filtered = filtered.filter(
      (e) => (e.sessionStartedAt ?? e.timestamp ?? 0) >= options.startedAtFrom!,
    );
  }
  if (options.startedAtTo !== undefined) {
    filtered = filtered.filter(
      (e) => (e.sessionStartedAt ?? e.timestamp ?? 0) <= options.startedAtTo!,
    );
  }

  const offset = options.offset ?? 0;
  const limit = options.limit ?? filtered.length;
  return filtered.slice(offset, offset + limit);
}

/** 读取某项目的 index.json，不存在返回 undefined */
export function loadExtractIndex(projectHash: string): ExtractResult | undefined {
  const file = join(projectExtractDir(projectHash), INDEX_FILE);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf-8')) as ExtractResult;
}

/** 列出所有已提取过的项目（按 extractsBaseDir 子目录扫描） */
export function listExtracts(): ExtractResult[] {
  const base = extractsBaseDir();
  if (!existsSync(base)) return [];
  const out: ExtractResult[] = [];
  for (const name of readdirSync(base)) {
    const idx = loadExtractIndex(name);
    if (idx) out.push(idx);
  }
  return out.sort((a, b) => b.extractedAt - a.extractedAt);
}
