/**
 * Crush 原生 adapter（覆盖等级 A）
 *
 * 只读导入项目级 Crush SQLite（<cwd>/.crush/crush.db）到 Session Vault。
 * Crush（Charm）是项目级存储：每个项目工作目录下有独立的 .crush/crush.db，
 * 含 sessions / messages / files / read_files 表，parent_session_id 提供拓扑。
 *
 * 真实结构（本机 ~/.crush/crush.db 实测，2026-07）：
 *   - sessions: id, parent_session_id, title, message_count, prompt_tokens,
 *       completion_tokens, cost, updated_at, created_at, summary_message_id, todos
 *   - messages: id, session_id, role, parts(JSON 数组 default '[]'), model,
 *       created_at, updated_at, finished_at, provider, is_summary_message
 *   - parent_session_id 非空 → subagent；否则 root
 *   - parts 是 JSON 数组，元素含 { type: 'text', text } 等块
 *
 * 核心约束：
 *   - 只读：以 readOnly 打开 crush.db，绝不写入 Crush 私有 DB（架构 §2 关键取舍）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = sessions.id（PK）
 *   - 拓扑（§4）：parent_session_id 非空 → subagent；否则 root。
 *   - 关系（§3.4）：subagent 的 parent_session_id 指向同次扫描已入库 session 时写 spawned_by；
 *     否则不猜测。两遍处理（先根后子）。
 *   - 消息：只取 user/assistant 的可显示文本块（parts 中 type=text）；
 *     排除 is_summary_message=1（compaction 摘要，内部 context）、tool/system 内部事件。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定；脏行跳过，无有效消息的 session 跳过。
 *   - 项目级：dbPath 默认 <cwd>/.crush/crush.db，cwd 默认 process.cwd()。
 */

import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
  SessionTopology,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

// node:sqlite 实验性内置，vitest/vite 静态解析会误判为裸包；
// 用 createRequire 运行时加载，绕过 vite 预优化（同 store / cass 的做法）。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** crush.db 相对项目 cwd 的路径 */
const CRUSH_DB_REL = path.join('.crush', 'crush.db');

/** 导入器选项 */
export interface CrushImportOptions {
  /** 项目工作目录，默认 process.cwd()；crush.db 在 <cwd>/.crush/crush.db */
  cwd?: string;
  /** 直接指定 crush.db 路径，优先级最高（覆盖 cwd） */
  dbPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface CrushImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** crush source instance id */
  sourceInstanceId: string;
  /** 扫描到的 session 总数 */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 session 数（无有效消息 / 脏数据） */
  skipped: number;
  /** 入库的 subagent 数 */
  subagents: number;
  /** 有 parent_session_id 但父未入库、未写 spawned_by 的 subagent 数 */
  unlinkedSubagents: number;
  /** 写入的 spawned_by 关系数 */
  relationships: number;
}

/** crush sessions 行 */
interface CrushSessionRow {
  id: string;
  parent_session_id: string | null;
  title: string | null;
  message_count: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost: number | null;
  created_at: number | null;
  updated_at: number | null;
}

/** crush messages 行 */
interface CrushMessageRow {
  id: string;
  role: string;
  parts: string;
  model: string | null;
  created_at: number | null;
  is_summary_message: number | null;
}

/** 一个 session 的解析结果 */
interface ParsedSession {
  nativeId: string;
  parentNativeId?: string;
  topology: SessionTopology;
  startedAt?: number;
  messages: SessionMessageInput[];
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
}

/** parts 块的松散结构 */
interface PartBlock {
  type?: string;
  text?: string;
  content?: string;
}

/** 解析 crush.db 路径：dbPath 选项 > cwd 拼接（默认 process.cwd()） */
export function resolveCrushDbPath(options: { dbPath?: string; cwd?: string } = {}): string {
  if (options.dbPath) return options.dbPath;
  const cwd = options.cwd ?? process.cwd();
  return path.join(cwd, CRUSH_DB_REL);
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 归一化 crush 消息 role；非可显示角色返回 null */
function normalizeRole(role: string): MessageRole | null {
  switch (role) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'tool':
      return role;
    default:
      return null;
  }
}

/**
 * 从 parts JSON 数组提取可显示文本。
 * parts 形如 [{"type":"text","text":"..."}]；也兼容 {"type":"text","content":"..."}。
 * parts 为空数组或非数组 → 返回 null。
 */
