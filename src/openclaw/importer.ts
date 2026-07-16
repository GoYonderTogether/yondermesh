/**
 * OpenClaw 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ~/.openclaw/agents/<id>/sessions/ 下的 OpenClaw 原生 session JSONL，
 * 解析 session 头 / message 行并入库（architecture.md §2.2 / §3.4）。
 *
 * 真实结构（本机 ~/.openclaw 实测，2026-07）：
 *   - 路径：<rootPath>/agents/<agentId>/sessions/<uuid>.jsonl
 *   - 旋转文件：<uuid>.jsonl.reset.<isoTs>.<ms>.Z（已结束的旧 session，同样扫描）
 *   - JSONL 行 type：
 *       session            —— 头行：{ version, id, timestamp, cwd }
 *       model_change       —— 模型切换：{ provider, modelId }
 *       thinking_level_change
 *       custom             —— customType:"model-snapshot" 等
 *       message            —— 可显示消息：message.role=user|assistant，
 *                             message.content=[{type:"text",text}]，message.provider/model/usage
 *
 * 核心约束：
 *   - 只读：绝不写入 OpenClaw 私有 session 文件（架构 §2 关键取舍）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = session 头行的 id（uuid）；缺失时回退相对 rootPath 的稳定路径
 *   - 拓扑（§4）：OpenClaw 无显式 subagent 谱系字段（sessions_spawn 在运行时派生，
 *     但不写回 session 文件），故全部为 root。
 *   - 消息：只取 message 行中 user/assistant 的 text 块；排除 thinking_level_change、
 *     model_change、custom、tool 相关内部事件。
 *   - 元数据：从 sessions.json 注册表补充 model/provider/tokens/cost（如可读）。
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

/** macOS / 通用默认 OpenClaw 目录 */
const DEFAULT_OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');

/** sessions 子目录段名 */
const SESSIONS_SEGMENT = 'sessions';
/** agents 目录段名（路径中出现该段后找 sessions/） */
const AGENTS_SEGMENT = 'agents';

