/**
 * Kimi 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ~/.kimi/sessions/ 下的 Kimi 原生 session，解析 context.jsonl 消息
 * 并入库（architecture.md §2.2 / §3.4）。
 *
 * 真实结构（本机 ~/.kimi 实测，2026-07）：
 *   - 目录结构：<rootPath>/sessions/<workDirHash>/<sessionUuid>/
 *     · context.jsonl  —— 完整消息上下文（role + content）
 *     · wire.jsonl     —— Wire 协议事件流（TurnBegin/ContentPart/ToolCall/ToolResult）
 *     · state.json     —— 可选状态文件
 *   - context.jsonl 格式：每行一个 JSON 对象
 *       { "role": "_system_prompt"|"user"|"assistant"|"tool", "content": "..." }
 *   - workDirHash 是工作目录的哈希，可通过 ~/.kimi/user-history/<hash>.jsonl 反查路径
 *   - sessionUuid 是 session 的 native id
 *
 * 核心约束：
 *   - 只读：绝不写入 Kimi 私有 session 文件（架构 §2 关键取舍）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = session 目录名（sessionUuid）；缺失时回退相对路径
 *   - 拓扑（§4）：Kimi 无显式 subagent 谱系字段（context_sub_*.jsonl 是子上下文
 *     但不写谱系关系），故全部为 root。子上下文文件（context_sub_*.jsonl）不扫描。
 *   - 消息：只取 context.jsonl 中 user/assistant 的文本（排除 _system_prompt / tool）。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定；脏行跳过，无有效消息的 session 跳过。
 *   - 采集等级：A 级（JSONL，与 claude/codex 同级）。
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

/** macOS / 通用默认 Kimi 目录 */
const DEFAULT_KIMI_DIR = path.join(os.homedir(), '.kimi');
/** sessions 子目录名 */
const SESSIONS_SEGMENT = 'sessions';
/** context.jsonl 文件名 */
const CONTEXT_FILENAME = 'context.jsonl';

/** 导入器选项 */
export interface KimiImportOptions {
  /** 直接指定 Kimi 根目录，默认 ~/.kimi */
  rootPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface KimiImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** kimi source instance id */
  sourceInstanceId: string;
  /** 扫描到的 session 总数 */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 session 数（无有效消息 / 脏文件 / 无 context.jsonl） */
  skipped: number;
}

/** context.jsonl 单行的松散结构 */
interface ContextLine {
  role?: string;
  content?: unknown;
}

/** 一个 session 目录的解析结果 */
interface ParsedSession {
  /** native session id（目录名） */
  nativeId: string;
  /** 工作目录（从 user-history 反查，或 undefined） */
  cwd?: string;
  /** session 最早时间戳（从 wire.jsonl 推断，或 undefined） */
  startedAt?: number;
  messages: SessionMessageInput[];
}

