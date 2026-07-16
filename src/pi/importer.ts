/**
 * Pi Agent 家族原生 adapter（Pi / oh-my-pi / gsd-pi，覆盖等级 A）
 *
 * 三者共享 JSONL v3 树结构格式（每条 entry 有 `id` + `parentId`）与 RPC steer 中途介入能力，
 * 因此共享同一 importer，通过配置目录路径区分 source：
 *   - pi     → ~/.pi/agent/   (source=pi,     cli=pi)
 *   - omp    → ~/.omp/agent/  (source=omp,    cli=omp)
 *   - gsd-pi → ~/.gsd/agent/  (source=gsd-pi, cli=gsd)
 *
 * 真实结构（本机实测，2026-07）：
 *   - 路径：<sessionsDir>/<encoded-cwd>/<ts>_<uuid>.jsonl
 *   - 首行（omp 可选）：{ type:"title", v:1, title, updatedAt, pad }
 *   - session 行：{ type:"session", version:3, id:<UUID>, timestamp, cwd } —— 根 session 元数据
 *   - model_change 行：{ type:"model_change", id, parentId, timestamp,
 *       provider, modelId }            —— pi/gsd：provider + modelId 分离
 *       | { ..., model:"glm/glm-5.2" } —— omp：合并 model 字符串
 *   - thinking_level_change 行：{ type:"thinking_level_change", id, parentId, thinkingLevel }
 *   - message 行：{ type:"message", id, parentId, timestamp,
 *       message:{ role:"user"|"assistant", content:[{type:"text"|"thinking",...}],
 *                 timestamp, provider?, model?, usage?, stopReason? } }
 *
 * 树结构：每个 entry 的 `id` + `parentId`（null=树根，通常指向 model_change）构成会话内的
 * 分叉树（fork tree）。一个 .jsonl 文件 = 一个 root session（topology=root），其内部的
 * 分叉树是会话分支历史，不被拆成多个 ymesh session；ymesh 存储线性消息序列（按文件追加序），
 * 完整 entry 树由 extractSessionTree() 保留供 transferSession 忠实重建。
 *
 * 核心约束（与 claude/codex adapter 一致）：
 *   - 只读：绝不写入 Pi 家族私有 session 文件（架构 §2 关键取舍）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = session 行的 id（UUID，v7 或 v4）；缺失时回退相对 rootPath 的稳定 posix 路径
 *   - 消息：只取 type:"message" 中 user/assistant 的可显示 text 块；排除 thinking（思维链）、
 *     tool_use / tool_result、title / model_change / thinking_level_change 等内部行。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定；脏行跳过，无有效消息的文件跳过。
 *   - gsd 路径兼容：spec 为 ~/.gsd/agent/sessions/，本机旧版 gsd 实际写入 ~/.gsd/sessions/，
 *     故 gsd flavor 探测两个候选目录，首个存在者生效。
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

/** Pi 家族 flavor 标识（与 canonical source 一致） */
export type PiFlavor = 'pi' | 'omp' | 'gsd-pi';

/** 单个 flavor 的运行时配置 */
export interface PiFlavorConfig {
  /** canonical source 名（写入 store） */
  source: string;
  /** CLI 二进制名 */
  cli: string;
  /** agent 配置目录（含 models.json / mcp.json / skills/） */
  configDir: string;
  /** session 根目录候选（按顺序探测，首个存在且为目录者生效） */
  sessionsDirs: string[];
  /** GLM-5.2 模型选择参数 */
  glmModelArg: string;
  /** 已解析生效的 session 根目录（resolve 后填充；全部不存在则为 null） */
  sessionsDir: string | null;
}

/** 导入器选项 */
export interface PiImportOptions {
  /** 直接指定 flavor 配置（覆盖默认探测）；通常用于测试 */
  flavors?: PiFlavorConfig[];
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
  /** 仅导入指定 flavor（source 名），默认全部 */
  only?: PiFlavor | string;
}

