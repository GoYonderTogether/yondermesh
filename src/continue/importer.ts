/**
 * Continue CLI 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 Continue CLI（@continuedev/cli，二进制名 `cn`）的 session 存储，
 * 解析为 ymesh StoredSession 入库。
 *
 * 实测目录结构（本机 v1.5.47，2026-07）：
 *   ~/.continue/
 *   ├── config.yaml           — 主配置（MCP servers / rules / models 等）
 *   ├── permissions.yaml      — 工具权限
 *   ├── sessions/
 *   │   ├── sessions.json     — 全部 session 索引（数组形态：[{id, title, ...}, ...]）
 *   │   └── <uuid>.json       — 单个 session 完整内容（messages 等）
 *   ├── skills/               — 全局 skills（与 ~/.agents/skills/ 共享）
 *   ├── index/                — 向量索引（不解析）
 *   └── logs/cn.log           — CLI 日志（不解析）
 *
 * sessions.json 实测形态（`cn ls --json` 输出与文件一致）：
 *   [
 *     {
 *       "id": "<uuid>",
 *       "title": "...",
 *       "createdAt": <epoch ms>,
 *       "updatedAt": <epoch ms>,
 *       "workspacePath"?: "/path/to/cwd",
 *       "model"?: "glm-4.6",
 *       "provider"?: "zhipu"
 *     },
 *     ...
 *   ]
 *
 * <uuid>.json 单 session 文件形态（保守推断，多版本兼容）：
 *   {
 *     "id": "<uuid>",
 *     "title": "...",
 *     "createdAt"?: <ms>,
 *     "updatedAt"?: <ms>,
 *     "workspacePath"?: "/path",
 *     "model"?: "...",
 *     "provider"?: "...",
 *     "messages": [
 *       { "role": "user"|"assistant", "content": "..."|"text"|[{type:"text",text:"..."}], "timestamp"?: <ms> },
 *       ...
 *     ]
 *   }
 *
 * 核心约束（沿用架构 §2 / §4）：
 *   - 只读：绝不写入 Continue 私有 sessions 目录或 config.yaml（inject 模块负责注入）。
 *   - 身份三元组：device_id + source_instance_id + native_session_id
 *       native_session_id = session.id（UUID，全局唯一稳定）
 *   - 拓扑：Continue 当前无 subagent 概念（虽有 --beta-subagent-tool 但不持久化为父子
 *     session），所有 session 一律 topology=root。
 *   - 消息：只取 user/assistant 可显示 text；排除 thinking / tool_use / tool_result。
 *   - 幂等：依赖 SessionStore.content_hash 判定；内容变化产生新 revision。
 *   - 流式：按 session 逐文件读取，单次只持有一个 session 的消息。
 *
 * source 别名：continue / cn / continue_cli（source-aliases.ts 注册）。
 *
 * GLM-5.2 ✅：Continue 通过 config.yaml 的 models 段或 --model 参数支持任意
 * OpenAI 兼容端点，本机实测 GLM-4.6 通过 http://open.bigmodel.cn/api/paas/v4 接入。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

/** Continue 配置根目录 */
export const CONTINUE_CONFIG_DIR = path.join(os.homedir(), '.continue');

/** sessions 目录 */
export const CONTINUE_SESSIONS_DIR = path.join(CONTINUE_CONFIG_DIR, 'sessions');

/** sessions.json 索引文件路径 */
export const CONTINUE_SESSIONS_INDEX = path.join(CONTINUE_SESSIONS_DIR, 'sessions.json');

/** cn 二进制名（环境变量 CONTINUE_BIN 可覆盖） */
function resolveCnBin(): string {
  return process.env.CONTINUE_BIN ?? 'cn';
}

/** 导入器选项 */
export interface ContinueImportOptions {
  /** 直接指定 sessions 目录，优先级最高 */
  sessionsDir?: string;
  /** 直接指定 sessions.json 索引路径 */
  sessionsIndex?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
  /** 是否用 `cn ls --json` 作为 session 发现的补充来源，默认 true */
  useCliFallback?: boolean;
}

/** 导入统计 */
export interface ContinueImportStats {
  /** 本次 scan_run id（写入 ymesh scan_runs） */
  scanRunId: number;
  /** continue source instance id */
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
  /** 通过 `cn ls --json` 补充发现的 session 数（索引文件未列出） */
  cliDiscovered: number;
  /** CLI 不可用 / 超时 */
  cliUnavailable: boolean;
}

