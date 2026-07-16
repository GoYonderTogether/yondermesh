/**
 * Cursor IDE session 提取器（覆盖等级 B —— 兼容 importer）
 *
 * Cursor 把 chat history 存在两处：
 *   1. SQLite（primary）：~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *      - 表 cursorDiskKV(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)
 *      - value 实测是 JSON 文本（非 protobuf），可直接 JSON.parse
 *      - 关键 key 前缀：
 *          composerData:<composerId-uuid>          —— 顶层 session 元数据
 *            (composerId / name / status / createdAt / lastUpdatedAt /
 *             fullConversationHeadersOnly:[{bubbleId,type}] —— bubble 顺序与类型)
 *          bubbleId:<composerId>:<bubbleId-uuid>    —— 单条消息 bubble
 *            (type:1=user / 2=assistant, text / richText / createdAt / requestId)
 *          composer.content.<sha256>                —— 大块内容（文件引用/工具结果，本次跳过）
 *          checkpointId:<composerId>:<bubbleId>    —— checkpoint 元数据（本次跳过）
 *          agentKv:blob:<hash>                      —— agent KV 缓存（本次跳过）
 *          ofsContent:<sessionId>:<fileUri>         —— 虚拟文件系统内容（本次跳过）
 *   2. JSONL（secondary，纯文本 transcript）：
 *      ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
 *      每行 {role:"user"|"assistant", message:{content:[{type:"text", text}]}}
 *      sessionId 与 SQLite composerData.composerId 同 uuid 空间，可关联。
 *
 * 采集策略（双轨）：
 *   - SQLite 为主：composerData 提供会话元数据 + bubble 列表顺序；bubbleId 提供
 *     每条消息的 text/type/createdAt。SQLite 内 text 是明文（richText 是 Lexical JSON）。
 *   - JSONL 为补充：当某 composerId 在 SQLite 缺 bubbleId 时（旧 session / 跨设备同步丢消息），
 *     从对应 agent-transcripts/<sessionId>/*.jsonl 读取消息补齐。
 *   - 元数据：cwd 优先用 composerData.workspaceUris[0] / context（实测多为空），回退到
 *     ~/.cursor/projects/<encoded-cwd> 路径解码（best-effort，含字面 `-` 的路径有歧义）。
 *   - startedAt 优先用 composerData.createdAt（毫秒），回退首个 bubble.createdAt（ISO 字符串），
 *     回退 JSONL 文件 mtime。
 *
 * 核心约束（沿用架构 §2 / §4）：
 *   - 只读：绝不写入 Cursor 私有 state.vscdb / agent-transcripts。
 *   - 身份三元组：device_id + source_instance_id + native_session_id
 *       native_session_id = composerId（UUID，与 JSONL 路径 UUID 同空间）。
 *   - 消息：只取 user/assistant 可显示 text；排除 thinking / tool_use / tool_result /
 *     context / capabilities / lint 等内部块。SQLite 已天然过滤（bubble 只存最终文本）。
 *   - 拓扑：Cursor 当前无 subagent 概念，所有 session 一律 topology=root。
 *   - 幂等：依赖 SessionStore.content_hash 判定。
 *
 * SQLite 访问：用系统 sqlite3 CLI（child_process.execFileSync），保持 yondermesh 零运行时依赖。
 * macOS 内置 /usr/bin/sqlite3；其他平台需 PATH 中可用。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

/** macOS Cursor globalStorage state.vscdb 默认路径 */
const DEFAULT_CURSOR_GLOBAL_VSCDB = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Cursor',
  'User',
  'globalStorage',
  'state.vscdb',
);

/** Cursor projects 根目录（JSONL agent-transcripts） */
const DEFAULT_CURSOR_PROJECTS_DIR = path.join(os.homedir(), '.cursor', 'projects');

/** composerId 前缀（用于过滤 cursorDiskKV） */
const COMPOSER_DATA_PREFIX = 'composerData:';
/** bubbleId 前缀（格式：bubbleId:<composerId>:<bubbleId>） */
const BUBBLE_ID_PREFIX = 'bubbleId:';

/** bubble type → role 映射（实测 1=user, 2=assistant；仅检查 assistant，其余视为 user） */
const BUBBLE_TYPE_ASSISTANT = 2;

/** 导入器选项 */
export interface CursorIdeExtractOptions {
  /** 直接指定 state.vscdb 路径，默认 ~/.cursor/globalStorage 路径 */
  vscdbPath?: string;
  /** 直接指定 ~/.cursor/projects 根，默认 ~/.cursor/projects */
  projectsDir?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
  /** 跳过 SQLite 读取（仅用 JSONL） */
  sqliteOnly?: boolean;
  /** 跳过 JSONL 读取（仅用 SQLite） */
  jsonlOnly?: boolean;
}

