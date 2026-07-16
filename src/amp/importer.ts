/**
 * Amp session 导入器（覆盖等级 B / 降级 C）
 *
 * Amp（Sourcegraph）是 SaaS 封闭架构：thread 数据在云端 ampcode.com，本机无
 * 结构化 session 文件。但 `amp` CLI 提供 thread 导出能力（需 auth）：
 *   - `amp threads list --json`        → thread 摘要列表（含 id）
 *   - `amp threads export <id>`        → 完整 thread JSON（v5 schema，含 messages）
 *   - `amp threads markdown <id>`      → 可读 markdown
 *
 * 真实 export JSON 结构（本机实测，amp v0.0.1784031823）：
 *   {
 *     v: 5, id: "T-...", created: <epoch ms>, updatedAt: "...",
 *     env: { initial: { trees: [{ uri: "file:///path", displayName }] } },
 *     meta: { agentMode, executorType, ... },
 *     messages: [{ role: "user"|"assistant", content: [{text,type}], messageId,
 *                  meta: { sentAt: <epoch ms> } }],
 *     agentMode: "medium"
 *   }
 *
 * 两级降级：
 *   1. 主路径（auth 可用）：list + export → coverage B，含完整消息
 *   2. 降级路径（auth 失败 / export 失败）：扫描 ~/.cache/amp/logs/threads/T-*.log
 *      的 NDJSON 事件，仅能发现 thread id / role / seq（消息正文不在日志中），
 *      → coverage C（discovery），消息为空会被跳过，但记录 thread 存在。
 *
 * thread id 发现：list 输出 ∪ 日志文件名（list 受 workspace 可见性过滤，
 *   日志文件名 T-<id>.log 更可靠，二者并集避免遗漏）。
 *
 * 关键限制：GLM-5.2 是内置模型（Low 模式 amp/glm-5.2），不支持 BYOK；
 *   agentMode 仅是 "low"/"medium"/"high" 档位，非真实模型名，故 model 字段留空。
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

/** macOS 默认 amp 配置目录 */
const DEFAULT_AMP_CONFIG_DIR = path.join(os.homedir(), '.config', 'amp');
/** macOS 默认 amp 缓存目录（含 logs/threads） */
const DEFAULT_AMP_CACHE_DIR = path.join(os.homedir(), '.cache', 'amp');
/** thread 日志目录（相对 cache dir） */
const THREAD_LOGS_SUBDIR = path.join('logs', 'threads');
/** thread 日志文件名前缀 */
const THREAD_LOG_PREFIX = 'T-';
const THREAD_LOG_SUFFIX = '.log';

/** 默认 amp 可执行名（PATH 查找） */
const DEFAULT_AMP_BIN = 'amp';

/** 导入器选项 */
export interface AmpImportOptions {
  /** amp 可执行路径，默认 'amp' */
  ampBin?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
  /** 显式指定 thread id 列表（跳过 list / 日志发现） */
  threadIds?: string[];
  /** amp 配置目录，默认 ~/.config/amp */
  configDir?: string;
  /** amp 缓存目录，默认 ~/.cache/amp */
  cacheDir?: string;
  /** 注入式命令执行器（测试用）；默认用 execFileSync 真实执行 amp */
  runner?: AmpCommandRunner;
}

/** 命令执行器接口（便于测试注入） */
export interface AmpCommandRunner {
  /** 执行 amp 子命令，返回 stdout 与退出码；非零退出不抛错 */
  run(args: string[]): { stdout: string; status: number };
}

/** 导入统计 */
export interface AmpImportStats {
  /** 本次 scan_run id */
  scanRunId: number;
  /** amp source instance id */
  sourceInstanceId: string;
  /** 发现的 thread 总数 */
  threadsSeen: number;
  /** 通过 export 成功提取消息的 thread 数（coverage B） */
  inserted: number;
  /** 内容变化产生新 revision 的 thread 数 */
  updated: number;
  /** 内容幂等未变的 thread 数 */
  unchanged: number;
  /** 跳过的 thread 数（无消息 / export 失败 / auth 不可用） */
  skipped: number;
  /** auth 是否可用（list/export 是否成功） */
  authAvailable: boolean;
  /** 覆盖等级（auth 可用=B，否则=C） */
  coverage: Coverage;
}