/** sessions.json 索引项（保守松散结构） */
interface SessionIndexEntry {
  id?: string;
  sessionId?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  workspacePath?: string;
  cwd?: string;
  model?: string;
  provider?: string;
}

/** 单 session 文件松散结构 */
interface SessionFile {
  id?: string;
  sessionId?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  workspacePath?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  cliVersion?: string;
  messages?: unknown[];
}

/** 解析后的 session */
interface ParsedContinueSession {
  nativeId: string;
  title?: string;
  cwd?: string;
  model?: string;
  cliVersion?: string;
  startedAt?: number;
  messages: SessionMessageInput[];
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
 * 从消息对象中提取可显示文本（多形态兼容）。
 *
 * Continue 的 message.content 形态多样（实测 + 保守）：
 *   - string → 直接用
 *   - { text: "..." } → 取 text
 *   - { content: "..." } → 取 content
 *   - [{ type: "text", text: "..." }, ...] → 拼接所有 text part
 *   - 其他 → 跳过
 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || typeof content !== 'object') return '';
  const obj = content as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.parts)) {
    return obj.parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          const po = p as Record<string, unknown>;
          if (typeof po.text === 'string') return po.text;
          if (typeof po.content === 'string') return po.content;
        }
        return '';
      })
      .join('');
  }
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content === 'string') return p.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** 归一化 role 到 ymesh MessageRole；未知返回 null（跳过） */
function normalizeRole(role: unknown): MessageRole | null {
  if (typeof role !== 'string') return null;
  const r = role.toLowerCase();
  switch (r) {
    case 'user':
    case 'human':
      return 'user';
    case 'assistant':
    case 'ai':
    case 'bot':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
    case 'function':
      return 'tool';
    default:
      return null;
  }
}

/**
 * 调用 `cn ls --json` 获取 session 索引。
 * CLI 不可用 / 超时 → 返回空数组并标记 unavailable。
 */
function fetchSessionsFromCli(): {
  entries: SessionIndexEntry[];
  unavailable: boolean;
} {
  try {
    const out = execSync(`${resolveCnBin()} ls --json`, {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = safeJsonParse<{ sessions?: SessionIndexEntry[] } | SessionIndexEntry[]>(out);
    if (!parsed) return { entries: [], unavailable: false };
    if (Array.isArray(parsed)) return { entries: parsed, unavailable: false };
    if (Array.isArray(parsed.sessions)) return { entries: parsed.sessions, unavailable: false };
    return { entries: [], unavailable: false };
  } catch {
    return { entries: [], unavailable: true };
  }
}

/** 读取 sessions.json 索引文件，失败返回空数组 */
function readSessionsIndex(indexFile: string): SessionIndexEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(indexFile, 'utf8');
  } catch {
    return [];
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const parsed = safeJsonParse<SessionIndexEntry[] | { sessions?: SessionIndexEntry[] }>(trimmed);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.sessions)) return parsed.sessions;
  return [];
}

/**
 * 解析单个 session 文件。
 * 文件路径：<sessionsDir>/<id>.json
 */
function parseSessionFile(filePath: string): ParsedContinueSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const data = safeJsonParse<SessionFile>(raw);
  if (!data) return null;

  const nativeId = data.id ?? data.sessionId ?? path.basename(filePath, '.json');
  const messages: SessionMessageInput[] = [];

  if (Array.isArray(data.messages)) {
    for (const m of data.messages) {
      if (!m || typeof m !== 'object') continue;
      const mo = m as Record<string, unknown>;
      const role = normalizeRole(mo.role);
      if (!role) continue; // 未知 role → 跳过该条
      // user / assistant / system / tool 都允许，但 tool 消息通常为 tool_result，
      // 采集策略：只保留 user/assistant 可显示文本。
      if (role === 'tool') continue;
      const text = extractMessageText(mo.content ?? mo.text ?? mo.message);
      if (text.trim().length === 0) continue;
      const ts = typeof mo.timestamp === 'number'
        ? mo.timestamp
        : typeof mo.createdAt === 'number'
          ? mo.createdAt
          : undefined;
      messages.push({ role, content: text, timestamp: ts });
    }
  }

  return {
    nativeId,
    title: data.title,
    cwd: data.workspacePath ?? data.cwd,
    model: data.model,
    cliVersion: data.cliVersion,
    startedAt: data.createdAt ?? data.startedAt ?? data.updatedAt,
    messages,
  };
}

