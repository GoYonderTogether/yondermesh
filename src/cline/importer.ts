/**
 * Cline 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ~/.cline 下的 Cline 原生 session 并入库（architecture.md §2.2 / §3.4）。
 * Cline 是多形态（CLI + VS Code + SDK），双轨 session 存储：
 *   - 主轨：~/.cline/data/db/sessions.db SQLite（session 元数据 + 拓扑，A 级优先）
 *   - 副轨：~/.cline/data/sessions/<id>/*.json（transcript 消息段）
 * sessions.db 的 sessions 表不存消息正文，消息在 transcript_path / messages_path
 * 指向的 JSONL 文件中；本导入器以 DB 为主索引，按行读取 transcript 文件提取消息。
 *
 * 核心约束：
 *   - 只读：以 readOnly 打开 sessions.db，绝不写入 Cline 私有文件（架构 §2 关键取舍）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = session_id（PK）；缺失时回退相对 rootPath 的稳定路径
 *   - 拓扑（§4）：is_subagent=1 或 parent_session_id 非空 → subagent；否则 root。
 *   - 关系（§3.4）：subagent 的 parent_session_id 指向同次扫描已入库 session 时写 spawned_by；
 *     否则不猜测关系。两遍处理（先根后子），保证外键可满足。
 *   - 消息：只取 user/assistant 的可显示文本块（text）；排除 thinking、tool_use、
 *     tool_result 与 meta 行（架构 §4：不保存思维链/内部 context）。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定；脏行跳过，无有效消息的 session 跳过。
 *   - 回退：sessions.db 不可读时回退扫描 ~/.cline/data/sessions/<id>/*.json（仍 coverage=A）。
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
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

/** macOS / 通用默认 Cline 数据目录 */
const DEFAULT_CLINE_DATA_DIR = path.join(os.homedir(), '.cline');
/** sessions.db 相对数据目录的路径 */
const CLINE_DB_REL = path.join('data', 'db', 'sessions.db');
/** JSON transcript 回退扫描根（相对数据目录） */
const CLINE_SESSIONS_REL = path.join('data', 'sessions');

/** 导入器选项 */
export interface ClineImportOptions {
  /** 直接指定 Cline 数据目录，默认 ~/.cline */
  dataDir?: string;
  /** 直接指定 sessions.db 路径，优先级最高（覆盖 dataDir） */
  dbPath?: string;
  /** 直接指定 JSON transcript 回退根目录，优先级最高（覆盖 dataDir） */
  sessionsDir?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface ClineImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** cline source instance id */
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
  /** 实际使用的数据源：'db'（sessions.db）或 'json'（回退） */
  sourceChannel: 'db' | 'json';
}

/** sessions.db sessions 行（松散，列名对齐实测 schema） */
interface ClineSessionRow {
  session_id: string;
  source: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: string | null;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  workspace_root: string | null;
  parent_session_id: string | null;
  parent_agent_id: string | null;
  agent_id: string | null;
  conversation_id: string | null;
  is_subagent: number | null;
  prompt: string | null;
  transcript_path: string | null;
  messages_path: string | null;
  updated_at: string | null;
}

/** 一个 session 的解析结果 */
interface ParsedSession {
  nativeId: string;
  parentNativeId?: string;
  topology: SessionTopology;
  cwd?: string;
  startedAt?: number;
  messages: SessionMessageInput[];
  model?: string;
  cliVersion?: string;
  provider?: string;
  /** 透传元数据：entry source（cli/vscode/sdk 等） */
  entrySource?: string;
}

/** 单条 JSONL 行的松散结构 */
type JsonlLine = Record<string, unknown>;

/** content 块的松散结构 */
interface ContentBlock {
  type?: string;
  text?: string;
}

/** 解析 Cline 数据目录：dataDir 选项优先，否则回退默认路径 */
export function resolveClineDataDir(options: { dataDir?: string } = {}): string {
  return options.dataDir ?? DEFAULT_CLINE_DATA_DIR;
}

/** 解析 sessions.db 路径：dbPath 选项 > dataDir 拼接 */
export function resolveClineDbPath(options: { dbPath?: string; dataDir?: string } = {}): string {
  if (options.dbPath) return options.dbPath;
  return path.join(resolveClineDataDir(options), CLINE_DB_REL);
}