/** 解析 Kimi 根目录：rootPath 选项优先，否则回退默认路径 */
export function resolveKimiPath(options: { rootPath?: string } = {}): string {
  return options.rootPath ?? DEFAULT_KIMI_DIR;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Kimi 原生导入器。
 *
 * 用法：
 *   const importer = new KimiImporter(store, { rootPath, deviceId });
 *   const stats = importer.import();
 */
export class KimiImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: KimiImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): KimiImportStats {
    const rootPath = resolveKimiPath(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. rootPath 必须可读目录
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`Kimi 目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Kimi 路径不是目录: ${rootPath}`);
    }

    // 2. 注册 coverage=A 的 kimi source instance（rootPath=扫描根）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'kimi',
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

  /** 把 scan_run 标记为 failed 并写 error */
  private finishRunFailed(runId: number, err: unknown): void {
    try {
      this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
    } catch {
      /* 不掩盖原始错误 */
    }
  }

  /**
   * 扫描 sessions/<workDirHash>/<sessionUuid>/ 目录树：
   *   1. 预加载 workDirHash → cwd 映射（从 user-history/<hash>.jsonl 反查）
   *   2. 遍历每个含 context.jsonl 的 session 目录，解析并入库
   */
  private scanTree(
    rootPath: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<KimiImportStats, 'scanRunId' | 'sourceInstanceId'> {
    // 预加载 workDirHash → cwd 映射
    const cwdByHash = this.loadWorkDirMap(rootPath);

    const sessionsDir = path.join(rootPath, SESSIONS_SEGMENT);
    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    let workDirHashes: fs.Dirent[];
    try {
      workDirHashes = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      return { scanned: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
    }

    for (const hashEntry of workDirHashes) {
      if (!hashEntry.isDirectory()) continue;
      const workDirHash = hashEntry.name;
      const cwd = cwdByHash.get(workDirHash);
      const hashDir = path.join(sessionsDir, workDirHash);

      let sessionUuids: fs.Dirent[];
      try {
        sessionUuids = fs.readdirSync(hashDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const sessionEntry of sessionUuids) {
        if (!sessionEntry.isDirectory()) continue;
        const contextFile = path.join(hashDir, sessionEntry.name, CONTEXT_FILENAME);
        if (!fs.existsSync(contextFile)) {
          skipped++;
          continue;
        }
        scanned++;
        const parsed = this.parseSession(contextFile, sessionEntry.name, cwd, rootPath);
        if (!parsed) {
          skipped++;
          continue;
        }
        const result = this.store.ingestSession({
          deviceId,
          sourceInstanceId,
          nativeSessionId: parsed.nativeId,
          source: 'kimi',
          cwd: parsed.cwd,
          projectPath: parsed.cwd,
          startedAt: parsed.startedAt,
          topology: 'root',
          sourceKind: 'A',
          messages: parsed.messages,
        });
        if (result.created) inserted++;
        else if (result.newRevision) updated++;
        else unchanged++;
      }
    }

    return { scanned, inserted, updated, unchanged, skipped };
  }

  /**
   * 加载 user-history/<hash>.jsonl，建立 workDirHash → cwd 映射。
   * user-history 文件每行一个 JSON，含 work_dir 字段。
   */
  private loadWorkDirMap(rootPath: string): Map<string, string> {
    const map = new Map<string, string>();
    const historyDir = path.join(rootPath, 'user-history');
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(historyDir, { withFileTypes: true });
    } catch {
      return map;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const hash = f.name.replace(/\.jsonl$/, '');
      try {
        const raw = fs.readFileSync(path.join(historyDir, f.name), 'utf8');
        // 读最后一行（最新记录），提取 work_dir
        const lines = raw.trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const obj = JSON.parse(lines[i]!) as { work_dir?: string };
            if (typeof obj.work_dir === 'string' && obj.work_dir.length > 0) {
              map.set(hash, obj.work_dir);
              break;
            }
          } catch {
            // 脏行跳过
          }
        }
      } catch {
        // 文件不可读跳过
      }
    }
    return map;
  }

  /**
   * 解析单个 session 的 context.jsonl，返回 native id / cwd / 消息。
   * 同时尝试从同目录的 wire.jsonl 推断 startedAt。
   * 无有效消息返回 null（跳过）。
   */
  private parseSession(
    contextFile: string,
    sessionUuid: string,
    cwd: string | undefined,
    _rootPath: string,
  ): ParsedSession | null {
    let raw: string;
    try {
      raw = fs.readFileSync(contextFile, 'utf8');
    } catch {
      return null;
    }

    const messages: SessionMessageInput[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: ContextLine;
      try {
        obj = JSON.parse(trimmed) as ContextLine;
      } catch {
        continue; // 脏行跳过
      }

      // 只取 user/assistant 的可显示文本（排除 _system_prompt / tool）
      if (obj.role !== 'user' && obj.role !== 'assistant') continue;
      const text = this.extractText(obj.content);
      if (text !== null) {
        const role = (obj.role === 'assistant' ? 'assistant' : 'user') as MessageRole;
        messages.push({ role, content: text });
      }
    }

    if (messages.length === 0) return null;

    // 尝试从 wire.jsonl 推断 startedAt
    const startedAt = this.extractStartedAt(path.dirname(contextFile));

    return {
      nativeId: sessionUuid,
      cwd,
      startedAt,
      messages,
    };
  }

  /** 从同目录 wire.jsonl 提取最早时间戳（epoch 毫秒） */
  private extractStartedAt(sessionDir: string): number | undefined {
    const wireFile = path.join(sessionDir, 'wire.jsonl');
    let raw: string;
    try {
      raw = fs.readFileSync(wireFile, 'utf8');
    } catch {
      return undefined;
    }
    let earliest: number | undefined;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { timestamp?: number };
        if (typeof obj.timestamp === 'number') {
          // Kimi wire.jsonl timestamp 是 epoch 秒（浮点）
          const ms = obj.timestamp > 1e12 ? obj.timestamp : obj.timestamp * 1000;
          if (earliest === undefined || ms < earliest) {
            earliest = ms;
          }
        }
      } catch {
        // 脏行跳过
      }
    }
    return earliest;
  }

  /**
   * 提取 content 的可显示文本：
   *   - content 字符串 → 该字符串
   *   - content 数组 → 取 text 块拼接
   *   - 结果空白 → null
   */
  private extractText(content: unknown): string | null {
    if (typeof content === 'string') {
      return content.trim().length > 0 ? content : null;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content as Array<{ type?: string; text?: string }>) {
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
}