/** 解析后的 amp thread */
export interface ParsedAmpThread {
  nativeId: string;
  startedAt?: number;
  projectPath?: string;
  displayName?: string;
  agentMode?: string;
  messages: SessionMessageInput[];
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── JSON 松散访问助手（外部 JSON 结构不稳定，统一安全取值） ─────────────────
type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const asArr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

/** 从 file:// URI 还原本地路径；非 file:// 原样返回 */
function fileUriToPath(uri: string): string {
  if (uri.startsWith('file://')) return decodeURIComponent(uri.slice('file://'.length));
  return uri;
}

/** 从 amp message.content 提取可显示文本（拼接所有 text 块；其它类型排除） */
function extractAmpContentText(content: unknown): string | null {
  const arr = asArr(content);
  if (arr) {
    const parts: string[] = [];
    for (const b of arr) {
      const blk = asObj(b);
      if (blk && blk.type === 'text') {
        const t = asStr(blk.text);
        if (t) parts.push(t);
      }
    }
    if (parts.length === 0) return null;
    return parts.join('\n');
  }
  // content 也可能是字符串
  const s = asStr(content);
  return s ?? null;
}

/**
 * 解析 `amp threads export <id>` 的 JSON 对象为结构化 thread。
 * 导出此函数以便单元测试直接覆盖解析逻辑（无需真实 amp）。
 */
export function parseAmpExport(obj: unknown): ParsedAmpThread | null {
  const root = asObj(obj);
  if (!root) return null;
  const nativeId = asStr(root.id);
  if (!nativeId) return null;

  const startedAt = asNum(root.created);
  const treeObj = asObj(asArr(asObj(asObj(root.env)?.initial)?.trees)?.[0]);
  const uriRaw = asStr(treeObj?.uri);
  const projectPath = uriRaw ? fileUriToPath(uriRaw) : undefined;
  const displayName = asStr(treeObj?.displayName);
  const agentMode = asStr(root.agentMode);

  const messages: SessionMessageInput[] = [];
  const msgs = asArr(root.messages);
  if (msgs) {
    for (const m of msgs) {
      const mo = asObj(m);
      if (!mo) continue;
      const roleRaw = asStr(mo.role);
      const role: MessageRole | null =
        roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : null;
      if (!role) continue;
      const text = extractAmpContentText(mo.content);
      if (!text) continue;
      const meta = asObj(mo.meta);
      const ts = meta ? asNum(meta.sentAt) : undefined;
      messages.push({ role, content: text, timestamp: ts });
    }
  }

  return { nativeId, startedAt, projectPath, displayName, agentMode, messages };
}

/**
 * 解析一个 thread 日志（~/.cache/amp/logs/threads/T-<id>.log）的 NDJSON。
 * 日志只含事件元数据（message_added 的 role/seq），不含消息正文。
 * 返回 thread 的 earliest timestamp（若可推断），消息正文为空（需 export 才能取到）。
 */
export function parseAmpThreadLog(raw: string, threadId: string): {
  nativeId: string;
  startedAt?: number;
  messageCount: number;
} {
  let startedAt: number | undefined;
  let messageCount = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Obj;
    try {
      obj = JSON.parse(trimmed) as Obj;
    } catch {
      continue;
    }
    const ts = asStr(obj['@timestamp']);
    if (ts) {
      const ms = Date.parse(ts);
      if (!Number.isNaN(ms) && (startedAt === undefined || ms < startedAt)) {
        startedAt = ms;
      }
    }
    if (asStr(obj.type) === 'message_added' || asStr(obj.message) === 'message_added') {
      messageCount++;
    }
  }
  return { nativeId: threadId, startedAt, messageCount };
}

