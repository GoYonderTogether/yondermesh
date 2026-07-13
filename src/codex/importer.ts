/**
 * Codex 原生 adapter（LOOP-004，覆盖等级 A）
 *
 * 只读扫描本机 ~/.codex/sessions 下的 Codex 原生 rollout JSONL，解析 session 元数据、
 * 用户/assistant 可显示消息与 subagent 谱系关系并入库（architecture.md §2.2 / §3.4）。
 *
 * 真实结构（本机 ~/.codex/sessions 实测，2026-07）：
 *   - 路径：<rootPath>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl（仅扫描 rollout-*.jsonl）
 *   - 顶层行 type：session_meta / response_item / turn_context / event_msg / compacted / world_state
 *   - session_meta.payload：{ id, session_id(实测恒 null), cwd, originator, source, thread_source,
 *       cli_version, git, model_provider, base_instructions, timestamp }
 *   - 根 session：source 为字符串（vscode/exec/cli/unknown），thread_source 为 "user" 或 null
 *   - 显式 subagent：source 为对象 { subagent: { thread_spawn: { parent_thread_id, depth,
 *       agent_path, agent_nickname, agent_role } } }，此时 thread_source 为 null
 *   - response_item.payload.type=message 且 role=user/assistant 才有可显示文本：
 *       content 数组的 input_text / output_text 块（input_image 排除）
 *     其他 payload.type（reasoning / function_call / function_call_output /
 *       custom_tool_call* / web_search_call / tool_search_*）一律排除
 *
 * 核心约束：
 *   - 只读：绝不写入 Codex 私有 session 文件（架构 §2 关键取舍）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = session_meta.payload.id；缺失时回退相对 rootPath 的稳定 posix 路径
 *
 * 归属模型（Model B —— 按 JSONL 行序 session_meta 切分 + 跨文件按 nativeId 聚合）：
 *   一个 rollout 文件可含多个 session_meta（不同 id），session_meta 切换 active session，
 *   其后的 response_item 消息归属当前 active session。一个文件可产出多个 ParsedSession。
 *   - 同一 id 的 session_meta 可能被多次重发（每轮重发）；同一 id 在文件内的所有段
 *     （连续或被其他 id 隔开）合并为一个 ParsedSession，消息按行序拼接。
 *   - 文件完全无 session_meta 时，消息归属一个 native id = 相对路径的 root 段（路径回退）。
 *   - 同一 native id 实际会分布于多个 rollout 文件（根文件 + 混合 subagent 文件重发父
 *     session_meta 及父消息作为上下文）。所有文件的 ParsedSession 先在 importer 内按
 *     nativeId 聚合为一个逻辑 session，再入库一次；当前 revision 是来自所有 rollout 段的
 *     完整消息快照，避免逐文件入库互相覆盖（旧实现只剩最后一段、且受 readdir 顺序影响丢历史）。
 *   - 聚合消息顺序确定且保持真实时序：文件按相对 rootPath 稳定字典序、文件内按行序；
 *     显式排序用 timestamp 加 (fileOrder, seq) 稳定 tie-breaker，不依赖 Map/readdir 偶然顺序。
 *   - 同 nativeId 多段元数据（稳定可解释）：cwd 取首个有效值；任一段为显式 subagent 则
 *     topology=subagent；parent_thread_id 保留首个可用值。关系在所有逻辑 session 入库后建立。
 *   - scan/insert/update/unchanged/skipped 按逻辑 session 计数（含 0 消息逻辑 session）。
 *   - 显式 subagent 逻辑 session 若无任何可显示消息，按既定规则跳过（计入 skipped），
 *     不把后续（切到别的 active session 的）消息强归给该 subagent。
 *
 * 拓扑（§4）：source（或 thread_source）为对象含 subagent → topology=subagent；否则 root。
 *   兼顾 thread_source 为对象的形态（架构文档措辞），二者皆查 subagent.thread_spawn。
 *
 * 关系（§3.4）：subagent 的 parent_thread_id 指向同次扫描已入库 session 时写 spawned_by；
 *   否则不猜测，保持独立 session 并计入 unlinkedSubagents（不可捏造关系）。
 *   关系在所有逻辑 session 入库后再建（两遍处理）。
 *
 * 消息：只取 response_item 中 user/assistant 的 input_text/output_text 可显示文本；
 *   排除 developer/system prompt、reasoning(思维链)、function_call(_output)、
 *   web_search_call、tool_search_*、input_image、turn_context、event_msg、compacted、world_state。
 *
 * 幂等：依赖 SessionStore 的 content_hash 判定（消息内容+顺序）；聚合排序确定，故重复扫描
 *   产生相同 hash、不新增 revision。脏行跳过，无有效消息的逻辑 session 跳过。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
  SessionTopology,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

/** macOS / 通用默认 Codex sessions 目录 */
const DEFAULT_CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

