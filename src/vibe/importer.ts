/**
 * Vibe 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ~/.vibe/logs/session 下的 Vibe 原生 session 目录并入库。
 *
 * 真实结构（本机 ~/.vibe/logs/session 实测，2026-07，vibe v2.19.1）：
 *   - 路径：<rootPath>/session_<YYYYMMDD>_<HHMMSS>_<hex8>/         —— session 目录
 *   - 目录内：
 *       messages.jsonl —— 每行 { role, content, injected, message_id, reasoning_content? }
 *       meta.json      —— { session_id, parent_session_id, start_time, end_time,
 *                           environment.working_directory, stats{tokens}, title, ... }
 *
 * 核心约束：
 *   - 只读：绝不写入 Vibe 私有 session 文件。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = meta.session_id；缺失时回退目录名
 *   - 拓扑：meta.parent_session_id 非空 → subagent（spawned_by 关系）；否则 root
 *   - 消息：只取 role=user/assistant 的 content 文本；排除 injected=true（系统注入上下文）
 *     与 reasoning_content（思维链）。
 *   - 元数据：meta.stats 提供 token 用量；meta.environment.working_directory 提供 cwd；
 *     meta.start_time 提供 startedAt。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定；脏行跳过，无有效消息的目录跳过。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

/** macOS / 通用默认 Vibe sessions 目录 */
const DEFAULT_VIBE_SESSIONS_DIR = path.join(os.homedir(), '.vibe', 'logs', 'session');

/** session 目录名前缀 */
const SESSION_DIR_PREFIX = 'session_';

