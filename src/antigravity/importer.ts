/**
 * Antigravity 原生 adapter（覆盖等级 A）
 *
 * Google Antigravity（Electron IDE + agy CLI + Python SDK）的 session 存储
 * 经逆向工程确认结构：
 *
 * 1. SQLite 主库（macOS 默认路径）：
 *    ~/Library/Application Support/Google/Antigravity/conversation_summaries.db
 *    表 conversation_summaries（17 列）：
 *      conversation_id PK, title, preview, step_count, last_modified_time,
 *      workspace_uris, status, source, project_id, agent_name,
 *      parent_conversation_id, nesting_depth, battle_id,
 *      winning_conversation_id, not_fully_idle, killed,
 *      last_user_input_time, last_user_input_step_index, app_data_dir
 *    索引：idx_conversation_summaries_last_user_input_time,
 *          idx_conversation_summaries_last_modified_time
 *
 * 2. 每会话 transcript.jsonl：
 *    <app_data_dir>/transcript.jsonl（每行一个 JSON 事件）
 *
 * 核心约束：
 *   - 只读：以 readOnly 打开 conversation_summaries.db，绝不写入（架构 §2）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = conversation_id
 *   - 覆盖等级 A：原生 adapter，可直接用于原生恢复。
 *   - 拓扑：nesting_depth=0 → root；nesting_depth>0 → subagent（spawned_by parent）
 *   - battle 关系：battle_id 非空且 winning_conversation_id 非空 → sidechain_of 关系
 *     （battle 模式下多 agent 竞争，winner 为主线，其余为 sidechain）
 *   - 幂等：依赖 SessionStore 的 content_hash 判定。
 *   - 消息来源：transcript.jsonl 优先（含完整 step 序列）；缺失时回退 DB 的 preview 字段。
 *
 * GLM-5.2 ❌：Antigravity 硬绑 Google OAuth，无法切换到 GLM-5.2。
 *   但 session 可被提取用于 handoff（见 mcp/codex-handoff.ts 模式），
 *   交由其他支持 GLM-5.2 的 agent 接力。
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

// node:sqlite 实验性内置，用 createRequire 运行时加载（同 store/cass）
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** macOS 默认 Antigravity 数据目录 */
const DEFAULT_ANTIGRAVITY_DATA_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Google',
  'Antigravity',
);

/** conversation_summaries.db 文件名 */
const ANTIGRAVITY_DB_FILENAME = 'conversation_summaries.db';

/** transcript 文件名 */
const TRANSCRIPT_FILENAME = 'transcript.jsonl';

/** 导入器选项 */
export interface AntigravityImportOptions {
  /** 直接指定 conversation_summaries.db 路径，优先级最高 */
  dbPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface AntigravityImportStats {
  /** 本次 scan_run id */
  scanRunId: number;
  /** antigravity source instance id */
  sourceInstanceId: string;
  /** 扫描到的 conversation 总数 */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 conversation 数（无消息 / 脏数据） */
  skipped: number;
  /** 入库的 subagent session 数（nesting_depth>0） */
  subagents: number;
  /** parent 不在扫描集的 subagent 数 */
  unlinkedSubagents: number;
  /** 写入的 spawned_by 关系数 */
  spawnedByRelationships: number;
  /** 写入的 sidechain_of 关系数（battle 模式） */
  sidechainRelationships: number;
  /** battle 模式（battle_id 非空）的会话数 */
  battles: number;
  /** 已被 killed 的会话数 */
  killed: number;
  /** transcript.jsonl 读取成功的会话数 */
  transcriptsRead: number;
  /** transcript 读取失败的会话数（回退到 preview） */
  transcriptFallbacks: number;
}

/** conversation_summaries 行（17 列） */
interface AntigravityConvRow {
  conversation_id: string;
  title: string | null;
  preview: string | null;
  step_count: number | null;
  last_modified_time: number | null;
  workspace_uris: string | null;
  status: string | null;
  source: string | null;
  project_id: string | null;
  agent_name: string | null;
  parent_conversation_id: string | null;
  nesting_depth: number | null;
  battle_id: string | null;
  winning_conversation_id: string | null;
  not_fully_idle: number | null;
  killed: number | null;
  last_user_input_time: number | null;
  last_user_input_step_index: number | null;
  app_data_dir: string | null;
}

/** transcript.jsonl 单行事件（松散结构） */
type TranscriptEvent = Record<string, unknown>;

/** 解析 conversation_summaries.db 路径 */
export function resolveAntigravityDbPath(options: { dbPath?: string } = {}): string {
  if (options.dbPath) return options.dbPath;
  const dataDir = process.env.ANTIGRAVITY_DATA_DIR ?? DEFAULT_ANTIGRAVITY_DATA_DIR;
  return path.join(dataDir, ANTIGRAVITY_DB_FILENAME);
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Antigravity 原生导入器。
 *
 * 用法：
 *   const importer = new AntigravityImporter(store, { deviceId });
 *   const stats = importer.import();
 */
export class AntigravityImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: AntigravityImportOptions = {},
  ) {}