/**
 * Continue 原生导入器。
 *
 * 用法：
 *   const importer = new ContinueImporter(store, { deviceId });
 *   const stats = importer.import();
 */
export class ContinueImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: ContinueImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): ContinueImportStats {
    const sessionsDir = this.options.sessionsDir ?? CONTINUE_SESSIONS_DIR;
    const sessionsIndex = this.options.sessionsIndex ?? CONTINUE_SESSIONS_INDEX;
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. 注册 coverage=A 的 continue source instance
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'continue',
      rootPath: sessionsDir,
      coverage: 'A' as Coverage,
    });

    // 2. 开始 scan_run
    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.doImport(sessionsDir, sessionsIndex, instance.id, deviceId);
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

  /** 实际导入逻辑 */
  private doImport(
    sessionsDir: string,
    sessionsIndex: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<ContinueImportStats, 'scanRunId' | 'sourceInstanceId'> {
    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let cliDiscovered = 0;
    let cliUnavailable = false;

    // —— 1. 发现阶段：收集所有 session id ——
    // 来源 A：sessions.json 索引
    const indexEntries = readSessionsIndex(sessionsIndex);
    const seenIds = new Set<string>();
    const indexById = new Map<string, SessionIndexEntry>();
    for (const e of indexEntries) {
      const id = e.id ?? e.sessionId;
      if (typeof id === 'string' && id.length > 0 && !seenIds.has(id)) {
        seenIds.add(id);
        indexById.set(id, e);
      }
    }

    // 来源 B：sessions 目录下 *.json（除 sessions.json 本身）的文件名（去 .json）
    let dirEntries: fs.Dirent[] = [];
    try {
      dirEntries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      // 目录不存在 → 继续走 CLI fallback
    }
    for (const e of dirEntries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      if (e.name === 'sessions.json') continue;
      const id = path.basename(e.name, '.json');
      if (id.length > 0 && !seenIds.has(id)) {
        seenIds.add(id);
      }
    }

    // 来源 C（fallback）：`cn ls --json` 输出
    if (this.options.useCliFallback !== false) {
      const cli = fetchSessionsFromCli();
      cliUnavailable = cli.unavailable;
      for (const e of cli.entries) {
        const id = e.id ?? e.sessionId;
        if (typeof id === 'string' && id.length > 0) {
          if (!seenIds.has(id)) {
            cliDiscovered++;
            seenIds.add(id);
            indexById.set(id, e); // CLI 提供的元数据作为索引补充
          } else if (!indexById.has(id)) {
            indexById.set(id, e);
          }
        }
      }
    }

    // —— 2. 入库阶段：逐 id 读取 session 文件 ——
    for (const id of [...seenIds].sort()) {
      scanned++;
      const filePath = path.join(sessionsDir, `${id}.json`);
      let parsed = parseSessionFile(filePath);
      if (!parsed) {
        // 文件不存在 / 解析失败 → 用索引项构造一个无消息的 stub（跳过）
        // 不入库：无消息内容无法形成有效 session
        skipped++;
        continue;
      }
      // 用索引项补全缺失元数据（CLI/索引可能含 session 文件没有的字段）
      const idx = indexById.get(id);
      if (idx) {
        if (!parsed.cwd && (idx.workspacePath ?? idx.cwd)) {
          parsed.cwd = idx.workspacePath ?? idx.cwd;
        }
        if (!parsed.model && idx.model) parsed.model = idx.model;
        if (!parsed.title && idx.title) parsed.title = idx.title;
        if (!parsed.startedAt && (idx.createdAt ?? idx.updatedAt)) {
          parsed.startedAt = idx.createdAt ?? idx.updatedAt;
        }
      }
      if (parsed.messages.length === 0) {
        skipped++;
        continue;
      }

      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.nativeId,
        source: 'continue',
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

    return {
      scanned,
      inserted,
      updated,
      unchanged,
      skipped,
      cliDiscovered,
      cliUnavailable,
    };
  }
}
