/**
 * Qwen Code 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ~/.qwen/projects 下的 Qwen Code 原生 session（JSONL 格式，结构与
 * Claude Code / Gemini API 兼容），解析为 ymesh StoredSession 入库。
 *
 * 真实结构（本机 ~/.qwen/projects 实测，2026-07，qwen v0.19.8）：
 *   - 路径：<rootPath>/<projectDir>/chats/<uuid>.jsonl
 *   - 同级还有 meta.json / memory/MEMORY.md / extract-cursor.json（非 session，排除）
 *   - 每行一个 JSON，字段：uuid, parentUuid, sessionId, timestamp, type, cwd, version,
 *     gitBranch, message；assistant 行额外有 model / usageMetadata / contextWindowSize
 *   - type：user / assistant / system（system 含 subtype: attribution_snapshot / ui_telemetry）
 *   - message.role：user → "user"；assistant → "model"（Gemini API 风格）
 *   - message.parts：[{text}]；assistant 的 part 可能带 thought:true（思维链，排除）
 *   - 顶层 version = CLI 版本；assistant 行 model = 模型名
 *
 * 核心约束：
 *   - 只读：绝不写入 Qwen 私有 session 文件（架构 §2 关键取舍）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = sessionId 字段；缺失时回退相对 rootPath 的稳定 posix 路径
 *   - 拓扑：Qwen Code 当前无 subagent 概念，所有 session 均为 root。
 *   - 消息：只取 user/assistant 的可显示文本块（text）；排除 thought:true（思维链）、
 *     system 行（ui_telemetry / attribution_snapshot 等内部事件）。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定；脏行跳过，无有效消息的文件跳过。
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

/** macOS / 通用默认 Qwen Code projects 目录 */
const DEFAULT_QWEN_PROJECTS_DIR = path.join(os.homedir(), '.qwen', 'projects');

/** chats 目录段名（session JSONL 仅在该段下） */
const CHATS_SEGMENT = 'chats';

/** 导入器选项 */
export interface QwenImportOptions {
  /** 直接指定 Qwen projects 根目录，默认 ~/.qwen/projects */
  rootPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface QwenImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** qwen source instance id */
  sourceInstanceId: string;
  /** 扫描到的 JSONL 文件总数 */
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

/** 单条 JSONL 行的松散结构 */
type JsonlLine = Record<string, unknown>;

/** message.parts 数组中一个 part 的松散结构 */
interface MessagePart {
  text?: string;
  thought?: boolean;
}

/** assistant 行的 usageMetadata（Gemini API 风格，松散结构） */
interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

/** 一个文件的解析结果 */
interface ParsedSession {
  /** native session id（sessionId 字段，缺失回退相对路径） */
  nativeId: string;
  cwd?: string;
  startedAt?: number;
  messages: SessionMessageInput[];
  model?: string;
  cliVersion?: string;
  /** 累加的 token 统计（来自所有 assistant 行的 usageMetadata） */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  grandTotalTokens?: number;
}

/** 解析 Qwen projects 根目录：rootPath 选项优先，否则回退默认路径 */
export function resolveQwenProjectsPath(options: { rootPath?: string } = {}): string {
  return options.rootPath ?? DEFAULT_QWEN_PROJECTS_DIR;
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
 * Qwen Code 原生导入器。
 *
 * 用法：
 *   const importer = new QwenCodeImporter(store, { rootPath, deviceId });
 *   const stats = importer.import();
 */
export class QwenCodeImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: QwenImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): QwenImportStats {
    const rootPath = resolveQwenProjectsPath(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. rootPath 必须可读目录
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`Qwen projects 目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Qwen projects 路径不是目录: ${rootPath}`);
    }