/** rollout 文件名前缀（只扫描 rollout-*.jsonl，排除其他 JSONL） */
const ROLLOUT_FILENAME_PREFIX = 'rollout-';

/** 导入器选项 */
export interface CodexImportOptions {
  /** 直接指定 Codex sessions 根目录，默认 ~/.codex/sessions */
  rootPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface CodexImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** codex source instance id */
  sourceInstanceId: string;
  /** 扫描到的逻辑 session 总数（同 nativeId 跨文件合并后；含 0 消息逻辑 session） */
  scanned: number;
  /** 首次创建的逻辑 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的逻辑 session 数 */
  updated: number;
  /** 内容幂等未变的逻辑 session 数 */
  unchanged: number;
  /** 跳过的逻辑 session 数（无有效消息） */
  skipped: number;
  /** 入库的 subagent 逻辑 session 数（topology=subagent 且有消息） */
  subagents: number;
  /** 有 parent_thread_id 但父未在本扫描入库、未写 spawned_by 的 subagent 数 */
  unlinkedSubagents: number;
  /** 写入的 spawned_by 关系数 */
  relationships: number;
}

/** 单条 JSONL 行的松散结构 */
type JsonlLine = Record<string, unknown>;

/** content 块的松散结构 */
interface ContentBlock {
  type?: string;
  text?: string;
}

/** session_meta.payload 的松散结构 */
interface SessionMetaPayload {
  id?: unknown;
  cwd?: unknown;
  source?: unknown;
  thread_source?: unknown;
}

/** 一个 session 段的解析结果（文件内同 id 合并后的结果） */
interface ParsedSession {
  /** native session id（session_meta.payload.id，缺失回退相对路径） */
  nativeId: string;
  cwd?: string;
  startedAt?: number;
  /** 拓扑：subagent / root */
  topology: SessionTopology;
  /** subagent 的父 native id（仅 subagent 且 parent_thread_id 可读时有值） */
  parentNativeId?: string;
  messages: SessionMessageInput[];
}

/** 文件内按 native id 累积的段（同 id 多次出现合并） */
interface SegmentAccum {
  nativeId: string;
  cwd?: string;
  topology: SessionTopology;
  parentNativeId?: string;
  earliest?: number;
  messages: SessionMessageInput[];
  /** 首 session_meta 元数据已记录，重发不覆盖 */
  metaApplied: boolean;
}

/** 聚合用消息：带稳定排序键（文件序 + 文件内行序），用于跨文件合并后确定性排序 */
interface OrderedMessage extends SessionMessageInput {
  /** 来源文件在稳定字典序文件列表中的序号 */
  fileOrder: number;
  /** 文件内该 session 段的消息行序（segment.messages 的下标） */
  seq: number;
}

/** 跨文件按 nativeId 聚合的逻辑 session（同一 nativeId 在所有 rollout 文件的段合并） */
interface LogicalAccum {
  nativeId: string;
  cwd?: string;
  topology: SessionTopology;
  parentNativeId?: string;
  startedAt?: number;
  /** 所有段的有序消息（每条带 fileOrder/seq 稳定排序键），入库前再统一稳定排序 */
  messages: OrderedMessage[];
}

/** 解析 Codex sessions 根目录：rootPath 选项优先，否则回退默认路径 */
export function resolveCodexSessionsPath(options: { rootPath?: string } = {}): string {
  return options.rootPath ?? DEFAULT_CODEX_SESSIONS_DIR;
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
 * 从 thread-origin 元数据中提取 subagent 谱系信息。
 *
 * 真实数据中 subagent 标记在 session_meta.payload.source 为对象时：
 *   { subagent: { thread_spawn: { parent_thread_id, ... } } }
 * 架构文档措辞为 thread_source.subagent；为兼容不同 Codex 版本，source 与 thread_source
 * 皆查。任一含 subagent.thread_spawn 即视为显式 subagent（parent_thread_id 可缺失）。
 */
function extractSubagentLineage(payload: SessionMetaPayload): {
  isSubagent: boolean;
  parentNativeId?: string;
} {
  const candidates: unknown[] = [payload.source, payload.thread_source];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue;
    const sub = (raw as { subagent?: unknown }).subagent;
    if (!sub || typeof sub !== 'object') continue;
    const spawn = (sub as { thread_spawn?: unknown }).thread_spawn;
    if (!spawn || typeof spawn !== 'object') continue;
    const pid = (spawn as { parent_thread_id?: unknown }).parent_thread_id;
    return {
      isSubagent: true,
      parentNativeId: typeof pid === 'string' && pid.length > 0 ? pid : undefined,
    };
  }
  return { isSubagent: false };
}

