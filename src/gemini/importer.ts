/**
 * Gemini CLI 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ~/.gemini/tmp 下的 Gemini CLI 原生 session（单 JSON 文件，非 JSONL），
 * 解析为 ymesh StoredSession 入库。
 *
 * 真实结构（本机 ~/.gemini/tmp 实测，2026-07，gemini v0.50.0）：
 *   - 路径：<rootPath>/<projectHashOrName>/chats/session-<timestamp>-<shortid>.json
 *   - 单 JSON 文件（非 JSONL），顶层字段：
 *       sessionId, projectHash, startTime, lastUpdated, messages, kind
 *   - messages 数组，每条：id, timestamp, type, content, thoughts, tokens, model
 *   - type：user / gemini（gemini 即 assistant）
 *   - content：user 为 [{text}] 数组；gemini 为字符串
 *   - thoughts：思维链数组（排除，不导入）
 *   - tokens：{ input, output, cached, thoughts, tool, total }（丰富 token 统计）
 *   - model：模型名（如 gemini-3-flash-preview），仅 gemini 行有
 *
 * 核心约束：
 *   - 只读：绝不写入 Gemini 私有 session 文件（架构 §2 关键取舍）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = sessionId 字段；缺失时回退相对 rootPath 的稳定 posix 路径
 *   - 拓扑：Gemini CLI 当前无 subagent 概念，所有 session 均为 root。
 *   - 消息：只取 user/gemini 的可显示文本；排除 thoughts（思维链）。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定；脏文件跳过，无有效消息的文件跳过。
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

/** macOS / 通用默认 Gemini CLI session 根目录 */
const DEFAULT_GEMINI_SESSIONS_DIR = path.join(os.homedir(), '.gemini', 'tmp');

/** chats 目录段名（session JSON 仅在该段下） */
const CHATS_SEGMENT = 'chats';

/** session 文件名前缀 */
const SESSION_FILENAME_PREFIX = 'session-';

/** 导入器选项 */
export interface GeminiImportOptions {
  /** 直接指定 Gemini sessions 根目录，默认 ~/.gemini/tmp */
  rootPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface GeminiImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** gemini source instance id */
  sourceInstanceId: string;
  /** 扫描到的 JSON 文件总数 */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的文件数（无有效消息 / 脏文件） */
  skipped: number;
}

/** session JSON 顶层的松散结构 */
interface GeminiSessionJson {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: unknown[];
  kind?: string;
}

/** 单条 message 的松散结构 */
interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  thoughts?: unknown[];
  tokens?: GeminiTokens;
  model?: string;
}

/** message.tokens 的松散结构 */
interface GeminiTokens {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
}

/** 一个文件的解析结果 */
interface ParsedSession {
  /** native session id（sessionId 字段，缺失回退相对路径） */
  nativeId: string;
  /** projectHash（作为 projectPath 标识，Gemini 不存真实 cwd） */
  projectHash?: string;
  startedAt?: number;
  messages: SessionMessageInput[];
  model?: string;
  /** 累加的 token 统计 */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  grandTotalTokens?: number;
  toolCallCount?: number;
}