/** 默认命令执行器：用 execFileSync 真实调用 amp；非零退出不抛错 */
function defaultRunner(ampBin: string): AmpCommandRunner {
  return {
    run(args: string[]): { stdout: string; status: number } {
      try {
        const out = execFileSync(ampBin, args, {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { stdout: out, status: 0 };
      } catch (e) {
        const err = e as { stdout?: string | Buffer; status?: number };
        const stdout = typeof err.stdout === 'string' ? err.stdout : '';
        return { stdout, status: err.status ?? 1 };
      }
    },
  };
}

/** 扫描 thread 日志目录，返回发现的 thread id 列表（从文件名 T-<id>.log 提取） */
function discoverThreadIdsFromLogs(cacheDir: string): string[] {
  const dir = path.join(cacheDir, THREAD_LOGS_SUBDIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.startsWith(THREAD_LOG_PREFIX) && e.name.endsWith(THREAD_LOG_SUFFIX)) {
      const id = e.name.slice(THREAD_LOG_PREFIX.length, -THREAD_LOG_SUFFIX.length);
      if (id.length > 0) ids.push(id);
    }
  }
  return ids;
}

/**
 * Amp thread 导入器。
 *
 * 用法：
 *   const importer = new AmpImporter(store);
 *   const stats = importer.import();
 *
 * 测试用法（注入假执行器）：
 *   const importer = new AmpImporter(store, { runner: fakeRunner, threadIds: ['T-x'] });
 */
export class AmpImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: AmpImportOptions = {},
  ) {}

  import(): AmpImportStats {
    const deviceId = this.options.deviceId ?? os.hostname();
    const ampBin = this.options.ampBin ?? DEFAULT_AMP_BIN;
    const configDir = this.options.configDir ?? DEFAULT_AMP_CONFIG_DIR;
    const cacheDir = this.options.cacheDir ?? DEFAULT_AMP_CACHE_DIR;
    const runner = this.options.runner ?? defaultRunner(ampBin);

    // 1. 发现 thread id：显式 > list ∪ 日志文件名
    let threadIds = this.options.threadIds ?? [];
    let authAvailable = true;
    if (threadIds.length === 0) {
      const listed = this.listThreads(runner);
      if (listed === null) {
        // list 失败（auth 不可用）→ 降级到日志发现
        authAvailable = false;
        threadIds = discoverThreadIdsFromLogs(cacheDir);
      } else {
        const logIds = discoverThreadIdsFromLogs(cacheDir);
        threadIds = [...new Set([...listed, ...logIds])];
      }
    }

    const coverage: Coverage = authAvailable ? 'B' : 'C';
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'amp',
      rootPath: configDir,
      coverage,
    });
    const runId = this.store.startScanRun({ sourceInstanceId: instance.id, deviceId });

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    try {
      for (const id of threadIds) {
        const parsed = this.exportAndParse(runner, id);
        if (!parsed || parsed.messages.length === 0) {
          skipped++;
          continue;
        }
        const result = this.store.ingestSession({
          deviceId,
          sourceInstanceId: instance.id,
          nativeSessionId: parsed.nativeId,
          source: 'amp',
          cwd: parsed.projectPath,
          projectPath: parsed.projectPath,
          startedAt: parsed.startedAt,
          topology: 'root',
          sourceKind: coverage,
          messages: parsed.messages,
          entrySource: 'cloud',
          threadSource: parsed.agentMode,
        });
        if (result.created) inserted++;
        else if (result.newRevision) updated++;
        else unchanged++;
      }

      this.store.finishScanRun(runId, {
        status: 'completed',
        sessionsSeen: threadIds.length,
        sessionsNew: inserted,
        sessionsUpdated: updated,
      });

      return {
        scanRunId: runId,
        sourceInstanceId: instance.id,
        threadsSeen: threadIds.length,
        inserted,
        updated,
        unchanged,
        skipped,
        authAvailable,
        coverage,
      };
    } catch (err) {
      try {
        this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
      } catch {
        /* scan_run 写入失败不应掩盖原始错误 */
      }
      throw err;
    }
  }

  /** 执行 `amp threads list --json`；返回 id 列表；auth/执行失败返回 null */
  private listThreads(runner: AmpCommandRunner): string[] | null {
    const { stdout, status } = runner.run(['threads', 'list', '--json']);
    if (status !== 0) return null;
    try {
      const arr = JSON.parse(stdout) as unknown;
      const list = asArr(arr);
      if (!list) return [];
      const ids: string[] = [];
      for (const t of list) {
        const id = asStr(asObj(t)?.id);
        if (id) ids.push(id);
      }
      return ids;
    } catch {
      return null;
    }
  }

  /** 执行 `amp threads export <id>` 并解析；失败返回 null */
  private exportAndParse(runner: AmpCommandRunner, threadId: string): ParsedAmpThread | null {
    const { stdout, status } = runner.run(['threads', 'export', threadId]);
    if (status !== 0) return null;
    try {
      return parseAmpExport(JSON.parse(stdout));
    } catch {
      return null;
    }
  }
}

/**
 * Amp auth 流程 helper（auth 不可用时由调用方使用）。
 *
 * auth 失败时（list 返回非零 / 导出失败），调用方应：
 *   1. 提示用户运行 `amp login` 完成 SaaS 登录
 *   2. 登录后重试 import（届时 coverage 从 C 升级到 B）
 *   3. 在 auth 完成前，仅能以 coverage C 记录 thread 存在（无消息正文）
 */
export const AMP_AUTH_HELPER = {
  loginCommand: 'amp login',
  logoutCommand: 'amp logout',
  hint:
    'Amp thread 数据在云端 ampcode.com。运行 `amp login` 完成 SaaS 登录后，' +
    '`amp threads export <id>` 才能取回完整消息。auth 不可用时仅能以 coverage C ' +
    '（discovery）记录 thread 存在（从 ~/.cache/amp/logs/threads/ 文件名发现 id）。',
};