/** 解析 JSON transcript 回退根路径 */
export function resolveClineSessionsDir(options: { sessionsDir?: string; dataDir?: string } = {}): string {
  if (options.sessionsDir) return options.sessionsDir;
  return path.join(resolveClineDataDir(options), CLINE_SESSIONS_REL);
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 解析 ISO 时间戳为 epoch 毫秒；非法/缺失返回 undefined */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Cline 原生导入器。
 *
 * 用法：
 *   const importer = new ClineImporter(store, { deviceId });
 *   const stats = importer.import();
 */
export class ClineImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: ClineImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): ClineImportStats {
    const deviceId = this.options.deviceId ?? os.hostname();
    const dbPath = resolveClineDbPath(this.options);
    const sessionsDir = resolveClineSessionsDir(this.options);
    const dataDir = resolveClineDataDir(this.options);

    // 注册 coverage=A 的 cline source instance（rootPath=数据目录）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'cline',
      rootPath: dataDir,
      coverage: 'A' as Coverage,
    });

    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.scan(dbPath, sessionsDir, instance.id, deviceId);
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
  }

  /** 把 scan_run 标记为 failed 并写 error；记录写入失败时不掩盖原始错误 */
  private finishRunFailed(runId: number, err: unknown): void {
    try {
      this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
    } catch {
      /* scan_run 记录写入失败不应掩盖导致扫描失败的原始错误 */
    }
  }

  /**
   * 扫描入口：优先 sessions.db（A 级），不可读时回退 JSON transcript 目录。
   * 两种通道都产出 ParsedSession 列表后，统一两遍入库（先根后子）并建关系。
   */
  private scan(
    dbPath: string,
    sessionsDir: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<ClineImportStats, 'scanRunId' | 'sourceInstanceId'> {
    let parsed: ParsedSession[];
    let channel: 'db' | 'json';

    if (fs.existsSync(dbPath)) {
      parsed = this.scanFromDb(dbPath);
      channel = 'db';
    } else if (fs.existsSync(sessionsDir)) {
      parsed = this.scanFromJson(sessionsDir);
      channel = 'json';
    } else {
      // 两个数据源都不存在：空扫描（不报错，便于 daemon 容错）
      return {
        scanned: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0,
        subagents: 0, unlinkedSubagents: 0, relationships: 0, sourceChannel: 'db',
      };
    }

    return this.ingestParsed(parsed, deviceId, sourceInstanceId, channel);
  }

  /**
   * 从 sessions.db 读取 session 元数据，按 transcript_path / messages_path 读取消息。
   * 只读打开；schema 不匹配时给明确错误。
   */
  private scanFromDb(dbPath: string): ParsedSession[] {
    let db: DatabaseSyncType;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
      throw new Error(`Cline sessions.db 不可读: ${dbPath} (${errorMessage(e)})`);
    }
    try {
      this.assertClineSchema(db, dbPath);
      const stmt = db.prepare(
        `SELECT session_id, source, started_at, ended_at, status, provider, model,
                cwd, workspace_root, parent_session_id, parent_agent_id, agent_id,
                conversation_id, is_subagent, prompt, transcript_path, messages_path, updated_at
         FROM sessions ORDER BY started_at`,
      );
      const out: ParsedSession[] = [];
      for (const row of stmt.iterate()) {
        const r = row as unknown as ClineSessionRow;
        const parsed = this.parseDbRow(r);
        if (parsed) out.push(parsed);
      }
      return out;
    } finally {
      db.close();
    }
  }

  /**
   * 校验 Cline schema：sessions 表存在且当前 SQL 依赖的列名齐全。
   * 列不匹配时给清晰错误（便于 Cline 版本升级时及早发现）。
   */
  private assertClineSchema(db: DatabaseSyncType, dbPath: string): void {
    const required = [
      'session_id', 'started_at', 'provider', 'model', 'cwd', 'workspace_root',
      'parent_session_id', 'parent_agent_id', 'agent_id', 'is_subagent',
      'transcript_path', 'messages_path',
    ];
    const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all('sessions') as { name: string }[];
    if (rows.length === 0) {
      throw new Error(`Cline schema 不匹配: ${dbPath} — 缺少表 sessions`);
    }
    const present = new Set(rows.map((r) => r.name));
    const missing = required.filter((c) => !present.has(c));
    if (missing.length > 0) {
      throw new Error(`Cline schema 不匹配: ${dbPath} — 缺少列 ${missing.join(', ')}`);
    }
  }

  /**
   * 解析一条 DB 行：从 transcript_path / messages_path 读取消息 JSONL，
   * 提取 user/assistant 可显示文本。无 transcript 文件或无有效消息 → 返回 null。
   */
  private parseDbRow(row: ClineSessionRow): ParsedSession | null {
    const nativeId = row.session_id;
    if (!nativeId || nativeId.length === 0) return null;

    // 拓扑：is_subagent=1 或 parent_session_id 非空 → subagent
    const isSub = (row.is_subagent === 1) || (!!row.parent_session_id);
    const topology: SessionTopology = isSub ? 'subagent' : 'root';
    const parentNativeId = row.parent_session_id && row.parent_session_id.length > 0
      ? row.parent_session_id
      : undefined;

    // 消息文件优先级：transcript_path > messages_path
    const msgFile = this.firstExisting(row.transcript_path, row.messages_path);
    const messages = msgFile ? this.parseTranscriptFile(msgFile) : [];

    const startedAt = parseTimestamp(row.started_at);
    return {
      nativeId,
      parentNativeId,
      topology,
      cwd: row.cwd && row.cwd.length > 0 ? row.cwd : (row.workspace_root ?? undefined),
      startedAt,
      messages,
      model: row.model ?? undefined,
      provider: row.provider ?? undefined,
      entrySource: row.source ?? undefined,
    };
  }

  /** 返回第一个存在的文件路径（参数列表中），都不存在返回 null */
  private firstExisting(...candidates: Array<string | null | undefined>): string | null {
    for (const c of candidates) {
      if (c && c.length > 0 && fs.existsSync(c)) return c;
    }
    return null;
  }

  /**
   * JSON 回退通道：扫描 sessionsDir 下的 <id>/*.json 文件。
   * 每个 <id> 子目录视为一个 session（native id = 目录名），合并其下所有 .json 段。
   * 无 DB 元数据时，拓扑默认 root（无法判定 parent）。
   */
  private scanFromJson(sessionsDir: string): ParsedSession[] {
    const out: ParsedSession[] = [];
    let topEntries: fs.Dirent[];
    try {
      topEntries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of topEntries) {
      if (!e.isDirectory()) continue;
      const sessionDir = path.join(sessionsDir, e.name);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(sessionDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const messages: SessionMessageInput[] = [];
      let earliest: number | undefined;
      const jsonFiles = entries
        .filter((x) => x.isFile() && x.name.endsWith('.json'))
        .map((x) => x.name)
        .sort();
      for (const name of jsonFiles) {
        const fileMsgs = this.parseTranscriptFile(path.join(sessionDir, name));
        for (const m of fileMsgs) {
          messages.push(m);
          if (m.timestamp !== undefined && (earliest === undefined || m.timestamp < earliest)) {
            earliest = m.timestamp;
          }
        }
      }
      out.push({
        nativeId: e.name,
        topology: 'root',
        startedAt: earliest,
        messages,
      });
    }
    return out;
  }

  /**
   * 解析 transcript JSONL/JSON 文件，返回 user/assistant 可显示文本消息。
   * 兼容两种形态：每行一个 JSON（NDJSON）或整个文件一个 JSON 数组。
   * 单行 JSON 损坏跳过该行；无有效消息返回空数组。
   */
  private parseTranscriptFile(absPath: string): SessionMessageInput[] {
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch {
      return [];
    }
    const messages: SessionMessageInput[] = [];

    // 尝试整体解析为 JSON 数组（Cline 部分 transcript 是数组形态）
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed) as unknown;
        if (Array.isArray(arr)) {
          for (const obj of arr as JsonlLine[]) {
            this.collectMessage(obj, messages);
          }
          return messages;
        }
      } catch {
        // 不是合法 JSON 数组 → 按行解析
      }
    }

    // 按行解析 NDJSON
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let obj: JsonlLine;
      try {
        obj = JSON.parse(t) as JsonlLine;
      } catch {
        continue;
      }
      this.collectMessage(obj, messages);
    }
    return messages;
  }

  /**
   * 从一条 transcript 行提取可显示文本并追加到 messages。
   *   - 仅取 type=user/assistant（或 message.role=user/assistant）的文本块
   *   - isMeta / 内部事件跳过
   *   - content 字符串 → 直接用；content 数组 → 只取 text 块拼接
   */
  private collectMessage(obj: JsonlLine, out: SessionMessageInput[]): void {
    if (obj.isMeta === true) return;
    const type = typeof obj.type === 'string' ? obj.type : undefined;
    const message = obj.message as { role?: unknown; content?: unknown } | undefined;

    // 判定 role：优先 message.role，其次顶层 type
    let role: MessageRole | null = null;
    if (message && typeof message.role === 'string') {
      role = this.normalizeRole(message.role);
    } else if (type === 'user' || type === 'assistant') {
      role = type;
    }
    if (role === null) return;
    if (role !== 'user' && role !== 'assistant') return;

    const text = this.extractDisplayText(obj, message);
    if (text !== null) {
      out.push({ role, content: text, timestamp: parseTimestamp(obj.timestamp) });
    }
  }

  /** 提取一行的可显示文本：content 字符串 / content 数组只取 text 块；结果空白返回 null */
  private extractDisplayText(
    obj: JsonlLine,
    message: { content?: unknown } | undefined,
  ): string | null {
    const content = message?.content ?? obj.content;
    if (typeof content === 'string') {
      return content.trim().length > 0 ? content : null;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content as ContentBlock[]) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
      if (parts.length === 0) return null;
      const joined = parts.join('\n');
      return joined.trim().length > 0 ? joined : null;
    }
    return null;
  }

  /** 归一化 Cline 消息 role；非可显示角色返回 null */
  private normalizeRole(role: string): MessageRole | null {
    switch (role) {
      case 'user':
      case 'assistant':
        return role;
      case 'system':
        return 'system';
      case 'tool':
        return 'tool';
      default:
        return null;
    }
  }

  /**
   * 两遍入库（先根后子）并建 spawned_by 关系。
   * 父根先入库，子 agent 的 spawned_by 外键才能满足。
   */
  private ingestParsed(
    parsed: ParsedSession[],
    deviceId: string,
    sourceInstanceId: string,
    channel: 'db' | 'json',
  ): Omit<ClineImportStats, 'scanRunId' | 'sourceInstanceId'> {
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

    // —— 第一遍：根 session ——
    for (const p of roots) {
      scanned++;
      if (p.messages.length === 0) {
        skipped++;
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: p.nativeId,
        source: 'cline',
        cwd: p.cwd,
        projectPath: p.cwd,
        startedAt: p.startedAt,
        topology: 'root',
        sourceKind: 'A',
        messages: p.messages,
        model: p.model,
        cliVersion: p.cliVersion,
        entrySource: p.entrySource,
      });
      idByNative.set(p.nativeId, result.sessionId);
      tally(result);
    }

    // —— 第二遍：子 agent ——
    for (const p of subs) {
      scanned++;
      if (p.messages.length === 0) {
        skipped++;
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: p.nativeId,
        source: 'cline',
        cwd: p.cwd,
        projectPath: p.cwd,
        startedAt: p.startedAt,
        topology: 'subagent',
        sourceKind: 'A',
        messages: p.messages,
        model: p.model,
        cliVersion: p.cliVersion,
        entrySource: p.entrySource,
      });
      idByNative.set(p.nativeId, result.sessionId);
      subagents++;
      tally(result);
      subRecords.push({ internalId: result.sessionId, parentNativeId: p.parentNativeId });
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
        evidence: 'cline sessions.db parent_session_id',
      });
      relationships++;
    }

    return {
      scanned, inserted, updated, unchanged, skipped,
      subagents, unlinkedSubagents, relationships, sourceChannel: channel,
    };
  }
}