/** 单 flavor 导入统计 */
export interface PiFlavorStats {
  /** flavor canonical source */
  source: string;
  /** cli 名 */
  cli: string;
  /** 生效的 session 根目录（null=目录不存在，跳过） */
  sessionsDir: string | null;
  /** 本次 scan_run id */
  scanRunId: number;
  /** source instance id */
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

/** 聚合导入统计 */
export interface PiImportStats {
  /** 各 flavor 分项统计 */
  flavors: PiFlavorStats[];
  /** 汇总：扫描文件数 */
  scanned: number;
  /** 汇总：新增 */
  inserted: number;
  /** 汇总：更新 */
  updated: number;
  /** 汇总：未变 */
  unchanged: number;
  /** 汇总：跳过 */
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
  /** native session id（session 行的 id；缺失回退相对路径） */
  nativeId: string;
  cwd?: string;
  startedAt?: number;
  /** 完整 entry 树（id/parentId/type），保留拓扑供 transfer 重建 */
  entries: PiEntry[];
  messages: SessionMessageInput[];
  model?: string;
  cliVersion?: string;
}

/** entry 树节点（保留原始拓扑，用于 transferSession 忠实重建） */
export interface PiEntry {
  id: string | null;
  parentId: string | null;
  type: string;
  timestamp?: number;
  /** 原始行（完整保留，转中性格式时直接复用） */
  raw: JsonlLine;
}

/** 解析出的中性 session（用于三 CLI 间互转） */
export interface PiNeutralSession {
  /** 来源 flavor source */
  source: string;
  /** native session id */
  nativeId: string;
  cwd?: string;
  startedAt?: number;
  model?: string;
  /** 完整 entry 树（按文件行序） */
  entries: PiEntry[];
  /** 线性可显示消息 */
  messages: SessionMessageInput[];
  /** 源文件绝对路径 */
  filePath: string;
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
 * 解析默认 flavor 配置（基于本机 home 目录）。
 * gsd 探测 ~/.gsd/agent/sessions/（spec）与 ~/.gsd/sessions/（旧版兼容）两个候选。
 */
export function resolvePiFlavors(home: string = os.homedir()): PiFlavorConfig[] {
  return [
    {
      source: 'pi',
      cli: 'pi',
      configDir: path.join(home, '.pi', 'agent'),
      sessionsDirs: [path.join(home, '.pi', 'agent', 'sessions')],
      // 实测（pi 0.80.6）：--model glm 会误解析到 vercel-ai-gateway（无 API key）；
      // 正确格式为 provider/modelId，与 models.json 的 glm/glm-5.2 一致。
      glmModelArg: '--model glm/glm-5.2',
      sessionsDir: null,
    },
    {
      source: 'omp',
      cli: 'omp',
      configDir: path.join(home, '.omp', 'agent'),
      sessionsDirs: [path.join(home, '.omp', 'agent', 'sessions')],
      glmModelArg: '--model glm/glm-5.2',
      sessionsDir: null,
    },
    {
      source: 'gsd-pi',
      cli: 'gsd',
      configDir: path.join(home, '.gsd', 'agent'),
      sessionsDirs: [
        path.join(home, '.gsd', 'agent', 'sessions'),
        path.join(home, '.gsd', 'sessions'), // 旧版 gsd 兼容
      ],
      glmModelArg: '--model glm-5.2',
      sessionsDir: null,
    },
  ];
}

/** 探测并填充 flavor 的生效 sessionsDir（首个存在且为目录者） */
export function resolveFlavorSessionsDir(flavor: PiFlavorConfig): string | null {
  for (const dir of flavor.sessionsDirs) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // 候选不存在，继续
    }
  }
  return null;
}

/**
 * Pi Agent 家族统一导入器。
 *
 * 用法：
 *   const importer = new PiImporter(store, { deviceId });
 *   const stats = importer.import();           // 全部 flavor
 *   const stats = importer.import('omp');      // 仅 omp
 */
export class PiImporter {
  private readonly flavors: PiFlavorConfig[];

  constructor(
    private readonly store: SessionStore,
    private readonly options: PiImportOptions = {},
  ) {
    this.flavors = (options.flavors ?? resolvePiFlavors()).map((f) => ({
      ...f,
      sessionsDir: resolveFlavorSessionsDir(f),
    }));
  }

  /** 执行扫描；传入 only 则只扫该 flavor，否则扫全部 */
  import(only?: PiFlavor | string): PiImportStats {
    const deviceId = this.options.deviceId ?? os.hostname();
    const onlySource = only ?? this.options.only;
    const flavors = onlySource
      ? this.flavors.filter(
          (f) => f.source === onlySource || f.cli === onlySource,
        )
      : this.flavors;

    const flavorStats: PiFlavorStats[] = [];
    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const flavor of flavors) {
      const stat = this.importFlavor(flavor, deviceId);
      flavorStats.push(stat);
      scanned += stat.scanned;
      inserted += stat.inserted;
      updated += stat.updated;
      unchanged += stat.unchanged;
      skipped += stat.skipped;
    }

