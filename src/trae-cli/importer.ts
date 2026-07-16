/**
 * trae-cli session 导入器（覆盖等级 B）
 *
 * trae-cli（字节跳动 trae-agent，npm 包 trae-agent，v0.1.0）无 Skills / Hooks /
 * Always-on，session 以 trajectory JSON 文件落盘。trajectory 路径由用户 `-t` 指定，
 * 无默认目录（关键限制）。
 *
 * 真实 trajectory JSON 结构（本机实测，trae-agent v0.1.0）：
 *   {
 *     task: "say hi",                       // 初始用户任务（首条 user 消息）
 *     start_time: "2026-07-09T20:57:02.386255",  // ISO（含微秒）
 *     end_time: "...",
 *     provider: "openai",                   // 模型 provider
 *     model: "glm-4.6",                     // 模型名
 *     max_steps: 2,
 *     llm_interactions: [                    // 每轮 LLM 调用
 *       { timestamp, provider, model,
 *         input_messages: [{role, content}], // OpenAI chat 格式
 *         response: {content, role} | {choices:[{message:{content}}]},
 *         tools_available }
 *     ],
 *     agent_steps: [                         // 每个 agent 步骤
 *       { step_number, timestamp, state,
 *         llm_messages: [{role, content}],   // 该步完整对话
 *         llm_response, tool_calls, tool_results, reflection, error }
 *     ],
 *     success: false,
 *     final_result: "...",                   // 最终结果（末条 assistant）
 *     execution_time: 13.79
 *   }
 *
 * 解析策略：
 *   1. task → 首条 user 消息
 *   2. 取首个 llm_interaction 的 input_messages（过滤 user/assistant）作为初始对话
 *   3. 每个 llm_interaction 的 response → assistant 消息（去重）
 *   4. final_result → 末条 assistant 消息（若非空且未重复）
 *   5. 无 llm_interactions 时回退到 agent_steps[].llm_messages + llm_response
 *
 * native id = trajectory 文件 basename（去扩展名），稳定且跨扫描幂等。
 * cwd/projectPath = trajectory 文件所在目录。
 *
 * 与 Trae IDE 的 'trae' source 严格区分：本导入器 source='trae_cli'。
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

/** trajectory 文件常见扩展名 */
const TRAJECTORY_EXTENSIONS = ['.json'];
/** trajectory 文件名常见前缀（启发式：包含 trajectory 视为候选） */
const TRAJECTORY_NAME_HINT = 'trajectory';

/** 默认配置目录（config.yaml 所在，可能不存在） */
const DEFAULT_TRAE_CLI_CONFIG_DIR = path.join(os.homedir(), '.trae-cli');

/** 扫描 searchPaths 时的默认最大深度 */
const DEFAULT_MAX_DEPTH = 4;