/** 导入统计 */
export interface CursorIdeExtractStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** cursor-ide source instance id */
  sourceInstanceId: string;
  /** 扫描到的 session 总数（composerId 唯一） */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 session 数（无有效消息） */
  skipped: number;
  /** 从 JSONL 补齐消息的 session 数 */
  jsonlBackfilled: number;
  /** SQLite 中读取的 composer 总数 */
  sqliteComposers: number;
  /** JSONL 中读取的 transcript 总数 */
  jsonlTranscripts: number;
}

/** composerData JSON 松散结构 */
interface ComposerData {
  _v?: number;
  composerId?: string;
  name?: string;
  status?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  /** bubble 列表（顺序即对话顺序），含 bubbleId 与 type(1=user/2=assistant) */
  fullConversationHeadersOnly?: Array<{ bubbleId: string; type: number }>;
  /** 子 composer（agent / best-of-N），本次不递归，仅记录存在 */
  subComposerIds?: string[];
  subagentComposerIds?: string[];
  /** 模型配置（modelConfig.modelName） */
  modelConfig?: { modelName?: string };
  /** 模型回退：latestChatGenerationUUID */
  latestChatGenerationUUID?: string;
}

/** bubbleId JSON 松散结构 */
interface BubbleData {
  _v?: number;
  bubbleId?: string;
  type?: number;
  /** 明文消息文本（首选） */
  text?: string;
  /** Lexical JSON 富文本（次选，解析后取纯文本） */
  richText?: string;
  /** ISO 字符串 */
  createdAt?: string;
  /** 模型信息 */
  modelInfo?: { modelName?: string };
  /** request id 关联 composerData.latestChatGenerationUUID */
  requestId?: string;
  /** context 列表（含 thinking/tool_use 等，本次排除） */
  context?: unknown[];
}

/** 单条 JSONL 行（agent-transcripts 实测格式） */
interface CursorTranscriptLine {
  role?: 'user' | 'assistant';
  message?: { content?: Array<{ type: string; text?: string }> };
}