    return { flavors: flavorStats, scanned, inserted, updated, unchanged, skipped };
  }

  /** 扫描单个 flavor */
  private importFlavor(flavor: PiFlavorConfig, deviceId: string): PiFlavorStats {
    const base: PiFlavorStats = {
      source: flavor.source,
      cli: flavor.cli,
      sessionsDir: flavor.sessionsDir,
      scanRunId: 0,
      sourceInstanceId: '',
      scanned: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    };

    // 目录不存在：注册 source instance 但跳过 scan_run（无数据可扫）
    const rootPath = flavor.sessionsDir;
    if (!rootPath) {
      const instance = this.store.registerSourceInstance({
        deviceId,
        source: flavor.source,
        rootPath: flavor.configDir,
        coverage: 'A' as Coverage,
      });
      base.sourceInstanceId = instance.id;
      return base;
    }

    const instance = this.store.registerSourceInstance({
      deviceId,
      source: flavor.source,
      rootPath,
      coverage: 'A' as Coverage,
    });
    base.sourceInstanceId = instance.id;

    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });
    base.scanRunId = runId;

    try {
      const counts = this.scanTree(rootPath, instance.id, deviceId, flavor.source);
      this.store.finishScanRun(runId, {
        status: 'completed',
        sessionsSeen: counts.scanned,
        sessionsNew: counts.inserted,
        sessionsUpdated: counts.updated,
      });
      Object.assign(base, counts);
      return base;
    } catch (err) {
      try {
        this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
      } catch {
        /* 不掩盖原始错误 */
      }
      throw err;
    }
  }

  /** 扫描整棵 session 树 */
  private scanTree(
    rootPath: string,
    sourceInstanceId: string,
    deviceId: string,
    source: string,
  ): Omit<PiFlavorStats, 'source' | 'cli' | 'sessionsDir' | 'scanRunId' | 'sourceInstanceId'> {
    const files = this.collectJsonlFiles(rootPath);
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
        source,
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

  /** 递归收集 rootPath 下所有 .jsonl 文件，按相对路径稳定字典序 */
  private collectJsonlFiles(rootPath: string): string[] {
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
    out.sort((a, b) => {
      const ra = toPosix(path.relative(rootPath, a));
      const rb = toPosix(path.relative(rootPath, b));
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
    return out;
  }

  /**
   * 解析单个 JSONL v3 文件，返回 native id / cwd / 最早时间 / 消息 / entry 树。
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
    let nativeId: string | undefined;
    let cwd: string | undefined;
    let earliest: number | undefined;
    let model: string | undefined;
    let cliVersion: string | undefined;
    const messages: SessionMessageInput[] = [];
    const entries: PiEntry[] = [];

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
      const entryType = typeof obj.type === 'string' ? obj.type : '';
      const entryId = typeof obj.id === 'string' ? obj.id : null;
      const entryParent = typeof obj.parentId === 'string' ? obj.parentId : null;

      // 保留 entry 树（除 title 等 UI 行外）
      if (entryType && entryType !== 'title') {
        entries.push({
          id: entryId,
          parentId: entryParent,
          type: entryType,
          timestamp: ts,
          raw: obj,
        });
      }

      // session 行：根元数据
      if (entryType === 'session') {
        if (nativeId === undefined && entryId) nativeId = entryId;
        if (cwd === undefined && typeof obj.cwd === 'string') cwd = obj.cwd;
      }

      // version 字段作 cliVersion 线索（非严格）
      if (cliVersion === undefined && typeof obj.version === 'number') {
        cliVersion = `v${obj.version}`;
      }

      // model_change：提取 model（pi/gsd 用 provider+modelId；omp 用合并 model）
      if (entryType === 'model_change' && model === undefined) {
        model = this.extractModelFromChange(obj);
      }

      if (ts !== undefined && (earliest === undefined || ts < earliest)) {
        earliest = ts;
      }

      // message 行：提取可显示文本
      const text = this.extractDisplayText(obj);
      if (text !== null) {
        const role = this.extractRole(obj);
        // message 内嵌 model 字段最准确（按轮次），优先取首个非空
        if (model === undefined) {
          const msgModel = this.extractMessageModel(obj);
          if (msgModel) model = msgModel;
        }
        messages.push({ role, content: text, timestamp: ts });
      }
    }

    if (messages.length === 0) return null;

    const resolvedNativeId = nativeId && nativeId.length > 0 ? nativeId : relPath;
    return {
      nativeId: resolvedNativeId,
      cwd,
      startedAt: earliest,
      entries,
      messages,
      model,
      cliVersion,
    };
  }

  /** 从 model_change 行提取 model 字符串 */
  private extractModelFromChange(obj: JsonlLine): string | undefined {
    // omp：合并 model 字符串（如 "glm/glm-5.2"）
    if (typeof obj.model === 'string' && obj.model.length > 0) return obj.model;
    // pi/gsd：provider + modelId 分离
    const provider = typeof obj.provider === 'string' ? obj.provider : undefined;
    const modelId = typeof obj.modelId === 'string' ? obj.modelId : undefined;
    if (modelId) return provider ? `${provider}/${modelId}` : modelId;
    return undefined;
  }

  /** 从 message 行内嵌 message.model 提取 model */
  private extractMessageModel(obj: JsonlLine): string | undefined {
    const msg = obj.message as { model?: unknown } | undefined;
    if (msg && typeof msg.model === 'string' && msg.model.length > 0) {
      return msg.model;
    }
    return undefined;
  }

  /** 提取 message 行的 role（user/assistant；其他归 user） */
  private extractRole(obj: JsonlLine): MessageRole {
    const msg = obj.message as { role?: unknown } | undefined;
    return msg && msg.role === 'assistant' ? 'assistant' : 'user';
  }

  /**
   * 提取 message 行的可显示文本：
   *   - 非 type:"message" 行 → null
   *   - message.role 非 user/assistant → null
   *   - content 字符串 → 该字符串（去空白后非空才返回）
   *   - content 数组 → 只取 text 块拼接；thinking(思维链)/tool_use/tool_result 排除
   *   - 结果空白 → null
   */
  private extractDisplayText(obj: JsonlLine): string | null {
    if (obj.type !== 'message') return null;
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    if (!message) return null;
    if (message.role !== 'user' && message.role !== 'assistant') return null;

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

  /** 解析 ISO 时间戳为 epoch 毫秒；非法/缺失返回 undefined */
  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }

  // ─── 供 wrapper 使用的静态解析能力（不依赖 store） ───────────────────────

  /**
   * 解析单个 JSONL v3 文件为中性 session（含完整 entry 树），供 wrapper.extractSession /
   * transferSession 使用。文件不可读或无有效消息返回 null。
   */
  static extractSession(
    absPath: string,
    source: string,
  ): PiNeutralSession | null {
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }
    let nativeId: string | undefined;
    let cwd: string | undefined;
    let earliest: number | undefined;
    let model: string | undefined;
    const messages: SessionMessageInput[] = [];
    const entries: PiEntry[] = [];

    const extractModel = (obj: JsonlLine): string | undefined => {
      if (typeof obj.model === 'string' && obj.model.length > 0) return obj.model;
      const provider = typeof obj.provider === 'string' ? obj.provider : undefined;
      const modelId = typeof obj.modelId === 'string' ? obj.modelId : undefined;
      if (modelId) return provider ? `${provider}/${modelId}` : modelId;
      return undefined;
    };

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: JsonlLine;
      try {
        obj = JSON.parse(trimmed) as JsonlLine;
      } catch {
        continue;
      }
      const ts =
        typeof obj.timestamp === 'string' && obj.timestamp.length > 0
          ? (() => {
              const ms = Date.parse(obj.timestamp as string);
              return Number.isNaN(ms) ? undefined : ms;
            })()
          : undefined;
      const entryType = typeof obj.type === 'string' ? obj.type : '';
      const entryId = typeof obj.id === 'string' ? obj.id : null;
      const entryParent = typeof obj.parentId === 'string' ? obj.parentId : null;

      if (entryType && entryType !== 'title') {
        entries.push({ id: entryId, parentId: entryParent, type: entryType, timestamp: ts, raw: obj });
      }
      if (entryType === 'session') {
        if (nativeId === undefined && entryId) nativeId = entryId;
        if (cwd === undefined && typeof obj.cwd === 'string') cwd = obj.cwd;
      }
      if (entryType === 'model_change' && model === undefined) model = extractModel(obj);
      if (ts !== undefined && (earliest === undefined || ts < earliest)) earliest = ts;

      if (entryType === 'message') {
        const msg = obj.message as { role?: string; content?: unknown } | undefined;
        if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
          const content = msg.content;
          let text: string | null = null;
          if (typeof content === 'string') {
            text = content.trim().length > 0 ? content : null;
          } else if (Array.isArray(content)) {
            const parts: string[] = [];
            for (const block of content as ContentBlock[]) {
              if (block && block.type === 'text' && typeof block.text === 'string') {
                parts.push(block.text);
              }
            }
            if (parts.length > 0) {
              const joined = parts.join('\n');
              text = joined.trim().length > 0 ? joined : null;
            }
          }
          if (text !== null) {
            if (model === undefined) {
              const mm = (msg as { model?: unknown }).model;
              if (typeof mm === 'string' && mm.length > 0) model = mm;
            }
            messages.push({
              role: msg.role === 'assistant' ? 'assistant' : 'user',
              content: text,
              timestamp: ts,
            });
          }
        }
      }
    }

    if (messages.length === 0) return null;
    return {
      source,
      nativeId: nativeId && nativeId.length > 0 ? nativeId : absPath,
      cwd,
      startedAt: earliest,
      model,
      entries,
      messages,
      filePath: absPath,
    };
  }
}