/** 导入器选项 */
export interface TraeCliImportOptions {
  /** 显式指定 trajectory JSON 文件路径列表（最精确，优先级最高） */
  trajectoryFiles?: string[];
  /** 待扫描的目录列表（递归查找 trajectory JSON） */
  searchPaths?: string[];
  /** 递归扫描最大深度，默认 4 */
  maxDepth?: number;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface TraeCliImportStats {
  /** 本次 scan_run id */
  scanRunId: number;
  /** trae_cli source instance id */
  sourceInstanceId: string;
  /** 扫描到的 trajectory 文件总数 */
  filesScanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 session 数（无有效消息 / 文件不可读 / 非 trajectory） */
  skipped: number;
}

/** 解析后的 trae-cli trajectory session */
export interface ParsedTrajectory {
  nativeId: string;
  startedAt?: number;
  endedAt?: number;
  model?: string;
  provider?: string;
  task?: string;
  finalResult?: string;
  success?: boolean;
  messages: SessionMessageInput[];
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── JSON 松散访问助手 ─────────────────────────────────────────────────
type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const asArr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

/** 解析 ISO 时间戳（含微秒）为 epoch 毫秒；非法/缺失返回 undefined */
function parseTimestamp(value: unknown): number | undefined {
  const s = asStr(value);
  if (!s) return undefined;
  // 截掉微秒超出毫秒精度的部分（.386255 → .386）
  const normalized = s.replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * 从一个 message 对象提取可显示文本。
 * message.content 可能是：string / [{type,text}] / [{type,input_text|output_text}] / 嵌套对象。
 */
function extractMessageText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content : null;
  }
  const arr = asArr(content);
  if (arr) {
    const parts: string[] = [];
    for (const b of arr) {
      const blk = asObj(b);
      if (!blk) continue;
      const t = asStr(blk.text) ?? asStr(blk.input_text) ?? asStr(blk.output_text);
      if (t) parts.push(t);
    }
    if (parts.length === 0) return null;
    return parts.join('\n');
  }
  return null;
}

/** 从 OpenAI chat 格式的 messages 数组提取 user/assistant 消息 */
function extractChatMessages(messages: unknown): SessionMessageInput[] {
  const arr = asArr(messages);
  if (!arr) return [];
  const out: SessionMessageInput[] = [];
  for (const m of arr) {
    const mo = asObj(m);
    if (!mo) continue;
    const roleRaw = asStr(mo.role);
    const role: MessageRole | null =
      roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : null;
    if (!role) continue; // system / developer / tool 排除
    const text = extractMessageText(mo.content);
    if (!text) continue;
    out.push({ role, content: text });
  }
  return out;
}

/**
 * 从 LLM response 提取 assistant 文本。
 * response 可能形态：
 *   - { content: "..." }                      （trae-agent 简化格式）
 *   - { choices: [{ message: { content } }] }  （OpenAI 格式）
 *   - { content: [{text,type}] }              （block 格式）
 *   - "..."                                    （裸字符串）
 */
function extractResponseText(response: unknown): string | null {
  if (typeof response === 'string') {
    return response.trim().length > 0 ? response : null;
  }
  const o = asObj(response);
  if (!o) return null;
  // OpenAI choices.message.content
  const choices = asArr(o.choices);
  if (choices && choices.length > 0) {
    const msg = asObj(asObj(choices[0])?.message);
    if (msg) {
      const t = extractMessageText(msg.content);
      if (t) return t;
    }
  }
  // 直接 content
  const t = extractMessageText(o.content);
  return t;
}

/**
 * 解析一个 trajectory JSON 对象为结构化 session。
 * 导出以便单元测试直接覆盖解析逻辑（无需真实文件）。
 */
export function parseTrajectory(obj: unknown, nativeId: string): ParsedTrajectory | null {
  const root = asObj(obj);
  if (!root) return null;

  const task = asStr(root.task);
  const model = asStr(root.model);
  const provider = asStr(root.provider);
  const startedAt = parseTimestamp(root.start_time);
  const endedAt = parseTimestamp(root.end_time);
  const success = asBool(root.success);
  const finalResult = asStr(root.final_result);

  const messages: SessionMessageInput[] = [];

  // 1. 首条 user 消息 = task
  if (task) messages.push({ role: 'user', content: task });

  // 2. 从 llm_interactions 重建对话
  const interactions = asArr(root.llm_interactions);
  if (interactions && interactions.length > 0) {
    // 首个 interaction 的 input_messages 是初始对话（含 task 上下文）
    const firstInput = asArr(asObj(interactions[0])?.input_messages);
    if (firstInput) {
      const initMsgs = extractChatMessages(firstInput);
      // 若 initMsgs 已含 task 的 user 消息则不重复插入；否则在 task 之后插入
      const hasTask = task && initMsgs.some((m) => m.role === 'user' && m.content === task);
      if (hasTask) {
        // 用 initMsgs 完整替换（避免重复 task）
        messages.length = 0;
        messages.push(...initMsgs);
      } else {
        messages.push(...initMsgs);
      }
    }
    // 每个 interaction 的 response → assistant 消息（去重：与上一条不同才加）
    for (const it of interactions) {
      const resp = extractResponseText(asObj(it)?.response);
      if (resp) {
        const last = messages[messages.length - 1];
        if (!(last && last.role === 'assistant' && last.content === resp)) {
          messages.push({ role: 'assistant', content: resp });
        }
      }
    }
  } else {
    // 3. 回退：agent_steps[].llm_messages + llm_response
    const steps = asArr(root.agent_steps);
    if (steps) {
      for (const st of steps) {
        const so = asObj(st);
        const llmMsgs = extractChatMessages(so?.llm_messages);
        for (const m of llmMsgs) {
          const last = messages[messages.length - 1];
          if (!(last && last.role === m.role && last.content === m.content)) {
            messages.push(m);
          }
        }
        const resp = extractResponseText(so?.llm_response);
        if (resp) {
          const last = messages[messages.length - 1];
          if (!(last && last.role === 'assistant' && last.content === resp)) {
            messages.push({ role: 'assistant', content: resp });
          }
        }
      }
    }
  }

  // 4. final_result → 末条 assistant（若未重复）
  if (finalResult) {
    const last = messages[messages.length - 1];
    if (!(last && last.role === 'assistant' && last.content === finalResult)) {
      messages.push({ role: 'assistant', content: finalResult });
    }
  }

  return {
    nativeId,
    startedAt,
    endedAt,
    model,
    provider,
    task,
    finalResult,
    success,
    messages,
  };
}

/** 判断文件名是否像 trajectory JSON（启发式） */
function looksLikeTrajectory(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  if (!TRAJECTORY_EXTENSIONS.some((ext) => base.endsWith(ext))) return false;
  return base.includes(TRAJECTORY_NAME_HINT);
}

/** 递归收集 searchPath 下的 trajectory JSON 文件 */
function collectTrajectoryFiles(rootPath: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && looksLikeTrajectory(e.name)) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(rootPath, 0);
  return out;
}

