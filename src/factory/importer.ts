/**
 * Factory Droid 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ~/.factory/sessions 下的 Factory Droid 原生 session JSONL 并入库。
 *
 * 真实结构（本机 ~/.factory/sessions 实测，2026-07）：
 *   - 路径：<rootPath>/<projectDir>/<uuid>.jsonl          —— session 主文件
 *   - sidecar：<projectDir>/<uuid>.settings.json          —— 运行时元数据（model/tokenUsage/providerLock）
 *   - 行类型：
 *       session_start：{ type, id, title, owner, version, cwd, hostId } —— session 元数据首行
 *       message：{ type, id, timestamp, message:{ role, content:[{type,text}] }, parentId? }
 *   - message.content 数组取 type=text 块拼接；其他块排除
 *   - 只取 role=user/assistant 的可显示文本；session_start 不产生消息
 *
 * 核心约束：
 *   - 只读：绝不写入 Factory 私有 session 文件。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = session_start.id；缺失时回退相对 rootPath 的稳定 posix 路径（=文件名 uuid）
 *   - 元数据：sidecar settings.json 提供 model / tokenUsage / providerLock；JSONL session_start 提供 cwd/version。
 *   - 消息：只取 user/assistant 的 text 块；排除 thinking / tool_use / tool_result / system-reminder 内部块。
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

/** macOS / 通用默认 Factory Droid sessions 目录 */
const DEFAULT_FACTORY_SESSIONS_DIR = path.join(os.homedir(), '.factory', 'sessions');

/** 导入器选项 */
export interface FactoryImportOptions {
  /** 直接指定 Factory sessions 根目录，默认 ~/.factory/sessions */
  rootPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface FactoryImportStats {
  /** 本次 scan_run id */
  scanRunId: number;
  /** factory source instance id */
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

/** content 块的松散结构 */
interface ContentBlock {
  type?: string;
  text?: string;
}

/** 一个文件的解析结果 */
interface ParsedSession {
  nativeId: string;
  cwd?: string;
  startedAt?: number;
  messages: SessionMessageInput[];
  model?: string;
  cliVersion?: string;
}

/** sidecar settings.json 的松散结构 */
interface SettingsSidecar {
  model?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    thinkingTokens?: number;
  };
  providerLock?: string;
}

/** 解析 Factory sessions 根目录 */
export function resolveFactorySessionsPath(options: { rootPath?: string } = {}): string {
  return options.rootPath ?? DEFAULT_FACTORY_SESSIONS_DIR;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 路径转 posix 风格 */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Factory Droid 原生导入器。
 *
 * 用法：
 *   const importer = new FactoryDroidImporter(store, { rootPath, deviceId });
 *   const stats = importer.import();
 */
export class FactoryDroidImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: FactoryImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): FactoryImportStats {
    const rootPath = resolveFactorySessionsPath(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`Factory sessions 目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Factory sessions 路径不是目录: ${rootPath}`);
    }

    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'factory',
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
  ): Omit<FactoryImportStats, 'scanRunId' | 'sourceInstanceId'> {
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
        skipped++;
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.nativeId,
        source: 'factory',
        cwd: parsed.cwd,
        projectPath: parsed.cwd,
        startedAt: parsed.startedAt,
        topology: 'root',
        sourceKind: 'A',
        messages: parsed.messages,
        model: parsed.model,
        cliVersion: parsed.cliVersion,
      });
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    return { scanned, inserted, updated, unchanged, skipped };
  }

  /** 递归收集 rootPath 下所有 .jsonl 文件（排除 .settings.json sidecar） */
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
          out.push(abs);
        }
      }
    };
    walk(rootPath);
    out.sort();
    return out;
  }

  /** 解析单个 JSONL 文件 + sidecar settings.json */
  private parseFile(absPath: string, rootPath: string): ParsedSession | null {
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }

    const relPath = toPosix(path.relative(rootPath, absPath));
    let nativeId: string | undefined;
    let cwd: string | undefined;
    let cliVersion: string | undefined;
    let earliest: number | undefined;
    const messages: SessionMessageInput[] = [];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: JsonlLine;
      try {
        obj = JSON.parse(trimmed) as JsonlLine;
      } catch {
        continue;
      }

      // session_start 提供元数据（id / cwd / version）
      if (obj.type === 'session_start') {
        if (nativeId === undefined && typeof obj.id === 'string' && obj.id.length > 0) {
          nativeId = obj.id;
        }
        if (cwd === undefined && typeof obj.cwd === 'string' && obj.cwd.length > 0) {
          cwd = obj.cwd;
        }
        if (cliVersion === undefined && typeof obj.version === 'string' && obj.version.length > 0) {
          cliVersion = obj.version;
        }
        continue;
      }

      // message 行：取 user/assistant 的可显示文本
      const ts = this.parseTimestamp(obj.timestamp);
      if (ts !== undefined && (earliest === undefined || ts < earliest)) {
        earliest = ts;
      }
      const text = this.extractDisplayText(obj);
      if (text !== null) {
        const role = this.extractRole(obj);
        if (role) {
          messages.push({ role, content: text, timestamp: ts });
        }
      }
    }

    if (messages.length === 0) return null;

    // native id 回退：session_start.id → 文件名（去 .jsonl）→ 相对路径
    if (!nativeId) {
      const base = path.basename(absPath, '.jsonl');
      nativeId = base.length > 0 ? base : relPath;
    }

    // sidecar settings.json 提供 model（含 custom: 前缀的真实选用模型）。
    // tokenUsage 暂不透传到 ingest（store 暂无单 session 累计写入入口），仅取 model。
    const settingsPath = absPath.replace(/\.jsonl$/, '.settings.json');
    let model: string | undefined;
    try {
      const sideRaw = fs.readFileSync(settingsPath, 'utf8');
      const side = JSON.parse(sideRaw) as SettingsSidecar;
      model = side.model;
    } catch {
      /* sidecar 缺失 → 仅用 JSONL 元数据 */
    }

    return {
      nativeId,
      cwd,
      startedAt: earliest,
      messages,
      model,
      cliVersion,
    };
  }

  /**
   * 提取一行可显示文本：
   *   - 非 message 行 → null
   *   - message.content 字符串 → 该字符串
   *   - message.content 数组 → 只取 text 块拼接（排除 thinking/tool_use/tool_result）
   *   - 结果空白 → null
   */
  private extractDisplayText(obj: JsonlLine): string | null {
    if (obj.type !== 'message') return null;
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    if (!message) return null;
    const content = message.content;
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

  /** 提取 message 行的 role（仅 user/assistant 入库） */
  private extractRole(obj: JsonlLine): MessageRole | null {
    const message = obj.message as { role?: string } | undefined;
    const role = message?.role;
    if (role === 'user' || role === 'assistant') return role;
    return null;
  }

  /** 解析 ISO 时间戳为 epoch 毫秒；非法/缺失返回 undefined */
  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
}