  /** 执行一次完整导入，返回统计并写 scan_runs */
  import(): AntigravityImportStats {
    const dbPath = resolveAntigravityDbPath(this.options);

    let agy: DatabaseSyncType;
    try {
      agy = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
      throw new Error(`Antigravity conversation_summaries.db 不可读: ${dbPath} (${errorMessage(e)})`);
    }

    try {
      this.assertAntigravitySchema(agy, dbPath);

      const deviceId = this.options.deviceId ?? os.hostname();
      const rootPath = path.dirname(dbPath);
      const instance = this.store.registerSourceInstance({
        deviceId,
        source: 'antigravity',
        rootPath,
        coverage: 'A' as Coverage,
      });

      const runId = this.store.startScanRun({
        sourceInstanceId: instance.id,
        deviceId,
      });

      try {
        const counts = this.streamImport(agy, instance.id, deviceId);
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
      agy.close();
    }
  }

  private finishRunFailed(runId: number, err: unknown): void {
    try {
      this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
    } catch {
      /* 不掩盖原始错误 */
    }
  }

  /**
   * 校验 Antigravity schema：conversation_summaries 表 + 必需列。
   */
  private assertAntigravitySchema(agy: DatabaseSyncType, dbPath: string): void {
    const requiredCols = [
      'conversation_id',
      'parent_conversation_id',
      'nesting_depth',
      'battle_id',
      'winning_conversation_id',
      'killed',
      'app_data_dir',
      'workspace_uris',
      'last_modified_time',
      'agent_name',
    ];
    const tableInfo = agy.prepare('SELECT name FROM pragma_table_info(?)');
    const rows = tableInfo.all('conversation_summaries') as { name: string }[];
    if (rows.length === 0) {
      throw new Error(`Antigravity schema 不匹配: ${dbPath} — 缺少表 conversation_summaries`);
    }
    const present = new Set(rows.map((r) => r.name));
    const missing = requiredCols.filter((c) => !present.has(c));
    if (missing.length > 0) {
      throw new Error(
        `Antigravity schema 不匹配: ${dbPath} — 缺少列 ${missing.join(', ')}`,
      );
    }
  }

  /**
   * 流式导入：两遍处理。
   *   pass 1：遍历 conversation_summaries，解析 transcript.jsonl（或回退 preview），upsert session
   *   pass 2：建 spawned_by（parent_conversation_id）与 sidechain_of（battle_id）关系
   */
  private streamImport(
    agy: DatabaseSyncType,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<AntigravityImportStats, 'scanRunId' | 'sourceInstanceId'> {
    const stmt = agy.prepare(
      `SELECT conversation_id, title, preview, step_count, last_modified_time,
              workspace_uris, status, source, project_id, agent_name,
              parent_conversation_id, nesting_depth, battle_id,
              winning_conversation_id, not_fully_idle, killed,
              last_user_input_time, last_user_input_step_index, app_data_dir
       FROM conversation_summaries
       ORDER BY conversation_id`,
    );

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let subagents = 0;
    let unlinkedSubagents = 0;
    let spawnedByRelationships = 0;
    let sidechainRelationships = 0;
    let battles = 0;
    let killed = 0;
    let transcriptsRead = 0;
    let transcriptFallbacks = 0;

    /** conversation_id → 内部 session id（供 pass 2 建关系） */
    const internalIdByNative = new Map<string, string>();
    /** subagent 记录：{internalId, parentNativeId} */
    const subRecords: Array<{ internalId: string; parentNativeId?: string }> = [];
    /** battle 记录：{internalId, battleId, winnerNativeId} */
    const battleRecords: Array<{ internalId: string; battleId: string; winnerNativeId?: string }> = [];

    for (const row of stmt.iterate()) {
      const c = row as unknown as AntigravityConvRow;
      scanned++;

      const nativeSessionId = c.conversation_id;
      const parentNativeId = c.parent_conversation_id && c.parent_conversation_id.length > 0
        ? c.parent_conversation_id
        : undefined;
      const nestingDepth = c.nesting_depth ?? 0;
      const topology: SessionTopology = parentNativeId || nestingDepth > 0 ? 'subagent' : 'root';
      const cwd = this.extractFirstWorkspace(c.workspace_uris);

      if (c.killed !== null && c.killed !== 0) killed++;
      if (c.battle_id && c.battle_id.length > 0) battles++;

      // 解析 transcript.jsonl（优先）或回退 preview
      const parsed = this.parseConversation(c);
      if (parsed.transcriptOk) {
        transcriptsRead++;
      } else {
        transcriptFallbacks++;
      }
      if (parsed.messages.length === 0) {
        skipped++;
        continue;
      }

      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId,
        source: 'antigravity',
        cwd,
        projectPath: cwd,
        startedAt: parsed.startedAt ?? (c.last_modified_time ?? undefined),
        topology,
        sourceKind: 'A',
        messages: parsed.messages,
        model: parsed.model,
        cliVersion: c.agent_name ?? undefined,
      });
      internalIdByNative.set(nativeSessionId, result.sessionId);

      if (topology === 'subagent') {
        subagents++;
        subRecords.push({ internalId: result.sessionId, parentNativeId });
      }
      if (c.battle_id && c.battle_id.length > 0) {
        const winnerNativeId = c.winning_conversation_id && c.winning_conversation_id.length > 0
          ? c.winning_conversation_id
          : undefined;
        battleRecords.push({ internalId: result.sessionId, battleId: c.battle_id, winnerNativeId });
      }

      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    // pass 2：建 spawned_by 关系
    for (const sub of subRecords) {
      if (!sub.parentNativeId) {
        unlinkedSubagents++;
        continue;
      }
      const parentId = internalIdByNative.get(sub.parentNativeId);
      if (!parentId || parentId === sub.internalId) {
        unlinkedSubagents++;
        continue;
      }
      this.store.addRelationship({
        fromSessionId: sub.internalId,
        toSessionId: parentId,
        relationType: 'spawned_by',
        evidence: 'antigravity conversation_summaries.parent_conversation_id',
      });
      spawnedByRelationships++;
    }

    // pass 2：建 sidechain_of 关系（battle 模式中非 winner → winner）
    // battle 内同一 battle_id 的会话互为 sidechain；winner 是主线。
    // 此处简化：每个非 winner battle 记录建一条 sidechain_of 指向 winner（若 winner 在扫描集）
    const battleWinners = new Map<string, string | undefined>();
    for (const b of battleRecords) {
      if (b.winnerNativeId) {
        const winnerInternal = internalIdByNative.get(b.winnerNativeId);
        if (winnerInternal) battleWinners.set(b.battleId, winnerInternal);
      }
    }
    for (const b of battleRecords) {
      const winner = battleWinners.get(b.battleId);
      if (!winner || winner === b.internalId) continue;
      this.store.addRelationship({
        fromSessionId: b.internalId,
        toSessionId: winner,
        relationType: 'sidechain_of',
        evidence: `antigravity battle_id=${b.battleId}`,
      });
      sidechainRelationships++;
    }

    return {
      scanned,
      inserted,
      updated,
      unchanged,
      skipped,
      subagents,
      unlinkedSubagents,
      spawnedByRelationships,
      sidechainRelationships,
      battles,
      killed,
      transcriptsRead,
      transcriptFallbacks,
    };
  }

  /**
   * 解析单个 conversation：优先读 transcript.jsonl，失败回退 preview 字段。
   * 返回 { messages, startedAt, model, transcriptOk }。
   */
  private parseConversation(c: AntigravityConvRow): {
    messages: SessionMessageInput[];
    startedAt?: number;
    model?: string;
    transcriptOk: boolean;
  } {
    // 1. 优先读 transcript.jsonl
    if (c.app_data_dir) {
      const transcriptPath = path.join(c.app_data_dir, TRANSCRIPT_FILENAME);
      const parsed = this.parseTranscript(transcriptPath, c);
      if (parsed.transcriptOk && parsed.messages.length > 0) {
        return parsed;
      }
    }

    // 2. 回退：用 preview 字段构造单条 user 消息（保留会话身份）
    const preview = (c.preview ?? '').trim();
    if (preview.length > 0) {
      return {
        messages: [
          {
            role: 'user',
            content: preview,
            timestamp: c.last_modified_time ?? undefined,
          },
        ],
        startedAt: c.last_modified_time ?? undefined,
        model: undefined,
        transcriptOk: false,
      };
    }

    return { messages: [], transcriptOk: false };
  }

  /**
   * 解析 transcript.jsonl：每行一个 JSON 事件。
   * 提取可显示文本（user/assistant 消息），跳过 tool/internal 事件。
   */
  private parseTranscript(
    transcriptPath: string,
    c: AntigravityConvRow,
  ): { messages: SessionMessageInput[]; startedAt?: number; model?: string; transcriptOk: boolean } {
    if (!fs.existsSync(transcriptPath)) {
      return { messages: [], transcriptOk: false };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(transcriptPath, 'utf-8');
    } catch {
      return { messages: [], transcriptOk: false };
    }

    const messages: SessionMessageInput[] = [];
    let startedAt: number | undefined;
    let model: string | undefined;
    let ok = false;

    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt: TranscriptEvent;
      try {
        evt = JSON.parse(trimmed) as TranscriptEvent;
        ok = true;
      } catch {
        continue; // 脏行跳过
      }

      const ts = this.parseTimestamp(evt.timestamp ?? evt.ts ?? evt.created_at);
      if (ts !== undefined && (startedAt === undefined || ts < startedAt)) {
        startedAt = ts;
      }

      if (model === undefined) {
        const m = evt.model ?? evt.llm_model;
        if (typeof m === 'string') model = m;
      }

      const text = this.extractDisplayText(evt);
      if (text !== null) {
        const role = this.eventRole(evt);
        messages.push({ role, content: text, timestamp: ts });
      }
    }

    // 元数据回退：transcript 未含时间戳时用 DB 的 last_modified_time
    if (startedAt === undefined) startedAt = c.last_modified_time ?? undefined;

    return { messages, startedAt, model, transcriptOk: ok };
  }