/** 解析后的 session 数据 */
interface ParsedCursorSession {
  /** composerId（= native session id） */
  composerId: string;
  /** 会话标题（composerData.name） */
  name?: string;
  /** 模型名（来自 composerData.modelConfig 或 bubble.modelInfo） */
  model?: string;
  /** startedAt 毫秒 */
  startedAt?: number;
  /** lastUpdatedAt 毫秒（用于 lastSeenAt） */
  lastUpdatedAt?: number;
  /** cwd（best-effort 解码自 ~/.cursor/projects 路径） */
  cwd?: string;
  /** 消息列表 */
  messages: SessionMessageInput[];
  /** 来源标记：sqlite / jsonl / both */
  source: 'sqlite' | 'jsonl' | 'both';
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 解码 ~/.cursor/projects 下的 encoded-cwd 目录名为绝对路径。
 * 实测 Cursor 用 `-` 替换 `/`，但不区分字面 `-`（agent-team-service 无法恢复原貌）。
 * 此处 best-effort：把所有 `-` 当作 `/`，前置 `/`。
 * 含字面 `-` 的路径会有歧义，但常见项目路径（不含 `-`）可正确恢复。
 */
function decodeCursorProjectDir(dirName: string): string {
  // 不以 `-` 开头：直接替换；以 `-` 开头：去掉首 `-` 后替换（Trae 风格，Cursor 极少出现）
  const stripped = dirName.startsWith('-') ? dirName.slice(1) : dirName;
  return '/' + stripped.split('-').join('/');
}

/**
 * 调用系统 sqlite3 CLI 执行查询，返回 JSON 行数组。
 * 用 -json 模式让 sqlite3 直接输出 JSON 数组。
 * value BLOB 列在 -json 模式下若为合法 UTF-8 会作为字符串返回。
 */
function querySqlite(dbPath: string, sql: string): Array<Record<string, unknown>> {
  let out: string;
  try {
    out = execFileSync('sqlite3', [dbPath, '-json', sql], {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(`sqlite3 查询失败 (${dbPath}): ${errorMessage(e)}`);
  }
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    throw new Error(`sqlite3 JSON 解析失败 (${dbPath}): ${errorMessage(e)}`);
  }
}

/** 安全 JSON.parse：失败返回 undefined */
function safeJsonParse<T = unknown>(s: string | undefined | null): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/**
 * 从 Lexical richText JSON 中提取纯文本（best-effort）。
 * richText 结构：{root:{children:[{children:[{text:"...",type:"text"}],type:"paragraph"}]}}
 */
function extractPlainTextFromLexical(richText: string | undefined): string | undefined {
  if (!richText) return undefined;
  const parsed = safeJsonParse<{ root?: { children?: Array<{ children?: Array<{ text?: string }> }> } }>(richText);
  if (!parsed?.root?.children) return undefined;
  const parts: string[] = [];
  for (const para of parsed.root.children) {
    if (!para.children) continue;
    for (const node of para.children) {
      if (typeof node.text === 'string') parts.push(node.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * 从 bubble 提取可显示文本：
 *   - 优先 text（明文）
 *   - 次选 richText（Lexical JSON，提取纯文本）
 *   - 都缺失返回 undefined
 */
function extractBubbleText(bubble: BubbleData): string | undefined {
  if (typeof bubble.text === 'string' && bubble.text.trim().length > 0) {
    return bubble.text;
  }
  return extractPlainTextFromLexical(bubble.richText);
}

/** ISO 字符串 → 毫秒；非法返回 undefined */
function parseIsoToMs(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * 读取 Cursor globalStorage/state.vscdb，提取 composerData + bubbleId。
 * 返回 composerId → ParsedCursorSession 映射。
 */
function readCursorSqlite(vscdbPath: string): Map<string, ParsedCursorSession> {
  const sessions = new Map<string, ParsedCursorSession>();
  /** composerId → fullConversationHeadersOnly（仅排序用，不入 ParsedCursorSession） */
  const headersByComposer = new Map<string, Array<{ bubbleId: string; type: number }>>();

  // 1. 读取所有 composerData
  const composerRows = querySqlite(
    vscdbPath,
    `SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE '${COMPOSER_DATA_PREFIX}%';`,
  );
  for (const row of composerRows) {
    const key = String(row.key ?? '');
    const composerId = key.slice(COMPOSER_DATA_PREFIX.length);
    if (!composerId) continue;
    const data = safeJsonParse<ComposerData>(String(row.value ?? ''));
    if (!data) continue;
    sessions.set(composerId, {
      composerId,
      name: data.name,
      model: data.modelConfig?.modelName !== 'default' ? data.modelConfig?.modelName : undefined,
      startedAt: typeof data.createdAt === 'number' ? data.createdAt : undefined,
      lastUpdatedAt: typeof data.lastUpdatedAt === 'number' ? data.lastUpdatedAt : undefined,
      messages: [],
      source: 'sqlite',
    });
    if (Array.isArray(data.fullConversationHeadersOnly) && data.fullConversationHeadersOnly.length > 0) {
      headersByComposer.set(composerId, data.fullConversationHeadersOnly);
    }
  }

  // 2. 读取所有 bubbleId，按 composerId 分组
  const bubbleRows = querySqlite(
    vscdbPath,
    `SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE '${BUBBLE_ID_PREFIX}%';`,
  );
  /** composerId → bubbleId 列表（保持 SQLite 返回顺序） */
  const bubblesByComposer = new Map<string, BubbleData[]>();
  for (const row of bubbleRows) {
    const key = String(row.key ?? '');
    // 格式：bubbleId:<composerId>:<bubbleId>
    const rest = key.slice(BUBBLE_ID_PREFIX.length);
    const sepIdx = rest.indexOf(':');
    if (sepIdx < 0) continue;
    const composerId = rest.slice(0, sepIdx);
    if (!composerId) continue;
    const bubble = safeJsonParse<BubbleData>(String(row.value ?? ''));
    if (!bubble) continue;
    let list = bubblesByComposer.get(composerId);
    if (!list) {
      list = [];
      bubblesByComposer.set(composerId, list);
    }
    list.push(bubble);
  }

  // 3. 把 bubble 按 composerData.fullConversationHeadersOnly 顺序排进 messages
  for (const [composerId, bubbles] of bubblesByComposer) {
    let sess = sessions.get(composerId);
    if (!sess) {
      // SQLite 中有 bubble 但无 composerData（孤儿）：建一个最小 session 头
      sess = {
        composerId,
        messages: [],
        source: 'sqlite',
      };
      sessions.set(composerId, sess);
    }
    const headers = headersByComposer.get(composerId);
    const ordered = headers ? orderBubblesByHeaders(bubbles, headers) : bubbles;
    for (const bubble of ordered) {
      const text = extractBubbleText(bubble);
      if (!text) continue;
      const role: MessageRole = bubble.type === BUBBLE_TYPE_ASSISTANT ? 'assistant' : 'user';
      sess.messages.push({
        role,
        content: text,
        timestamp: parseIsoToMs(bubble.createdAt),
      });
      if (!sess.model && bubble.modelInfo?.modelName && bubble.modelInfo.modelName !== 'default') {
        sess.model = bubble.modelInfo.modelName;
      }
    }
  }

  return sessions;
}

/** 按 composerData.fullConversationHeadersOnly 的顺序排 bubble（缺失的 bubble 追加末尾） */
function orderBubblesByHeaders(
  bubbles: BubbleData[],
  headers: Array<{ bubbleId: string; type: number }>,
): BubbleData[] {
  const byId = new Map<string, BubbleData>();
  for (const b of bubbles) {
    if (b.bubbleId) byId.set(b.bubbleId, b);
  }
  const ordered: BubbleData[] = [];
  const seen = new Set<string>();
  for (const h of headers) {
    const b = byId.get(h.bubbleId);
    if (b) {
      ordered.push(b);
      seen.add(h.bubbleId);
    }
  }
  for (const b of bubbles) {
    if (b.bubbleId && !seen.has(b.bubbleId)) ordered.push(b);
  }
  return ordered;
}

/**
 * 扫描 ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
 * 返回 sessionId → ParsedCursorSession 映射。
 */
function readCursorJsonl(projectsDir: string): {
  sessions: Map<string, ParsedCursorSession>;
  /** sessionId → 解码后的 cwd */
  cwdBySession: Map<string, string>;
} {
  const sessions = new Map<string, ParsedCursorSession>();
  const cwdBySession = new Map<string, string>();

  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return { sessions, cwdBySession };
  }

  for (const projDir of projectEntries) {
    if (!projDir.isDirectory()) continue;
    const cwd = decodeCursorProjectDir(projDir.name);
    const transcriptsDir = path.join(projectsDir, projDir.name, 'agent-transcripts');
    let sessionDirs: fs.Dirent[];
    try {
      sessionDirs = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessDir of sessionDirs) {
      if (!sessDir.isDirectory()) continue;
      const sessionId = sessDir.name;
      const jsonlPath = path.join(transcriptsDir, sessionId, `${sessionId}.jsonl`);
      let raw: string;
      try {
        raw = fs.readFileSync(jsonlPath, 'utf8');
      } catch {
        continue;
      }
      const messages: SessionMessageInput[] = [];
      let earliest: number | undefined;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const obj = safeJsonParse<CursorTranscriptLine>(trimmed);
        if (!obj || (obj.role !== 'user' && obj.role !== 'assistant')) continue;
        const blocks = obj.message?.content;
        if (!Array.isArray(blocks)) continue;
        const parts: string[] = [];
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
        }
        if (parts.length === 0) continue;
        const text = parts.join('\n');
        if (text.trim().length === 0) continue;
        messages.push({ role: obj.role, content: text });
        // JSONL 行无 timestamp；用文件 mtime 作为 fallback（在下面统一处理）
      }
      if (messages.length === 0) continue;
      // 用文件 mtime 作为 startedAt fallback
      let mtime: number | undefined;
      try {
        mtime = fs.statSync(jsonlPath).mtimeMs;
        earliest = mtime;
      } catch {
        // ignore
      }
      sessions.set(sessionId, {
        composerId: sessionId,
        cwd,
        messages,
        startedAt: earliest,
        source: 'jsonl',
      });
      cwdBySession.set(sessionId, cwd);
    }
  }

  return { sessions, cwdBySession };
}

/**
 * 合并 SQLite 与 JSONL 提取结果：
 *   - SQLite 为主：优先用 SQLite 的 messages / metadata
 *   - JSONL 补齐：SQLite 中无消息（仅有 composerData 元数据）但 JSONL 有的 session，
 *     用 JSONL 的 messages，并补齐 cwd / startedAt
 *   - 同 sessionId 时合并：messages 用 SQLite 的（更准确，含 createdAt）；cwd 用 JSONL 的
 *     （SQLite 无 cwd 字段）；startedAt 取较小值
 */
function mergeSqliteAndJsonl(
  sqliteSessions: Map<string, ParsedCursorSession>,
  jsonlSessions: Map<string, ParsedCursorSession>,
): { sessions: ParsedCursorSession[]; jsonlBackfilled: number } {
  const merged: ParsedCursorSession[] = [];
  let jsonlBackfilled = 0;

  // SQLite 中的 session
  for (const [composerId, sess] of sqliteSessions) {
    const jsonlSess = jsonlSessions.get(composerId);
    if (jsonlSess) {
      // 合并：messages 用 SQLite 的；cwd / startedAt 用 JSONL 补齐
      if (sess.messages.length === 0 && jsonlSess.messages.length > 0) {
        sess.messages = jsonlSess.messages;
        jsonlBackfilled++;
      }
      if (!sess.cwd && jsonlSess.cwd) sess.cwd = jsonlSess.cwd;
      if (!sess.startedAt && jsonlSess.startedAt) sess.startedAt = jsonlSess.startedAt;
      if (!sess.lastUpdatedAt && jsonlSess.startedAt) sess.lastUpdatedAt = jsonlSess.startedAt;
      sess.source = 'both';
    }
    merged.push(sess);
  }

  // 仅 JSONL 有、SQLite 没有的 session（旧 session / 跨设备同步丢的）
  for (const [composerId, sess] of jsonlSessions) {
    if (sqliteSessions.has(composerId)) continue;
    merged.push(sess);
  }

  return { sessions: merged, jsonlBackfilled };
}

/**
 * Cursor IDE 提取器。
 *
 * 用法：
 *   const extractor = new CursorIdeExtractor(store, { vscdbPath, projectsDir });
 *   const stats = extractor.extract();
 */
export class CursorIdeExtractor {
  constructor(
    private readonly store: SessionStore,
    private readonly options: CursorIdeExtractOptions = {},
  ) {}

  /** 执行一次完整提取，返回统计并写 scan_runs */
  extract(): CursorIdeExtractStats {
    const vscdbPath = this.options.vscdbPath ?? DEFAULT_CURSOR_GLOBAL_VSCDB;
    const projectsDir = this.options.projectsDir ?? DEFAULT_CURSOR_PROJECTS_DIR;
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. 注册 coverage=B 的 cursor-ide source instance
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'cursor-ide',
      rootPath: vscdbPath,
      coverage: 'B' as Coverage,
    });

    // 2. 开始 scan_run
    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.doExtract(vscdbPath, projectsDir, instance.id, deviceId);
      this.store.finishScanRun(runId, {
        status: 'completed',
        sessionsSeen: counts.scanned,
        sessionsNew: counts.inserted,
        sessionsUpdated: counts.updated,
      });
      return { scanRunId: runId, sourceInstanceId: instance.id, ...counts };
    } catch (err) {
      try {
        this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
      } catch {
        /* 不掩盖原始错误 */
      }
      throw err;
    }
  }

  /** 实际提取逻辑 */
  private doExtract(
    vscdbPath: string,
    projectsDir: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<CursorIdeExtractStats, 'scanRunId' | 'sourceInstanceId'> {
    // 1. 读 SQLite
    let sqliteSessions = new Map<string, ParsedCursorSession>();
    let sqliteComposers = 0;
    if (!this.options.jsonlOnly) {
      try {
        sqliteSessions = readCursorSqlite(vscdbPath);
        sqliteComposers = sqliteSessions.size;
      } catch (e) {
        // SQLite 不可读 → 仅依赖 JSONL（降级）
        // 不抛出，继续
        void e;
      }
    }

    // 2. 读 JSONL
    let jsonlSessions = new Map<string, ParsedCursorSession>();
    let jsonlTranscripts = 0;
    if (!this.options.sqliteOnly) {
      const r = readCursorJsonl(projectsDir);
      jsonlSessions = r.sessions;
      jsonlTranscripts = jsonlSessions.size;
    }

    // 3. 合并（cwd 已嵌入每个 jsonlSess.cwd，无需单独传递）
    const { sessions, jsonlBackfilled } = mergeSqliteAndJsonl(
      sqliteSessions,
      jsonlSessions,
    );

    // 4. 入库
    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const sess of sessions) {
      scanned++;
      if (sess.messages.length === 0) {
        skipped++;
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: sess.composerId,
        source: 'cursor-ide',
        cwd: sess.cwd,
        projectPath: sess.cwd,
        startedAt: sess.startedAt,
        topology: 'root',
        sourceKind: 'B',
        messages: sess.messages,
        model: sess.model,
        // Cursor 无 cli_version 概念，记录 source 标记
        entrySource: sess.source === 'both' ? 'sqlite+jsonl' : sess.source,
      });
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    return {
      scanned,
      inserted,
      updated,
      unchanged,
      skipped,
      jsonlBackfilled,
      sqliteComposers,
      jsonlTranscripts,
    };
  }
}