    // 2. 注册 coverage=A 的 qwen source instance（rootPath=扫描根）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'qwen',
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
   * 扫描整棵树：收集 chats 目录下的所有 .jsonl 文件，逐文件解析入库。
   * Qwen Code 无 subagent 概念，所有 session 均为 root topology。
   */
  private scanTree(
    rootPath: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<QwenImportStats, 'scanRunId' | 'sourceInstanceId'> {
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
        source: 'qwen',
        cwd: parsed.cwd,
        projectPath: parsed.cwd,
        startedAt: parsed.startedAt,
        topology: 'root',
        sourceKind: 'A',
        messages: parsed.messages,
        model: parsed.model,
        cliVersion: parsed.cliVersion,
        totalInputTokens: parsed.totalInputTokens,
        totalOutputTokens: parsed.totalOutputTokens,
        totalCacheReadTokens: parsed.totalCacheReadTokens,
        grandTotalTokens: parsed.grandTotalTokens,
      });
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    return { scanned, inserted, updated, unchanged, skipped };
  }

  /**
   * 递归收集 rootPath 下所有应扫描的 session .jsonl 文件。
   * 仅收集位于 chats/ 段下的 .jsonl 文件（排除 meta.json / memory/ / extract-cursor.json）。
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
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          // 仅收集 chats/ 目录下的 jsonl（session 文件）
          const rel = toPosix(path.relative(rootPath, abs));
          const segs = rel.split('/');
          if (segs.includes(CHATS_SEGMENT)) {
            out.push(abs);
          }
        }
      }
    };
    walk(rootPath);
    // 稳定字典序，消除 readdir 顺序不确定性
    out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return out;
  }

  /**
   * 解析单个 JSONL 文件，返回 native id / cwd / 最早时间 / 消息。
   * 单行 JSON 损坏跳过该行；无有效消息返回 null（跳过文件）。
   */
  private parseFile(absPath: string, rootPath: string): ParsedSession | null {
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null; // 文件不可读 → 跳过
    }

    const relPath = toPosix(path.relative(rootPath, absPath));
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let earliest: number | undefined;
    let model: string | undefined;
    let cliVersion: string | undefined;
    const messages: SessionMessageInput[] = [];

    // token 累加
    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;
    let totalCacheReadTokens: number | undefined;
    let grandTotalTokens: number | undefined;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: JsonlLine;
      try {
        obj = JSON.parse(trimmed) as JsonlLine;
      } catch {
        continue; // 脏行跳过
      }

      // 采集稳定字段（每行重复，取首个非空）
      if (sessionId === undefined && typeof obj.sessionId === 'string') {
        sessionId = obj.sessionId;
      }
      if (cwd === undefined && typeof obj.cwd === 'string') {
        cwd = obj.cwd;
      }
      if (cliVersion === undefined && typeof obj.version === 'string' && obj.version.length > 0) {
        cliVersion = obj.version;
      }

      const ts = this.parseTimestamp(obj.timestamp);
      if (ts !== undefined && (earliest === undefined || ts < earliest)) {
        earliest = ts;
      }

      // 累加 assistant 行的 token 统计
      if (obj.type === 'assistant') {
        if (model === undefined && typeof obj.model === 'string' && obj.model.length > 0) {
          model = obj.model;
        }
        const usage = obj.usageMetadata as UsageMetadata | undefined;
        if (usage) {
          if (typeof usage.promptTokenCount === 'number') {
            totalInputTokens = (totalInputTokens ?? 0) + usage.promptTokenCount;
          }
          if (typeof usage.candidatesTokenCount === 'number') {
            totalOutputTokens = (totalOutputTokens ?? 0) + usage.candidatesTokenCount;
          }
          if (typeof usage.cachedContentTokenCount === 'number') {
            totalCacheReadTokens = (totalCacheReadTokens ?? 0) + usage.cachedContentTokenCount;
          }
          if (typeof usage.totalTokenCount === 'number') {
            grandTotalTokens = (grandTotalTokens ?? 0) + usage.totalTokenCount;
          }
        }
      }

      // 仅取 user/assistant 的可显示文本
      const text = this.extractDisplayText(obj);
      if (text !== null) {
        const role = (obj.type === 'assistant' ? 'assistant' : 'user') as MessageRole;
        messages.push({ role, content: text, timestamp: ts });
      }
    }

    if (messages.length === 0) return null; // 无有效消息 → 跳过文件

    const nativeId = sessionId && sessionId.length > 0 ? sessionId : relPath;

    return {
      nativeId,
      cwd,
      startedAt: earliest,
      messages,
      model,
      cliVersion,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      grandTotalTokens,
    };
  }

  /**
   * 提取一行的可显示文本：
   *   - 非 user/assistant 行 → null（system / ui_telemetry / attribution_snapshot 等内部事件）
   *   - message.parts 数组 → 只取非 thought 的 text 块拼接（思维链排除）
   *   - 结果空白 → null
   *
   * Qwen message 结构（Gemini API 风格）：
   *   { role: "user" | "model", parts: [{ text }] }
   * assistant 行的 parts 可能含 { text, thought: true }（思维链），需排除。
   */
  private extractDisplayText(obj: JsonlLine): string | null {
    if (obj.type !== 'user' && obj.type !== 'assistant') return null;

    const message = obj.message as { role?: string; parts?: unknown } | undefined;
    if (!message) return null;
    const parts = message.parts;
    if (!Array.isArray(parts)) return null;

    const out: string[] = [];
    for (const part of parts as MessagePart[]) {
      // 排除思维链（thought:true）
      if (part && part.thought === true) continue;
      if (part && typeof part.text === 'string' && part.text.length > 0) {
        out.push(part.text);
      }
    }
    if (out.length === 0) return null;
    const joined = out.join('\n');
    return joined.trim().length > 0 ? joined : null;
  }

  /** 解析 ISO 时间戳为 epoch 毫秒；非法/缺失返回 undefined */
  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
}