  /**
   * 提取 transcript 事件的可显示文本。
   * Antigravity transcript 事件形态（逆向观察）：
   *   - role='user' + content / parts：用户输入
   *   - role='model'/'assistant' + content / parts：assistant 回复
   *   - role='tool' / functionCall：工具调用，排除
   *   - type='text'：纯文本块
   */
  private extractDisplayText(evt: TranscriptEvent): string | null {
    const role = typeof evt.role === 'string' ? evt.role : '';
    const type = typeof evt.type === 'string' ? evt.type : '';

    // tool/function 事件排除
    if (role === 'tool' || role === 'function' || type === 'functionCall' || type === 'tool_result') {
      return null;
    }

    // content 字段优先
    const content = evt.content;
    if (typeof content === 'string' && content.trim().length > 0) {
      return content;
    }

    // parts 数组（Gemini 风格）
    const parts = evt.parts;
    if (Array.isArray(parts)) {
      const out: string[] = [];
      for (const p of parts as unknown[]) {
        if (p && typeof p === 'object' && 'text' in p) {
          const t = (p as { text?: unknown }).text;
          if (typeof t === 'string' && t.length > 0) out.push(t);
        }
      }
      if (out.length > 0) return out.join('\n');
    }

    // text 字段
    const text = evt.text;
    if (typeof text === 'string' && text.trim().length > 0) {
      return text;
    }

    return null;
  }