/** 解析 Gemini sessions 根目录：rootPath 选项优先，否则回退默认路径 */
export function resolveGeminiSessionsPath(options: { rootPath?: string } = {}): string {
  return options.rootPath ?? DEFAULT_GEMINI_SESSIONS_DIR;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 路径转 posix 风格（相对 native id 跨平台稳定） */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Gemini CLI 原生导入器。
 *
 * 用法：
 *   const importer = new GeminiImporter(store, { rootPath, deviceId });
 *   const stats = importer.import();
 */
export class GeminiImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: GeminiImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): GeminiImportStats {
    const rootPath = resolveGeminiSessionsPath(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. rootPath 必须可读目录
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`Gemini sessions 目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Gemini sessions 路径不是目录: ${rootPath}`);
    }

    // 2. 注册 coverage=A 的 gemini source instance（rootPath=扫描根）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'gemini',
      rootPath,
      coverage: 'A' as Coverage,
    });

    // 3. 开始 scan_run
    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.scanTree(rootPath, instance.id, deviceId);
      // 4. 正常完成
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
   * 扫描整棵树：收集 chats 目录下的所有 session-*.json 文件，逐文件解析入库。
   * Gemini CLI 无 subagent 概念，所有 session 均为 root topology。
   */
  private scanTree(
    rootPath: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<GeminiImportStats, 'scanRunId' | 'sourceInstanceId'> {
    const files = this.collectSessionFiles(rootPath);

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const absPath of files) {
      scanned++;
      const parsed = this.parseFile(absPath, rootPath);
      if (!parsed) {
        skipped++; // 无有效消息 → 跳过该文件
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.nativeId,
        source: 'gemini',
        // Gemini 不存真实 cwd，用 projectHash 作为 projectPath 标识
        projectPath: parsed.projectHash,
        startedAt: parsed.startedAt,
        topology: 'root',
        sourceKind: 'A',
        messages: parsed.messages,
        model: parsed.model,
        totalInputTokens: parsed.totalInputTokens,
        totalOutputTokens: parsed.totalOutputTokens,
        totalCacheReadTokens: parsed.totalCacheReadTokens,
        grandTotalTokens: parsed.grandTotalTokens,
        toolCallCount: parsed.toolCallCount,
      });
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    return { scanned, inserted, updated, unchanged, skipped };
  }

  /**
   * 递归收集 rootPath 下所有应扫描的 session-*.json 文件。
   * 仅收集位于 chats/ 段下、以 session- 开头的 .json 文件。
   * 单个目录不可读 → 跳过该目录，不中断整棵树。
   */
  private collectSessionFiles(rootPath: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(abs);
        } else if (
          e.isFile() &&
          e.name.startsWith(SESSION_FILENAME_PREFIX) &&
          e.name.endsWith('.json')
        ) {
          const rel = toPosix(path.relative(rootPath, abs));
          const segs = rel.split('/');
          if (segs.includes(CHATS_SEGMENT)) {
            out.push(abs);
          }
        }
      }
    };
    walk(rootPath);
    out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return out;
  }

  /**
   * 解析单个 session JSON 文件，返回 native id / 最早时间 / 消息。
   * JSON 损坏返回 null（跳过文件）；无有效消息返回 null。
   */
  private parseFile(absPath: string, rootPath: string): ParsedSession | null {
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }

    let doc: GeminiSessionJson;
    try {
      doc = JSON.parse(raw) as GeminiSessionJson;
    } catch {
      return null; // JSON 损坏 → 跳过
    }

    const relPath = toPosix(path.relative(rootPath, absPath));
    const nativeId =
      typeof doc.sessionId === 'string' && doc.sessionId.length > 0
        ? doc.sessionId
        : relPath;

    const projectHash =
      typeof doc.projectHash === 'string' && doc.projectHash.length > 0
        ? doc.projectHash
        : undefined;

    const startedAt = this.parseTimestamp(doc.startTime);

    const messages: SessionMessageInput[] = [];
    let model: string | undefined;
    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;
    let totalCacheReadTokens: number | undefined;
    let grandTotalTokens: number | undefined;
    let toolCallCount: number | undefined;

    const msgList = Array.isArray(doc.messages) ? doc.messages : [];
    for (const raw of msgList) {
      const m = raw as GeminiMessage;
      if (!m || typeof m.type !== 'string') continue;

      // 仅取 user / gemini（assistant）的可显示文本
      const role = this.mapRole(m.type);
      if (!role) continue; // 未知 type → 跳过（不导入 thoughts / tool 等内部消息）

      const text = this.extractDisplayText(m);
      if (text === null) continue;

      const ts = this.parseTimestamp(m.timestamp);
      messages.push({ role, content: text, timestamp: ts });

      // 元数据：取首条 gemini 消息的 model
      if (model === undefined && m.type === 'gemini' && typeof m.model === 'string') {
        model = m.model;
      }

      // 累加 token 统计（gemini 消息才有 tokens）
      if (m.tokens) {
        if (typeof m.tokens.input === 'number') {
          totalInputTokens = (totalInputTokens ?? 0) + m.tokens.input;
        }
        if (typeof m.tokens.output === 'number') {
          totalOutputTokens = (totalOutputTokens ?? 0) + m.tokens.output;
        }
        if (typeof m.tokens.cached === 'number') {
          totalCacheReadTokens = (totalCacheReadTokens ?? 0) + m.tokens.cached;
        }
        if (typeof m.tokens.total === 'number') {
          grandTotalTokens = (grandTotalTokens ?? 0) + m.tokens.total;
        }
        if (typeof m.tokens.tool === 'number') {
          toolCallCount = (toolCallCount ?? 0) + m.tokens.tool;
        }
      }
    }

    if (messages.length === 0) return null;

    return {
      nativeId,
      projectHash,
      startedAt,
      messages,
      model,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      grandTotalTokens,
      toolCallCount,
    };
  }

  /**
   * 归一化 Gemini message type 到 ymesh MessageRole。
   *   - user → user
   *   - gemini → assistant（Gemini CLI 用 "gemini" 表示模型回复）
   *   - 其他（如 thoughts / tool）→ null（跳过）
   */
  private mapRole(type: string): MessageRole | null {
    switch (type) {
      case 'user':
        return 'user';
      case 'gemini':
        return 'assistant';
      default:
        return null;
    }
  }

  /**
   * 提取一条 message 的可显示文本：
   *   - content 为字符串 → 直接返回（gemini 消息）
   *   - content 为 [{text}] 数组 → 拼接 text（user 消息）
   *   - thoughts 数组排除（思维链，不导入）
   *   - 结果空白 → null
   */
  private extractDisplayText(m: GeminiMessage): string | null {
    const content = m.content;
    if (typeof content === 'string') {
      return content.trim().length > 0 ? content : null;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content as Array<{ text?: string }>) {
        if (block && typeof block.text === 'string' && block.text.length > 0) {
          parts.push(block.text);
        }
      }
      if (parts.length === 0) return null;
      const joined = parts.join('\n');
      return joined.trim().length > 0 ? joined : null;
    }
    return null;
  }

  /** 解析 ISO 时间戳为 epoch 毫秒；非法/缺失返回 undefined */
  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
}
