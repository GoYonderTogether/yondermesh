/**
 * WorkBuddy / CodeBuddy 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ~/.codebuddy 下的 CodeBuddy 原生 session 并入库。
 *
 * 实测环境（2026-07）：
 *   - cbc CLI 未安装（~/.codebuddy/ 存在但无 cbc 二进制）
 *   - ~/.codebuddy/local_storage/entry_*.info 是 base64+gzip 的产品配置（productName=WorkBuddy），
 *     非 session 数据
 *   - ~/.codebuddy/models.json 为空（0 字节）
 *   - 暂无 session 存储目录（cbc 未运行过 session）
 *
 * importer 设计：
 *   - 递归扫描 ~/.codebuddy 下的 .jsonl session 文件（cbc 安装并运行后会生成）
 *   - 兼容类 Claude Code 的 JSONL 行格式（type=message, message.role, message.content[]）
 *     与扁平格式（role/content 顶层），按行自适应
 *   - native id：优先取行内 session_id / id 字段，回退文件名
 *   - cbc 未安装 / 无 session 时返回 scanned=0，不报错（前向兼容）
 *
 * 核心约束：
 *   - 只读：绝不写入 CodeBuddy 私有文件。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
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

/** macOS / 通用默认 CodeBuddy 配置目录 */
const DEFAULT_CODEBUDDY_HOME = path.join(os.homedir(), '.codebuddy');
/** 默认 session 扫描根（~/.codebuddy；cbc 安装后 session 文件可能出现在子目录） */
const DEFAULT_CODEBUDDY_SESSIONS_DIR = DEFAULT_CODEBUDDY_HOME;

/** 导入器选项 */
export interface CodeBuddyImportOptions {
  /** 直接指定扫描根目录，默认 ~/.codebuddy */
  rootPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface CodeBuddyImportStats {
  scanRunId: number;
  sourceInstanceId: string;
  /** 扫描到的 JSONL 文件总数 */
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
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

/** 解析 CodeBuddy 扫描根目录 */
export function resolveCodeBuddyPath(options: { rootPath?: string } = {}): string {
  return options.rootPath ?? DEFAULT_CODEBUDDY_SESSIONS_DIR;
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
 * WorkBuddy / CodeBuddy 原生导入器。
 *
 * 用法：
 *   const importer = new CodeBuddyImporter(store, { rootPath, deviceId });
 *   const stats = importer.import();
 */
export class CodeBuddyImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: CodeBuddyImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): CodeBuddyImportStats {
    const rootPath = resolveCodeBuddyPath(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`CodeBuddy 目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`CodeBuddy 路径不是目录: ${rootPath}`);
    }

    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'codebuddy',
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
  ): Omit<CodeBuddyImportStats, 'scanRunId' | 'sourceInstanceId'> {
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
        source: 'codebuddy',
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

  /**
   * 递归收集 rootPath 下所有 .jsonl 文件。
   * 排除：local_storage/（产品配置，非 session）、code-ratio/（git watcher 状态）。
   */
  private collectSessionFiles(rootPath: string): string[] {
    const out: string[] = [];
    const EXCLUDE_DIRS = new Set(['local_storage', 'code-ratio', 'plugins', 'marketplaces']);
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
          if (EXCLUDE_DIRS.has(e.name)) continue;
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

  /**
   * 解析单个 JSONL 文件，自适应两种格式：
   *   A) 类 Claude Code：{ type:"message", message:{ role, content:[{type,text}] } }
   *   B) 扁平格式：{ role:"user", content:"text" }
   */
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
    let model: string | undefined;
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

      // 采集稳定元数据
      if (nativeId === undefined) {
        const id = obj.session_id ?? obj.sessionId ?? obj.id;
        if (typeof id === 'string' && id.length > 0 && obj.type !== 'message') {
          nativeId = id;
        }
      }
      if (cwd === undefined && typeof obj.cwd === 'string') cwd = obj.cwd;
      if (cliVersion === undefined && typeof obj.version === 'string') cliVersion = obj.version;
      if (model === undefined && typeof obj.model === 'string') model = obj.model;

      const ts = this.parseTimestamp(obj.timestamp ?? obj.created_at);
      if (ts !== undefined && (earliest === undefined || ts < earliest)) {
        earliest = ts;
      }

      const extracted = this.extractMessage(obj);
      if (extracted) {
        messages.push({ role: extracted.role, content: extracted.content, timestamp: ts });
      }
    }

    if (messages.length === 0) return null;

    if (!nativeId) {
      const base = path.basename(absPath, '.jsonl');
      nativeId = base.length > 0 ? base : relPath;
    }

    return { nativeId, cwd, startedAt: earliest, messages, model, cliVersion };
  }

  /**
   * 自适应提取消息：返回 { role, content } 或 null。
   *   A) 嵌套格式：obj.message.role + obj.message.content（数组取 text 块）
   *   B) 扁平格式：obj.role + obj.content（字符串）
   */
  private extractMessage(obj: JsonlLine): { role: MessageRole; content: string } | null {
    // A) 嵌套格式
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    if (message && typeof message.role === 'string') {
      const role = this.normalizeRole(message.role);
      if (!role) return null;
      const content = message.content;
      if (typeof content === 'string' && content.trim().length > 0) {
        return { role, content };
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
        return joined.trim().length > 0 ? { role, content: joined } : null;
      }
      return null;
    }

    // B) 扁平格式
    if (typeof obj.role === 'string' && typeof obj.content === 'string') {
      const role = this.normalizeRole(obj.role);
      if (!role) return null;
      return obj.content.trim().length > 0 ? { role, content: obj.content } : null;
    }

    return null;
  }

  /** 归一化 role：仅 user/assistant 入库 */
  private normalizeRole(role: string): MessageRole | null {
    if (role === 'user' || role === 'assistant') return role;
    return null;
  }

  /** 解析 ISO 时间戳为 epoch 毫秒 */
  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
}