/**
 * trae-cli trajectory 导入器（覆盖等级 B）。
 *
 * 用法：
 *   const importer = new TraeCliImporter(store, {
 *     trajectoryFiles: ['/path/to/trajectory_xxx.json'],
 *   });
 *   const stats = importer.import();
 *
 * 或扫描目录：
 *   new TraeCliImporter(store, { searchPaths: ['/path/to/trajectories'] });
 */
export class TraeCliImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: TraeCliImportOptions = {},
  ) {}

  import(): TraeCliImportStats {
    const deviceId = this.options.deviceId ?? os.hostname();
    const files = this.resolveTrajectoryFiles();

    if (files.length === 0) {
      throw new Error(
        'TraeCliImporter: 未找到任何 trajectory JSON。' +
          'trae-cli 的 trajectory 路径由 -t 指定、无默认目录，' +
          '请通过 trajectoryFiles 指定文件，或通过 searchPaths 指定待扫描目录。',
      );
    }

    // 单一 source instance（coverage B，rootPath=配置目录）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'trae_cli',
      rootPath: DEFAULT_TRAE_CLI_CONFIG_DIR,
      coverage: 'B' as Coverage,
    });
    const runId = this.store.startScanRun({ sourceInstanceId: instance.id, deviceId });

    let filesScanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    try {
      for (const file of files) {
        filesScanned++;
        const parsed = this.parseFile(file);
        if (!parsed || parsed.messages.length === 0) {
          skipped++;
          continue;
        }
        const result = this.store.ingestSession({
          deviceId,
          sourceInstanceId: instance.id,
          nativeSessionId: parsed.nativeId,
          source: 'trae_cli',
          cwd: path.dirname(file),
          projectPath: path.dirname(file),
          startedAt: parsed.startedAt,
          topology: 'root',
          sourceKind: 'B',
          messages: parsed.messages,
          model: parsed.model,
          cliVersion: '0.1.0',
          originator: parsed.provider,
          entrySource: 'cli',
        });
        if (result.created) inserted++;
        else if (result.newRevision) updated++;
        else unchanged++;
      }

      this.store.finishScanRun(runId, {
        status: 'completed',
        sessionsSeen: filesScanned,
        sessionsNew: inserted,
        sessionsUpdated: updated,
      });

      return {
        scanRunId: runId,
        sourceInstanceId: instance.id,
        filesScanned,
        inserted,
        updated,
        unchanged,
        skipped,
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

  /** 解析 trajectoryFiles / searchPaths → 实际待导入文件列表 */
  private resolveTrajectoryFiles(): string[] {
    if (this.options.trajectoryFiles && this.options.trajectoryFiles.length > 0) {
      return this.options.trajectoryFiles.filter((f) => {
        try {
          return fs.statSync(f).isFile();
        } catch {
          return false;
        }
      });
    }
    if (this.options.searchPaths && this.options.searchPaths.length > 0) {
      const maxDepth = this.options.maxDepth ?? DEFAULT_MAX_DEPTH;
      const out: string[] = [];
      for (const root of this.options.searchPaths) {
        try {
          if (fs.statSync(root).isDirectory()) {
            out.push(...collectTrajectoryFiles(root, maxDepth));
          }
        } catch {
          /* 该 searchPath 不可读 → 跳过 */
        }
      }
      return out;
    }
    return [];
  }

  /** 读取并解析单个 trajectory JSON 文件 */
  private parseFile(file: string): ParsedTrajectory | null {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null; // 脏 JSON → 跳过
    }
    const nativeId = path.basename(file, path.extname(file));
    return parseTrajectory(obj, nativeId);
  }
}