/** 导入器选项 */
export interface OpenClawImportOptions {
  /** 直接指定 OpenClaw 根目录，默认 ~/.openclaw */
  rootPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface OpenClawImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** openclaw source instance id */
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

/** message 字段的松散结构 */
interface MessageField {
  role?: string;
  content?: unknown;
  provider?: string;
  model?: string;
  timestamp?: number;
  usage?: {
    input?: number;
    output?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
}

/** 一个文件的解析结果 */
interface ParsedSession {
  /** native session id（session 头行的 id；缺失回退相对路径） */
  nativeId: string;
  cwd?: string;
  startedAt?: number;
  messages: SessionMessageInput[];
  model?: string;
  cliVersion?: string;
  /** provider（如 bai / openai） */
  modelProvider?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  grandTotalTokens?: number;
  estimatedCostUsd?: number;
}

/** 解析 OpenClaw 根目录：rootPath 选项优先，否则回退默认路径 */
export function resolveOpenClawPath(options: { rootPath?: string } = {}): string {
  return options.rootPath ?? DEFAULT_OPENCLAW_DIR;
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
 * OpenClaw 原生导入器。
 *
 * 用法：
 *   const importer = new OpenClawImporter(store, { rootPath, deviceId });
 *   const stats = importer.import();
 */
export class OpenClawImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: OpenClawImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): OpenClawImportStats {
    const rootPath = resolveOpenClawPath(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. rootPath 必须可读目录
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`OpenClaw 目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`OpenClaw 路径不是目录: ${rootPath}`);
    }

    // 2. 注册 coverage=A 的 openclaw source instance（rootPath=扫描根）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'openclaw',
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

  /** 把 scan_run 标记为 failed 并写 error；记录写入失败时不掩盖原始错误 */
  private finishRunFailed(runId: number, err: unknown): void {
    try {
      this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
    } catch {
      /* scan_run 记录写入失败不应掩盖导致扫描失败的原始错误 */
    }
  }

  /**
   * 扫描整棵树：收集所有 agents/<id>/sessions/ 下的 .jsonl 文件并逐一解析入库。
   */
  private scanTree(
    rootPath: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<OpenClawImportStats, 'scanRunId' | 'sourceInstanceId'> {
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
        source: 'openclaw',
        cwd: parsed.cwd,
        projectPath: parsed.cwd,
        startedAt: parsed.startedAt,
        topology: 'root',
        sourceKind: 'A',
        messages: parsed.messages,
        model: parsed.model,
        cliVersion: parsed.cliVersion,
        originator: parsed.modelProvider,
        totalInputTokens: parsed.totalInputTokens,
        totalOutputTokens: parsed.totalOutputTokens,
        totalCacheReadTokens: parsed.totalCacheReadTokens,
        totalCacheCreationTokens: parsed.totalCacheCreationTokens,
        grandTotalTokens: parsed.grandTotalTokens,
        estimatedCostUsd: parsed.estimatedCostUsd,
      });
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    return { scanned, inserted, updated, unchanged, skipped };
  }

  /**
   * 递归收集 rootPath 下所有应扫描的 session JSONL 文件。
   * 真实路径模式：agents/<agentId>/sessions/<uuid>.jsonl[.reset.<ts>]
   * 只收集路径经过 agents → sessions 段的 .jsonl 文件（排除 sessions.json 注册表）。
   * 单个目录不可读 → 跳过，不中断整棵树。
   */
  private collectSessionFiles(rootPath: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, segments: string[]): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(abs, [...segments, e.name]);
        } else if (e.isFile() && this.isSessionFile(e.name, segments)) {
          out.push(abs);
        }
      }
    };
    walk(rootPath, []);
    // 稳定字典序（相对 rootPath 的 posix 路径），消除 readdir 顺序不确定性
    out.sort((a, b) => {
      const ra = toPosix(path.relative(rootPath, a));
      const rb = toPosix(path.relative(rootPath, b));
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
    return out;
  }

  /**
   * 判断文件是否为应扫描的 session JSONL：
   *   - 文件名以 .jsonl 结尾，或匹配 .jsonl.reset.<ts>.<ms>.Z 旋转文件
   *   - 文件名不是 sessions.json（注册表，非 session 数据）
   *   - 路径经过 agents → sessions 段（agents/<id>/sessions/）
   */
  private isSessionFile(name: string, segments: string[]): boolean {
    if (name === 'sessions.json') return false;
    // 原始 .jsonl 或旋转文件 .jsonl.reset.*
    if (!name.endsWith('.jsonl') && !name.match(/\.jsonl\.reset\./)) return false;
    // 路径必须经过 agents → sessions
    const agentsIdx = segments.lastIndexOf(AGENTS_SEGMENT);
    if (agentsIdx === -1) return false;
    return segments.slice(agentsIdx + 1).includes(SESSIONS_SEGMENT);
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
      return null;
    }

    const relPath = toPosix(path.relative(rootPath, absPath));
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let earliest: number | undefined;
    let model: string | undefined;
    let modelProvider: string | undefined;
    let cliVersion: string | undefined;
    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;
    let totalCacheReadTokens: number | undefined;
    let totalCacheCreationTokens: number | undefined;
    let grandTotalTokens: number | undefined;
    let estimatedCostUsd: number | undefined;
    const messages: SessionMessageInput[] = [];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: JsonlLine;
      try {
        obj = JSON.parse(trimmed) as JsonlLine;
      } catch {
        continue; // 脏行跳过
      }

      // session 头行：采集 id / cwd / 最早时间
      if (obj.type === 'session') {
        if (sessionId === undefined && typeof obj.id === 'string' && obj.id.length > 0) {
          sessionId = obj.id;
        }
        if (cwd === undefined && typeof obj.cwd === 'string' && obj.cwd.length > 0) {
          cwd = obj.cwd;
        }
        const ts = this.parseTimestamp(obj.timestamp);
        if (ts !== undefined && (earliest === undefined || ts < earliest)) {
          earliest = ts;
        }
        // version 字段作为 cliVersion 的近似（OpenClaw 无独立 cli_version 字段）
        if (cliVersion === undefined && typeof obj.version === 'number') {
          cliVersion = `openclaw-v${obj.version}`;
        }
        continue;
      }

      // model_change 行：采集 provider / modelId
      if (obj.type === 'model_change') {
        if (modelProvider === undefined && typeof obj.provider === 'string') {
          modelProvider = obj.provider;
        }
        if (model === undefined && typeof obj.modelId === 'string' && obj.modelId.length > 0) {
          model = obj.modelId;
        }
        const ts = this.parseTimestamp(obj.timestamp);
        if (ts !== undefined && (earliest === undefined || ts < earliest)) {
          earliest = ts;
        }
        continue;
      }

      // message 行：提取可显示文本 + 元数据
      if (obj.type === 'message') {
        const msg = obj.message as MessageField | undefined;
        if (!msg) continue;
        const text = this.extractDisplayText(msg);
        if (text !== null) {
          const role = (msg.role === 'assistant' ? 'assistant' : 'user') as MessageRole;
          const ts = this.parseMessageTimestamp(msg.timestamp) ?? this.parseTimestamp(obj.timestamp);
          messages.push({ role, content: text, timestamp: ts });
        }
        // 采集模型元数据（首条非空）
        if (model === undefined && typeof msg.model === 'string' && msg.model.length > 0) {
          model = msg.model;
        }
        if (modelProvider === undefined && typeof msg.provider === 'string') {
          modelProvider = msg.provider;
        }
        // 累加 token / cost（取最后一条非零 usage，反映最终统计）
        if (msg.usage) {
          if (typeof msg.usage.input === 'number') totalInputTokens = msg.usage.input;
          if (typeof msg.usage.output === 'number') totalOutputTokens = msg.usage.output;
          if (typeof msg.usage.totalTokens === 'number') grandTotalTokens = msg.usage.totalTokens;
          if (typeof msg.usage.cacheRead === 'number') totalCacheReadTokens = msg.usage.cacheRead;
          if (typeof msg.usage.cacheWrite === 'number') totalCacheCreationTokens = msg.usage.cacheWrite;
          if (msg.usage.cost && typeof msg.usage.cost.total === 'number') {
            estimatedCostUsd = msg.usage.cost.total;
          }
        }
      }
    }

    if (messages.length === 0) return null;

    const nativeId = sessionId && sessionId.length > 0 ? sessionId : relPath;
    return {
      nativeId,
      cwd,
      startedAt: earliest,
      messages,
      model,
      cliVersion,
      modelProvider,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      grandTotalTokens,
      estimatedCostUsd,
    };
  }

  /**
   * 提取 message 的可显示文本：
   *   - content 字符串 → 该字符串
   *   - content 数组 → 只取 text 块拼接
   *   - 结果空白 → null
   */
  private extractDisplayText(msg: MessageField): string | null {
    const content = msg.content;
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

  /** 解析 ISO 时间戳为 epoch 毫秒；非法/缺失返回 undefined */
  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }

  /** 解析 message.timestamp（epoch 秒 or 毫秒）为 epoch 毫秒 */
  private parseMessageTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'number') return undefined;
    // OpenClaw message.timestamp 为 epoch 毫秒（13 位）
    return value > 1e12 ? value : value * 1000;
  }
}