function extractPartsText(partsJson: string): string | null {
  if (!partsJson) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(partsJson);
  } catch {
    return null; // parts 非合法 JSON → 跳过该消息
  }
  if (!Array.isArray(arr)) return null;
  const parts: string[] = [];
  for (const block of arr as PartBlock[]) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      const t = block.text ?? block.content;
      if (typeof t === 'string' && t.length > 0) parts.push(t);
    }
  }
  if (parts.length === 0) return null;
  const joined = parts.join('\n');
  return joined.trim().length > 0 ? joined : null;
}

/**
 * Crush 原生导入器。
 *
 * 用法：
 *   const importer = new CrushImporter(store, { cwd: '/repo', deviceId });
 *   const stats = importer.import();
 */
export class CrushImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: CrushImportOptions = {},
  ) {}

  /** 执行一次完整导入，返回统计并写 scan_runs */
  import(): CrushImportStats {
    const dbPath = resolveCrushDbPath(this.options);
    const cwd = this.options.cwd ?? process.cwd();
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. 以只读方式打开 crush.db；不可读时给明确错误
    let db: DatabaseSyncType;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
      throw new Error(`crush 数据库不可读: ${dbPath} (${errorMessage(e)})`);
    }

    try {
      // 2. schema 校验
      this.assertCrushSchema(db, dbPath);

      // 3. 注册 coverage=A 的 crush source instance（rootPath=cwd）
      const instance = this.store.registerSourceInstance({
        deviceId,
        source: 'crush',
        rootPath: cwd,
        coverage: 'A' as Coverage,
      });

      // 4. 开始 scan_run
      const runId = this.store.startScanRun({
        sourceInstanceId: instance.id,
        deviceId,
      });

      try {
        const counts = this.streamImport(db, instance.id, deviceId);
        this.store.finishScanRun(runId, {
          status: 'completed',
          sessionsSeen: counts.scanned,
          sessionsNew: counts.inserted,
          sessionsUpdated: counts.updated,
        });
        return { scanRunId: runId, sourceInstanceId: instance.id, ...counts };
      } catch (err) {
        this.finishRunFailed(runId, err);
        throw err;
      }
    } finally {
      db.close();
    }
  }

  /** 把 scan_run 标记为 failed 并写 error；记录写入失败时不掩盖原始错误 */
  private finishRunFailed(runId: number, err: unknown): void {
    try {
      this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
    } catch {
      /* scan_run 记录写入失败不应掩盖导致导入失败的原始错误 */
    }
  }

  /**
   * 校验 crush schema：sessions / messages 表存在且当前 SQL 依赖的列名齐全。
   * 列不匹配时给清晰错误（便于 Crush 版本升级时及早发现）。
   */
  private assertCrushSchema(db: DatabaseSyncType, dbPath: string): void {
    const required: Record<string, string[]> = {
      sessions: ['id', 'parent_session_id', 'created_at', 'message_count', 'prompt_tokens', 'completion_tokens', 'cost'],
      messages: ['id', 'session_id', 'role', 'parts', 'created_at', 'is_summary_message'],
    };
    const tableInfo = db.prepare('SELECT name FROM pragma_table_info(?)');
    const missingTables: string[] = [];
    const missingCols: string[] = [];
    for (const [table, cols] of Object.entries(required)) {
      const rows = tableInfo.all(table) as { name: string }[];
      if (rows.length === 0) {
        missingTables.push(table);
        continue;
      }
      const present = new Set(rows.map((r) => r.name));
      for (const c of cols) {
        if (!present.has(c)) missingCols.push(`${table}.${c}`);
      }
    }
    if (missingTables.length > 0 || missingCols.length > 0) {
      const parts: string[] = [];
      if (missingTables.length > 0) parts.push(`缺少表 ${missingTables.join(', ')}`);
      if (missingCols.length > 0) parts.push(`缺少列 ${missingCols.join(', ')}`);
      throw new Error(`crush schema 不匹配: ${dbPath} — ${parts.join('；')}`);
    }
  }

  /**
   * 流式导入：遍历 session，逐条查询其消息并 upsert。
   * 两遍处理：先收集所有 ParsedSession（含拓扑），再先根后子入库并建关系。
   * 消息按 session_id 单独查询，单次只持有一个 session 的消息，内存不随总量线性增长。
   */
  private streamImport(
    db: DatabaseSyncType,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<CrushImportStats, 'scanRunId' | 'sourceInstanceId'> {
    const sessStmt = db.prepare(
      `SELECT id, parent_session_id, title, message_count, prompt_tokens,
              completion_tokens, cost, created_at, updated_at
       FROM sessions ORDER BY created_at`,
    );
    const msgStmt = db.prepare(
      `SELECT id, role, parts, model, created_at, is_summary_message
       FROM messages WHERE session_id = ? ORDER BY created_at`,
    );

    // —— 第一遍：收集所有 session（含消息解析）——
    const parsed: ParsedSession[] = [];
    for (const row of sessStmt.iterate()) {
      const s = row as unknown as CrushSessionRow;
      const nativeId = s.id;
      if (!nativeId || nativeId.length === 0) continue;

      const parentNativeId = s.parent_session_id && s.parent_session_id.length > 0
        ? s.parent_session_id
        : undefined;
      const topology: SessionTopology = parentNativeId ? 'subagent' : 'root';

      // 仅当前 session 的消息进入内存
      const msgRows = msgStmt.all(nativeId) as unknown as CrushMessageRow[];
      const messages: SessionMessageInput[] = [];
      let model: string | undefined;
      for (const m of msgRows) {
        // 排除 compaction 摘要（内部 context，架构 §4）
        if (m.is_summary_message === 1) continue;
        const role = normalizeRole(m.role);
        if (!role) continue; // 未知 role → 跳过
        // 仅取 user/assistant 的可显示文本
        if (role !== 'user' && role !== 'assistant') continue;
        const text = extractPartsText(m.parts);
        if (text === null) continue; // 无文本 → 跳过该条
        messages.push({
          role,
          content: text,
          timestamp: m.created_at ?? undefined,
        });
        if (model === undefined && m.model) model = m.model;
      }

      parsed.push({
        nativeId,
        parentNativeId,
        topology,
        startedAt: s.created_at ?? undefined,
        messages,
        model,
        promptTokens: s.prompt_tokens ?? undefined,
        completionTokens: s.completion_tokens ?? undefined,
        cost: s.cost ?? undefined,
      });
    }

    // —— 第二遍：先根后子入库 + 建关系 ——
    const roots = parsed.filter((p) => p.topology === 'root');
    const subs = parsed.filter((p) => p.topology === 'subagent');

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let subagents = 0;
    let unlinkedSubagents = 0;
    let relationships = 0;

    const idByNative = new Map<string, string>();
    const subRecords: Array<{ internalId: string; parentNativeId?: string }> = [];

    const tally = (result: { created: boolean; newRevision: boolean }): void => {
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    };

    const ingestOne = (p: ParsedSession): void => {
      scanned++;
      if (p.messages.length === 0) {
        skipped++;
        return;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: p.nativeId,
        source: 'crush',
        cwd: this.options.cwd ?? process.cwd(),
        projectPath: this.options.cwd ?? process.cwd(),
        startedAt: p.startedAt,
        topology: p.topology,
        sourceKind: 'A',
        messages: p.messages,
        model: p.model,
        totalInputTokens: p.promptTokens,
        totalOutputTokens: p.completionTokens,
        estimatedCostUsd: p.cost,
      });
      idByNative.set(p.nativeId, result.sessionId);
      tally(result);
    };

    // 先根后子
    for (const p of roots) ingestOne(p);
    for (const p of subs) {
      ingestOne(p);
      if (p.messages.length === 0) continue;
      subagents++;
      subRecords.push({ internalId: idByNative.get(p.nativeId)!, parentNativeId: p.parentNativeId });
    }

    // —— 关系：subagent → parent spawned_by（仅可验证父）——
    for (const sub of subRecords) {
      if (!sub.parentNativeId) {
        unlinkedSubagents++;
        continue;
      }
      const parentId = idByNative.get(sub.parentNativeId);
      if (!parentId || parentId === sub.internalId) {
        unlinkedSubagents++;
        continue;
      }
      this.store.addRelationship({
        fromSessionId: sub.internalId,
        toSessionId: parentId,
        relationType: 'spawned_by',
        evidence: 'crush sessions.parent_session_id',
      });
      relationships++;
    }

    return {
      scanned, inserted, updated, unchanged, skipped,
      subagents, unlinkedSubagents, relationships,
    };
  }
}