/** 导入器选项 */
export interface VibeImportOptions {
  /** 直接指定 Vibe sessions 根目录，默认 ~/.vibe/logs/session */
  rootPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface VibeImportStats {
  scanRunId: number;
  sourceInstanceId: string;
  /** 扫描到的 session 目录总数 */
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** 入库的 subagent session 数 */
  subagents: number;
  /** 有 parent 但父未入库、未写 spawned_by 的 subagent 数 */
  unlinkedSubagents: number;
  /** 写入的 spawned_by 关系数 */
  relationships: number;
}

/** 单条 messages.jsonl 行的松散结构 */
interface VibeMessageLine {
  role?: string;
  content?: string;
  injected?: boolean;
  message_id?: string;
  reasoning_content?: string;
}

/** meta.json 的松散结构 */
interface VibeMeta {
  session_id?: string;
  parent_session_id?: string | null;
  start_time?: string;
  end_time?: string | null;
  environment?: { working_directory?: string };
  title?: string;
  stats?: {
    session_prompt_tokens?: number;
    session_completion_tokens?: number;
    context_tokens?: number;
    steps?: number;
  };
}

/** 一个 session 目录的解析结果 */
interface ParsedSession {
  nativeId: string;
  parentNativeId?: string;
  cwd?: string;
  startedAt?: number;
  title?: string;
  messages: SessionMessageInput[];
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

/** 解析 Vibe sessions 根目录 */
export function resolveVibeSessionsPath(options: { rootPath?: string } = {}): string {
  return options.rootPath ?? DEFAULT_VIBE_SESSIONS_DIR;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 解析 ISO 时间戳为 epoch 毫秒 */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Vibe 原生导入器。
 *
 * 用法：
 *   const importer = new VibeImporter(store, { rootPath, deviceId });
 *   const stats = importer.import();
 */
export class VibeImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: VibeImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): VibeImportStats {
    const rootPath = resolveVibeSessionsPath(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`Vibe sessions 目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Vibe sessions 路径不是目录: ${rootPath}`);
    }

    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'vibe',
      rootPath,
      coverage: 'A' as Coverage,
    });

    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.scanTree(rootPath, instance.id, deviceId);
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

  private finishRunFailed(runId: number, err: unknown): void {
    try {
      this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
    } catch {
      /* scan_run 记录写入失败不应掩盖原始错误 */
    }
  }

  private scanTree(
    rootPath: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<VibeImportStats, 'scanRunId' | 'sourceInstanceId'> {
    const dirs = this.collectSessionDirs(rootPath);

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let subagents = 0;
    let unlinkedSubagents = 0;
    let relationships = 0;

    const sessionIdByNative = new Map<string, string>();
    const subRecords: Array<{ internalId: string; parentNativeId?: string }> = [];

    for (const dir of dirs) {
      scanned++;
      const parsed = this.parseSessionDir(dir);
      if (!parsed) {
        skipped++;
        continue;
      }
      const isSub = parsed.parentNativeId !== undefined;
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.nativeId,
        source: 'vibe',
        cwd: parsed.cwd,
        projectPath: parsed.cwd,
        startedAt: parsed.startedAt,
        topology: isSub ? 'subagent' : 'root',
        sourceKind: 'A',
        messages: parsed.messages,
        totalInputTokens: parsed.totalInputTokens,
        totalOutputTokens: parsed.totalOutputTokens,
      });
      sessionIdByNative.set(parsed.nativeId, result.sessionId);
      if (isSub) {
        subagents++;
        subRecords.push({ internalId: result.sessionId, parentNativeId: parsed.parentNativeId });
      }
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    // subagent → parent spawned_by（仅可验证父）
    for (const sub of subRecords) {
      if (!sub.parentNativeId) continue;
      const parentId = sessionIdByNative.get(sub.parentNativeId);
      if (!parentId || parentId === sub.internalId) {
        unlinkedSubagents++;
        continue;
      }
      this.store.addRelationship({
        fromSessionId: sub.internalId,
        toSessionId: parentId,
        relationType: 'spawned_by',
        evidence: 'vibe meta.parent_session_id',
      });
      relationships++;
    }

    return { scanned, inserted, updated, unchanged, skipped, subagents, unlinkedSubagents, relationships };
  }

  /** 收集 rootPath 下所有 session_* 目录，按名稳定排序 */
  private collectSessionDirs(rootPath: string): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith(SESSION_DIR_PREFIX)) {
        out.push(path.join(rootPath, e.name));
      }
    }
    out.sort();
    return out;
  }

  /** 解析单个 session 目录（meta.json + messages.jsonl） */
  private parseSessionDir(dir: string): ParsedSession | null {
    // 1. meta.json
    let meta: VibeMeta = {};
    try {
      const metaRaw = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
      meta = JSON.parse(metaRaw) as VibeMeta;
    } catch {
      /* meta 缺失 → 仍尝试读 messages，用目录名作 native id */
    }

    // 2. messages.jsonl
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8');
    } catch {
      return null; // 无消息文件 → 跳过
    }

    const messages: SessionMessageInput[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: VibeMessageLine;
      try {
        obj = JSON.parse(trimmed) as VibeMessageLine;
      } catch {
        continue; // 脏行跳过
      }
      // 仅 user/assistant；排除 injected=true（系统注入上下文）
      if (obj.role !== 'user' && obj.role !== 'assistant') continue;
      if (obj.injected === true) continue;
      const content = typeof obj.content === 'string' ? obj.content.trim() : '';
      if (content.length === 0) continue;
      // reasoning_content 是思维链，不入库
      messages.push({ role: obj.role as MessageRole, content: obj.content!, timestamp: undefined });
    }

    if (messages.length === 0) return null;

    const nativeId = meta.session_id && meta.session_id.length > 0
      ? meta.session_id
      : path.basename(dir);
    const parentNativeId =
      typeof meta.parent_session_id === 'string' && meta.parent_session_id.length > 0
        ? meta.parent_session_id
        : undefined;
    const cwd = meta.environment?.working_directory;
    const startedAt = parseTimestamp(meta.start_time);
    const totalInputTokens = meta.stats?.session_prompt_tokens;
    const totalOutputTokens = meta.stats?.session_completion_tokens;

    return { nativeId, parentNativeId, cwd, startedAt, title: meta.title, messages, totalInputTokens, totalOutputTokens };
  }
}
