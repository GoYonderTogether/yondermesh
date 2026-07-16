/**
 * Claude Code 原生 adapter（LOOP-003，覆盖等级 A）
 *
 * 只读扫描本机 ~/.claude/projects 下的 Claude Code 原生 session，解析 root / subagent /
 * sidechain 关系并入库（architecture.md §2.2 / §3.4）。
 *
 * 核心约束：
 *   - 只读：绝不写入 Claude 私有 session 文件（架构 §2 关键取舍）。
 *   - 路径结构：
 *       <rootPath>/<projectDir>/<uuid>.jsonl                      —— 根 session
 *       <rootPath>/<projectDir>/<uuid>/subagents/agent-<id>.jsonl —— 子 agent
 *       <rootPath>/<projectDir>/<uuid>/subagents/agent-<id>.meta.json —— 元数据(排除)
 *       <rootPath>/<projectDir>/<uuid>/tool-results/<...>         —— 工具结果(排除)
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · 根：native id = sessionId 字段，缺失时回退相对 rootPath 的稳定路径
 *       · 子 agent：native id = parentRootId:agentId（agentId 缺失回退相对路径），
 *         含 ':' 不可能与根的裸 sessionId 冲突
 *   - 关系（§3.4）：子 → 父 spawned_by；isSidechain=true 的子额外写 sidechain_of。
 *     两遍处理（先根后子），保证关系外键可满足；父 session 未入库则不猜测关系。
 *   - 消息：只取 user/assistant 的可显示文本块（text）；排除 thinking（思维链）、
 *     tool_use、tool_result 与 isMeta 行（架构 §4：不保存思维链/内部 context）。
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

/** macOS / 通用默认 Claude Code projects 目录 */
const DEFAULT_CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** subagents 目录段名（路径中出现该段即判定为子 agent） */
const SUBAGENTS_SEGMENT = 'subagents';
/** tool-results 目录段名（路径中出现该段整体排除） */
const TOOL_RESULTS_SEGMENT = 'tool-results';

/** 导入器选项 */
export interface ClaudeImportOptions {
  /** 直接指定 Claude projects 根目录，默认 ~/.claude/projects */
  rootPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface ClaudeImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** claude-code source instance id */
  sourceInstanceId: string;
  /** 扫描到的 JSONL 文件总数（含根与子；已排除 tool-results/.meta.json） */
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
  name?: string;
}

/** 一个文件的解析结果 */
interface ParsedSession {
  /** native session id（根=sessionId，子=parentRootId:agentId / 回退相对路径） */
  nativeId: string;
  /** 父根的 native id（仅子 agent 有；根为 undefined） */
  parentRootNativeId?: string;
  cwd?: string;
  startedAt?: number;
  sidechain: boolean;
  messages: SessionMessageInput[];
  model?: string;
  cliVersion?: string;
}