/**
 * 聚合消息的稳定比较：保持真实时序。
 *   - 主键 timestamp 升序（原始消息时间）。
 *   - 时间戳缺失或相等时用 (fileOrder, seq) 稳定 tie-breaker，绝不依赖 Map/readdir 偶然顺序。
 *   - 无时间戳的消息排在有时间戳的消息之后，彼此按文件序 + 行序。
 * (fileOrder, seq) 对每条消息唯一，故为全序，排序结果完全确定。
 */
function compareOrdered(a: OrderedMessage, b: OrderedMessage): number {
  const at = a.timestamp;
  const bt = b.timestamp;
  if (at !== undefined && bt !== undefined) {
    if (at !== bt) return at - bt;
  } else if (at !== undefined) {
    return -1; // 有时间戳排前
  } else if (bt !== undefined) {
    return 1; // 无时间戳排后
  }
  if (a.fileOrder !== b.fileOrder) return a.fileOrder - b.fileOrder;
  return a.seq - b.seq;
}

/**
 * Codex 原生导入器。
 *
 * 用法：
 *   const importer = new CodexImporter(store, { rootPath, deviceId });
 *   const stats = importer.import();
 */
export class CodexImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: CodexImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): CodexImportStats {
    const rootPath = resolveCodexSessionsPath(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. rootPath 必须可读目录
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`Codex sessions 目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Codex sessions 路径不是目录: ${rootPath}`);
    }

    // 2. 注册 coverage=A 的 codex source instance（rootPath=扫描根）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'codex',
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
      // 4. 正常完成：seen/new/updated 对齐 store 字段，skipped/unchanged 等仅在返回值
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
   * 扫描整棵树（三遍）：
   *   第一遍——逐文件按 Model B 切分为 ParsedSession，并按 nativeId 跨文件聚合为逻辑 session
   *     （同一 nativeId 在多个 rollout 文件的段合并；消息带 (fileOrder, seq) 稳定排序键）。
   *   第二遍——每个逻辑 session 只入库一次（消息稳定排序后传入），统计按逻辑 session 计数。
   *   第三遍——建 subagent→parent 的 spawned_by 关系（仅可验证父）。
   */
  private scanTree(
    rootPath: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<CodexImportStats, 'scanRunId' | 'sourceInstanceId'> {
    const files = this.collectRolloutFiles(rootPath);

    // —— 第一遍：逐文件解析 + 跨文件按 nativeId 聚合 ——
    const logical = new Map<string, LogicalAccum>();
    files.forEach((absPath, fileOrder) => {
      const segments = this.parseFile(absPath, rootPath);
      for (const seg of segments) {
        this.mergeSegment(logical, seg, fileOrder);
      }
    });

    // 逻辑 session 按 nativeId 稳定遍历（入库顺序对结果无影响，但统计/顺序需确定）
    const logicalList = Array.from(logical.values()).sort((a, b) =>
      a.nativeId < b.nativeId ? -1 : a.nativeId > b.nativeId ? 1 : 0,
    );

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let subagents = 0;
    let unlinkedSubagents = 0;
    let relationships = 0;

    /** nativeId → 内部 session id，供 subagent 查父（同 id 多段入库后指向同一 session） */
    const sessionIdByNative = new Map<string, string>();
    /** 已入库的 subagent 逻辑 session：{internalId, parentNativeId} */
    const subRecords: Array<{ internalId: string; parentNativeId?: string }> = [];

    // —— 第二遍：每个逻辑 session 入库一次 ——
    for (const lg of logicalList) {
      scanned++; // 逻辑 session 计数（含 0 消息）
      if (lg.messages.length === 0) {
        skipped++; // 无有效消息 → 跳过该逻辑 session（含 0 消息 subagent）
        continue;
      }
      // 稳定排序：保持真实时序（timestamp 主键 + (fileOrder, seq) 稳定 tie-breaker）
      const ordered = lg.messages.slice().sort(compareOrdered);
      const messages = ordered.map(({ role, content, timestamp }) => ({
        role,
        content,
        timestamp,
      }));
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: lg.nativeId,
        source: 'codex',
        cwd: lg.cwd,
        startedAt: lg.startedAt,
        topology: lg.topology,
        sourceKind: 'A',
        messages,
      });
      sessionIdByNative.set(lg.nativeId, result.sessionId);
      if (lg.topology === 'subagent') {
        subagents++;
        subRecords.push({
          internalId: result.sessionId,
          parentNativeId: lg.parentNativeId,
        });
      }
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    // —— 第三遍：subagent → parent spawned_by（仅可验证父）——
    for (const sub of subRecords) {
      if (!sub.parentNativeId) continue; // 无 parent_thread_id → 无法建关系，不猜测
      const parentId = sessionIdByNative.get(sub.parentNativeId);
      if (!parentId || parentId === sub.internalId) {
        // 父未在本扫描入库 → 保持独立，不捏造关系
        unlinkedSubagents++;
        continue;
      }
      this.store.addRelationship({
        fromSessionId: sub.internalId,
        toSessionId: parentId,
        relationType: 'spawned_by',
        evidence: 'codex session_meta source.subagent.thread_spawn',
      });
      relationships++;
    }

    return {
      scanned,
      inserted,
      updated,
      unchanged,
      skipped,
      subagents,
      unlinkedSubagents,
      relationships,
    };
  }

  /**
   * 把一个文件内解析出的段合并进跨文件逻辑 session 聚合表。
   * 元数据规则（稳定可解释）：
   *   - cwd：首个有效值（稳定文件序中第一个有 cwd 的段），不覆盖。
   *   - topology：任一段为显式 subagent → subagent。
   *   - parentNativeId：保留首个可用值。
   *   - startedAt：跨段最小时间戳。
   * 消息：带 (fileOrder, seq) 追加，入库前由 scanTree 统一稳定排序。
   */
  private mergeSegment(
    logical: Map<string, LogicalAccum>,
    seg: ParsedSession,
    fileOrder: number,
  ): void {
    let lg = logical.get(seg.nativeId);
    if (!lg) {
      lg = {
        nativeId: seg.nativeId,
        topology: 'root',
        messages: [],
      };
      logical.set(seg.nativeId, lg);
    }
    if (lg.cwd === undefined && seg.cwd !== undefined) {
      lg.cwd = seg.cwd;
    }
    if (seg.topology === 'subagent') {
      lg.topology = 'subagent';
      if (lg.parentNativeId === undefined && seg.parentNativeId !== undefined) {
        lg.parentNativeId = seg.parentNativeId;
      }
    }
    if (
      seg.startedAt !== undefined &&
      (lg.startedAt === undefined || seg.startedAt < lg.startedAt)
    ) {
      lg.startedAt = seg.startedAt;
    }
    for (let i = 0; i < seg.messages.length; i++) {
      const m = seg.messages[i]!;
      lg.messages.push({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        fileOrder,
        seq: i,
      });
    }
  }

  /**
   * 递归收集 rootPath 下所有应扫描的 rollout-*.jsonl 文件，并按相对 rootPath 的 posix 路径
   * 稳定字典序排序（消除 readdir 顺序不确定性，保证跨文件聚合确定性；rollout 文件名含
   * ISO 时间戳，字典序即真实时序）。
   * 排除：非 rollout- 前缀文件、非 .jsonl 文件（.json / .lock / .txt 等）。
   * 单个目录不可读 → 跳过该目录，不中断整棵树。
   */
  private collectRolloutFiles(rootPath: string): string[] {
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
          e.name.startsWith(ROLLOUT_FILENAME_PREFIX) &&
          e.name.endsWith('.jsonl')
        ) {
          out.push(abs);
        }
      }
    };
    walk(rootPath);
    // 稳定字典序（相对 rootPath 的 posix 路径），消除 readdir 顺序不确定性
    out.sort((a, b) => {
      const ra = toPosix(path.relative(rootPath, a));
      const rb = toPosix(path.relative(rootPath, b));
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
    return out;
  }

  /**
   * 按 Model B 解析单个 rollout JSONL 文件，返回多个 session 段（文件内同 id 多次出现
   * 合并为一段）。
   *
   * 行序处理：session_meta 切换 active session（currentId）；其后的 response_item 消息
   * 归属 currentId。同一 native id 在文件内的所有段（含被其他 id 隔开的）合并为一个
   * ParsedSession（消息按行序拼接），避免文件内同 id 重复切分。
   * 文件完全无 session_meta 时，消息归 native id = 相对路径的 root 段（路径回退）。
   * 单行 JSON 损坏跳过该行（LOOP-004 continue）。
   *
   * 返回所有段（含 0 消息段）。跨文件同 nativeId 的聚合由 scanTree 负责；跳过与计数由
   * 调用方处理。
   */
  private parseFile(absPath: string, rootPath: string): ParsedSession[] {
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch {
      return []; // 文件不可读 → 无段
    }

    const relPath = toPosix(path.relative(rootPath, absPath));
    const segments = new Map<string, SegmentAccum>();
    /** 当前 active session 的 native id（最近一次 session_meta 的 id）；null=尚未见到 */
    let currentId: string | null = null;

    const ensureSegment = (id: string): SegmentAccum => {
      let seg = segments.get(id);
      if (!seg) {
        seg = {
          nativeId: id,
          topology: 'root',
          messages: [],
          metaApplied: false,
        };
        segments.set(id, seg);
      }
      return seg;
    };

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: JsonlLine;
      try {
        obj = JSON.parse(trimmed) as JsonlLine;
      } catch {
        continue; // 脏行跳过
      }

      const ts = this.parseTimestamp(obj.timestamp);

      // session_meta 切换 active session
      if (obj.type === 'session_meta') {
        const meta = (obj.payload as SessionMetaPayload | undefined) ?? {};
        const id = typeof meta.id === 'string' && meta.id.length > 0 ? meta.id : null;
        if (id) {
          currentId = id;
          const seg = ensureSegment(id);
          // 首 session_meta 记录元数据（cwd / 拓扑 / 父），重发不覆盖
          if (!seg.metaApplied) {
            seg.metaApplied = true;
            if (typeof meta.cwd === 'string' && meta.cwd.length > 0) {
              seg.cwd = meta.cwd;
            }
            const lineage = extractSubagentLineage(meta);
            if (lineage.isSubagent) {
              seg.topology = 'subagent';
              seg.parentNativeId = lineage.parentNativeId;
            }
          }
          if (ts !== undefined && (seg.earliest === undefined || ts < seg.earliest)) {
            seg.earliest = ts;
          }
        }
        continue;
      }

      // 仅取 response_item 中 user/assistant 的可显示文本
      const text = this.extractDisplayText(obj);
      if (text !== null) {
        // 无 active session（尚未见 session_meta）→ 归路径回退段
        const targetId = currentId ?? relPath;
        const seg = ensureSegment(targetId);
        if (ts !== undefined && (seg.earliest === undefined || ts < seg.earliest)) {
          seg.earliest = ts;
        }
        const role = (obj.payload as { role?: unknown } | undefined)?.role;
        const mapped = role === 'assistant' ? 'assistant' : 'user';
        seg.messages.push({ role: mapped as MessageRole, content: text, timestamp: ts });
      }
    }

    return Array.from(segments.values()).map((seg) => ({
      nativeId: seg.nativeId,
      cwd: seg.cwd,
      startedAt: seg.earliest,
      topology: seg.topology,
      parentNativeId: seg.parentNativeId,
      messages: seg.messages,
    }));
  }

  /**
   * 提取一行的可显示文本：
   *   - 非 response_item 行 → null（turn_context / event_msg / compacted / world_state / session_meta）
   *   - payload.type !== 'message' → null（reasoning / function_call / web_search_call 等内部事件）
   *   - role 非 user/assistant → null（developer/system prompt 排除）
   *   - content 数组 → 只取 input_text / output_text 块拼接；input_image 等排除
   *   - 结果空白 → null
   */
  private extractDisplayText(obj: JsonlLine): string | null {
    if (obj.type !== 'response_item') return null;
    const payload = obj.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined;
    if (!payload) return null;
    if (payload.type !== 'message') return null;
    if (payload.role !== 'user' && payload.role !== 'assistant') return null;

    const content = payload.content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const block of content as ContentBlock[]) {
      // 仅 input_text / output_text 为可显示文本；input_image / 其他块排除
      if (
        block &&
        (block.type === 'input_text' || block.type === 'output_text') &&
        typeof block.text === 'string'
      ) {
        parts.push(block.text);
      }
    }
    if (parts.length === 0) return null;
    const joined = parts.join('\n');
    return joined.trim().length > 0 ? joined : null;
  }

  /** 解析 ISO 时间戳为 epoch 毫秒；非法/缺失返回 undefined */
  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
}