  /** 把事件 role 映射为 yondermesh MessageRole */
  private eventRole(evt: TranscriptEvent): MessageRole {
    const role = typeof evt.role === 'string' ? evt.role : '';
    if (role === 'model' || role === 'assistant') return 'assistant';
    if (role === 'system') return 'system';
    if (role === 'tool') return 'tool';
    return 'user';
  }

  /** 解析时间戳（epoch 秒/毫秒或 ISO 字符串） */
  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value === 'number') {
      return value > 1e12 ? value : value * 1000;
    }
    if (typeof value === 'string' && value.length > 0) {
      if (/^\d+$/.test(value)) {
        const n = Number(value);
        return n > 1e12 ? n : n * 1000;
      }
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? undefined : ms;
    }
    return undefined;
  }

  /**
   * 从 workspace_uris 字段提取第一个 workspace 路径。
   * workspace_uris 形态（实测）：file:///path/to/repo（可能多个用空格/逗号分隔）。
   */
  private extractFirstWorkspace(workspaceUris: string | null): string | undefined {
    if (!workspaceUris) return undefined;
    const first = workspaceUris.split(/[\s,]+/)[0];
    if (!first) return undefined;
    // file:// URI → 本地路径
    if (first.startsWith('file://')) {
      try {
        return fileURLToPath(first);
      } catch {
        return first.replace(/^file:\/\//, '');
      }
    }
    return first;
  }
}

/** 把 file:// URI 转为本地路径（避免顶层 import URL） */
function fileURLToPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.replace(/^file:\/\//, '');
  }
}