/** 解析 Claude projects 根目录：rootPath 选项优先，否则回退默认路径 */
export function resolveClaudeProjectsPath(options: { rootPath?: string } = {}): string {
  return options.rootPath ?? DEFAULT_CLAUDE_PROJECTS_DIR;
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
 * Claude Code 原生导入器。
 *
 * 用法：
 *   const importer = new ClaudeCodeImporter(store, { rootPath, deviceId });
 *   const stats = importer.import();
 */
export class ClaudeCodeImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: ClaudeImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): ClaudeImportStats {
    const rootPath = resolveClaudeProjectsPath(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. rootPath 必须可读目录
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`Claude projects 目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Claude projects 路径不是目录: ${rootPath}`);
    }

    // 2. 注册 coverage=A 的 claude-code source instance（rootPath=扫描根）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'claude-code',
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
      // 4. 正常完成：seen/new/updated 对齐 store 字段，skipped/unchanged 仅在返回值
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

  /** 获取文件 mtime（ms），失败回退到 Date.now() */
  private getFileMtime(filePath: string): number {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return Date.now();
    }
  }

  /**
   * 扫描整棵树：先收集文件并分根/子，两遍入库（先根后子），最后建关系。
   * 父根先入库，子 agent 的 spawned_by / sidechain_of 外键才能满足。
   */
  private scanTree(
    rootPath: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<ClaudeImportStats, 'scanRunId' | 'sourceInstanceId'> {
    const files = this.collectJsonlFiles(rootPath);

    type Item = { absPath: string; relPath: string; isSubagent: boolean };
    const roots: Item[] = [];
    const subs: Item[] = [];
    for (const f of files) {
      (f.isSubagent ? subs : roots).push(f);
    }

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    /** nativeId → 内部 session id，供子 agent 建关系查父 */
    const rootIdByNative = new Map<string, string>();
    /** 已入库的子 agent：nativeId → {internalId, parentRootNativeId, sidechain} */
    const subRecords: Array<{
      internalId: string;
      parentRootNativeId?: string;
      sidechain: boolean;
    }> = [];

    // —— 第一遍：根 session ——
    for (const item of roots) {
      scanned++;
      const parsed = this.parseFile(item.absPath, rootPath, false);
      if (!parsed) {
        skipped++; // 无有效消息 → 跳过该文件
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.nativeId,
        source: 'claude-code',
        cwd: parsed.cwd,
        projectPath: parsed.cwd,
        startedAt: parsed.startedAt,
       topology: 'root',
       sourceKind: 'A',
       messages: parsed.messages,
      model: parsed.model,
      cliVersion: parsed.cliVersion,
      threadSource: parsed.sidechain ? 'sidechain' : 'user',
      fileModifiedAt: this.getFileMtime(item.absPath),
    });
    rootIdByNative.set(parsed.nativeId, result.sessionId);
      this.tally(result, { inserted: () => inserted++, updated: () => updated++, unchanged: () => unchanged++ });
    }

    // —— 第二遍：子 agent ——
    for (const item of subs) {
      scanned++;
      const parsed = this.parseFile(item.absPath, rootPath, true);
      if (!parsed) {
        skipped++;
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.nativeId,
        source: 'claude-code',
        cwd: parsed.cwd,
        projectPath: parsed.cwd,
        startedAt: parsed.startedAt,
       topology: 'subagent',
       sourceKind: 'A',
       messages: parsed.messages,
      model: parsed.model,
      cliVersion: parsed.cliVersion,
      threadSource: parsed.sidechain ? 'sidechain' : 'user',
      fileModifiedAt: this.getFileMtime(item.absPath),
    });
    this.tally(result, {
        inserted: () => inserted++,
        updated: () => updated++,
        unchanged: () => unchanged++,
      });
      subRecords.push({
        internalId: result.sessionId,
        parentRootNativeId: parsed.parentRootNativeId,
        sidechain: parsed.sidechain,
      });
    }

    // —— 关系：子 → 父 spawned_by（+ sidechain_of）——
    for (const sub of subRecords) {
      const parentId = sub.parentRootNativeId
        ? rootIdByNative.get(sub.parentRootNativeId)
        : undefined;
      if (!parentId) continue; // 父未入库 → 不猜测关系（§3.4）
      this.store.addRelationship({
        fromSessionId: sub.internalId,
        toSessionId: parentId,
        relationType: 'spawned_by',
        evidence: 'claude subagents path',
      });
      if (sub.sidechain) {
        this.store.addRelationship({
          fromSessionId: sub.internalId,
          toSessionId: parentId,
          relationType: 'sidechain_of',
          evidence: 'isSidechain=true',
        });
      }
    }

    return { scanned, inserted, updated, unchanged, skipped };
  }

  /** 根据 ingest 结果累加到对应统计桶 */
  private tally(
    result: { created: boolean; newRevision: boolean },
    buckets: { inserted: () => void; updated: () => void; unchanged: () => void },
  ): void {
    if (result.created) buckets.inserted();
    else if (result.newRevision) buckets.updated();
    else buckets.unchanged();
  }

  /**
   * 递归收集 rootPath 下所有应扫描的 .jsonl 文件。
   * 排除：路径经过 tool-results 段；.meta.json（非 .jsonl，双重保险）。
   * 判定子 agent：路径含 subagents 段。
   */
  private collectJsonlFiles(
    rootPath: string,
  ): Array<{ absPath: string; relPath: string; isSubagent: boolean }> {
    const out: Array<{ absPath: string; relPath: string; isSubagent: boolean }> = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // 单个目录不可读 → 跳过，不中断整棵树
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === TOOL_RESULTS_SEGMENT) continue; // 排除 tool-results/
          walk(abs);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          const rel = toPosix(path.relative(rootPath, abs));
          const segs = rel.split('/');
          const isSubagent = segs.includes(SUBAGENTS_SEGMENT);
          out.push({ absPath: abs, relPath: rel, isSubagent });
        }
      }
    };
    walk(rootPath);
    return out;
  }

  /**
   * 解析单个 JSONL 文件，返回 native id / cwd / 最早时间 / 消息。
   * 单行 JSON 损坏跳过该行（LOOP-003 continue）；无有效消息返回 null（跳过文件）。
   */
  private parseFile(
    absPath: string,
    rootPath: string,
    isSubagent: boolean,
  ): ParsedSession | null {
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null; // 文件不可读 → 跳过
    }

    const relPath = toPosix(path.relative(rootPath, absPath));
    let sessionId: string | undefined;
    let agentId: string | undefined;
    let cwd: string | undefined;
    let earliest: number | undefined;
    let sidechain = false;
    let model: string | undefined;
    let cliVersion: string | undefined;
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

      // 采集稳定字段（每行重复，取首个非空）
      if (sessionId === undefined && typeof obj.sessionId === 'string') {
        sessionId = obj.sessionId;
      }
      if (agentId === undefined && typeof obj.agentId === 'string') {
        agentId = obj.agentId;
      }
      if (cwd === undefined && typeof obj.cwd === 'string') {
        cwd = obj.cwd;
      }
      if (obj.isSidechain === true) sidechain = true;
      // 元数据提取（LOOP-012）：model 嵌套在 message.model，version 在顶层
      if (model === undefined) {
        const msg = obj.message as Record<string, unknown> | undefined;
        if (msg && typeof msg.model === 'string' && msg.model.length > 0) {
          model = msg.model;
        }
      }
      if (cliVersion === undefined && typeof obj.version === 'string' && obj.version.length > 0) {
        cliVersion = obj.version;
      }

      const ts = this.parseTimestamp(obj.timestamp);
      if (ts !== undefined && (earliest === undefined || ts < earliest)) {
        earliest = ts;
      }

      // 仅取 user/assistant 的可显示文本
      const text = this.extractDisplayText(obj);
      if (text !== null) {
        const role = (obj.type === 'assistant' ? 'assistant' : 'user') as MessageRole;
        messages.push({ role, content: text, timestamp: ts });
      }
    }

    if (messages.length === 0) return null; // 无有效消息 → 跳过文件

    // native id
    let nativeId: string;
    let parentRootNativeId: string | undefined;
    if (isSubagent) {
      // 子 agent 的 sessionId 字段指向父根的 sessionId（=父 native id）
      parentRootNativeId = sessionId; // 可能为 undefined
      nativeId =
        parentRootNativeId && agentId
          ? `${parentRootNativeId}:${agentId}`
          : relPath; // 缺失 → 回退相对路径
    } else {
      nativeId = sessionId && sessionId.length > 0 ? sessionId : relPath;
    }

    return { nativeId, parentRootNativeId, cwd, startedAt: earliest, sidechain, messages, model, cliVersion };
  }

  /**
   * 提取一行的可显示文本：
   *   - 非 user/assistant 行 → null
   *   - isMeta 行 → null（meta/caveat，内部 context）
   *   - content 字符串 → 该字符串（去空白后非空才返回）
   *   - content 数组 → 只取 text 块拼接；thinking / tool_use / tool_result 排除
   *   - 结果空白 → null（该条不入库）
   */
  private extractDisplayText(obj: JsonlLine): string | null {
    if (obj.type !== 'user' && obj.type !== 'assistant') return null;
    if (obj.isMeta === true) return null;

    const message = obj.message as { role?: string; content?: unknown } | undefined;
    if (!message) return null;
    const content = message.content;
    if (typeof content === 'string') {
      return content.trim().length > 0 ? content : null;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content as ContentBlock[]) {
        // 仅 text 块为可显示文本；thinking(思维链)/tool_use/tool_result 排除
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
}
