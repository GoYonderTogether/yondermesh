/**
 * OpenHands 原生 adapter（覆盖等级 A）
 *
 * OpenHands 已从 CLI 转型为 HTTP 服务器架构（FastAPI + uvicorn，99 endpoints + WebSocket），
 * 新 CLI 为 agent-server。Session 存储为每事件一文件：
 *   <workspace>/conversations/<conv_id>/events/event-*.json
 *
 * 本导入器只读扫描 workspace 下的 conversations，解析事件文件并入库。
 *
 * 核心约束：
 *   - 只读：绝不写入 OpenHands 私有 session 文件（架构 §2 关键取舍）。
 *   - 身份（§3.1）：device_id + source_instance_id + native_session_id
 *       · native id = conv_id（conversations/<conv_id> 目录名），缺失回退相对路径
 *   - 覆盖等级 A：原生 adapter，可直接用于原生恢复。
 *   - 事件文件为单个 JSON 对象（非 JSONL），每文件一事件。
 *   - 消息：只取 user/agent 的可显示文本（message.content 的 text 块）；
 *     排除 thinking、tool_call、observation 等内部事件。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定；脏文件跳过，无有效消息的 conv 跳过。
 *
 * GLM-5.2 ✅：OpenHands 支持 `anthropic/glm-5.2` 前缀（通过 LLM provider 配置）。
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

/** 默认 OpenHands workspace 目录（HOME 下的 .openhands/workspace，可被环境变量覆盖） */
const DEFAULT_OPENHANDS_WORKSPACE = path.join(os.homedir(), '.openhands', 'workspace');

/** conversations 目录段名 */
const CONVERSATIONS_SEGMENT = 'conversations';
/** events 目录段名 */
const EVENTS_SEGMENT = 'events';
/** 事件文件名前缀 */
const EVENT_FILENAME_PREFIX = 'event-';

/** 导入器选项 */
export interface OpenHandsImportOptions {
  /** 直接指定 OpenHands workspace 根目录，默认 ~/.openhands/workspace 或 OPENHANDS_WORKSPACE */
  workspacePath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface OpenHandsImportStats {
  /** 本次 scan_run id */
  scanRunId: number;
  /** openhands source instance id */
  sourceInstanceId: string;
  /** 扫描到的 conversation 总数 */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 conversation 数（无消息 / 脏数据） */
  skipped: number;
}

/** 单个事件文件的松散结构 */
type EventObject = Record<string, unknown>;

/** message.content 块的松散结构 */
interface ContentBlock {
  type?: string;
  text?: string;
}

/** 一个 conversation 的解析结果 */
interface ParsedConversation {
  /** native session id（conv_id 目录名） */
  nativeId: string;
  /** workspace 路径（来自事件元数据，若有） */
  cwd?: string;
  /** 最早事件时间戳 */
  startedAt?: number;
  messages: SessionMessageInput[];
  /** 元数据 */
  model?: string;
  cliVersion?: string;
}

/** 解析 OpenHands workspace 路径：选项优先 > 环境变量 > 默认路径 */
export function resolveOpenHandsWorkspace(options: { workspacePath?: string } = {}): string {
  if (options.workspacePath) return options.workspacePath;
  return process.env.OPENHANDS_WORKSPACE ?? DEFAULT_OPENHANDS_WORKSPACE;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * OpenHands 原生导入器。
 *
 * 用法：
 *   const importer = new OpenHandsImporter(store, { workspacePath, deviceId });
 *   const stats = importer.import();
 */
export class OpenHandsImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: OpenHandsImportOptions = {},
  ) {}

  /** 执行一次完整扫描，返回统计并写 scan_runs */
  import(): OpenHandsImportStats {
    const workspacePath = resolveOpenHandsWorkspace(this.options);
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. workspace 必须可读目录；不存在时给明确错误（不写 scan_run，避免遗留 running）
    const conversationsDir = path.join(workspacePath, CONVERSATIONS_SEGMENT);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(conversationsDir);
    } catch (e) {
      throw new Error(
        `OpenHands conversations 目录不可读: ${conversationsDir} (${errorMessage(e)})`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`OpenHands conversations 路径不是目录: ${conversationsDir}`);
    }

    // 2. 注册 coverage=A 的 openhands source instance
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'openhands',
      rootPath: workspacePath,
      coverage: 'A' as Coverage,
    });

    // 3. 开始 scan_run
    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.scanConversations(conversationsDir, instance.id, deviceId);
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
      /* scan_run 记录写入失败不应掩盖原始错误 */
    }
  }

  /** 扫描 conversations 目录下所有 conv_id 目录 */
  private scanConversations(
    conversationsDir: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<OpenHandsImportStats, 'scanRunId' | 'sourceInstanceId'> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(conversationsDir, { withFileTypes: true });
    } catch {
      return { scanned: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
    }

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      scanned++;
      const convId = entry.name;
      const eventsDir = path.join(conversationsDir, convId, EVENTS_SEGMENT);
      const parsed = this.parseConversation(convId, eventsDir);
      if (!parsed) {
        skipped++;
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.nativeId,
        source: 'openhands',
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

  /** 解析单个 conversation 的所有事件文件 */
  private parseConversation(convId: string, eventsDir: string): ParsedConversation | null {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(eventsDir, { withFileTypes: true });
    } catch {
      return null; // events 目录不可读 → 跳过
    }

    const eventFiles = entries
      .filter((e) => e.isFile() && e.name.startsWith(EVENT_FILENAME_PREFIX) && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort(); // 稳定字典序，保证事件时序确定

    if (eventFiles.length === 0) return null;

    const messages: SessionMessageInput[] = [];
    let cwd: string | undefined;
    let earliest: number | undefined;
    let model: string | undefined;
    let cliVersion: string | undefined;

    for (const fname of eventFiles) {
      const abs = path.join(eventsDir, fname);
      let raw: string;
      try {
        raw = fs.readFileSync(abs, 'utf8');
      } catch {
        continue; // 文件不可读 → 跳过该事件
      }
      let obj: EventObject;
      try {
        obj = JSON.parse(raw) as EventObject;
      } catch {
        continue; // 脏文件跳过
      }

      // 采集元数据（首个有效值）
      if (cwd === undefined) {
        const ws = obj.workspace;
        if (typeof ws === 'string' && ws.length > 0) cwd = ws;
        // OpenHands 事件常含 repo.metadata（cwd 在其中）
        const repo = obj.repository as Record<string, unknown> | undefined;
        if (repo && typeof repo.cwd === 'string') cwd = repo.cwd;
      }
      if (model === undefined) {
        const llm = obj.llm_metadata as Record<string, unknown> | undefined;
        if (llm && typeof llm.model_name === 'string') model = llm.model_name;
      }
      if (cliVersion === undefined && typeof obj.api_version === 'string') {
        cliVersion = obj.api_version;
      }

      const ts = this.parseTimestamp(obj.timestamp);
      if (ts !== undefined && (earliest === undefined || ts < earliest)) {
        earliest = ts;
      }

      // 提取可显示文本
      const text = this.extractDisplayText(obj);
      if (text !== null) {
        const role = this.eventRole(obj);
        messages.push({ role, content: text, timestamp: ts });
      }
    }

    if (messages.length === 0) return null;

    return { nativeId: convId, cwd, startedAt: earliest, messages, model, cliVersion };
  }

  /**
   * 提取事件的可显示文本：
   *   - source 非 user/agent → null（environment/observer 等内部事件排除）
   *   - message.content 为字符串 → 该字符串
   *   - message.content 为数组 → 只取 text 块拼接；thinking/tool_use/observation 排除
   *   - 结果空白 → null
   *
   * OpenHands 事件形态（实测/文档）：
   *   - source='user'：含 message.content（用户输入）
   *   - source='agent'：含 message.content（assistant 回复，可能含 text + thinking 块）
   *   - source='environment'：observation，排除
   *   - 顶层 type: MessageAction / ObservationAction / AgentStateChangedAction 等
   */
  private extractDisplayText(obj: EventObject): string | null {
    const src = typeof obj.source === 'string' ? obj.source : '';
    // 只取 user / agent 的可显示消息
    if (src !== 'user' && src !== 'agent') return null;

    // 兼容 type=MessageAction 的形态
    const t = typeof obj.type === 'string' ? obj.type : '';
    if (t !== '' && t !== 'MessageAction' && t !== 'message') {
      // AgentStateChangedAction / ObservationAction 等非消息事件排除
      if (t !== 'UserAction' && t !== 'AssistantAction') return null;
    }

    const message = obj.message as { content?: unknown } | undefined;
    if (!message) {
      // 部分事件把文本直接放 obj.content / obj.args.content
      const directContent = obj.content;
      if (typeof directContent === 'string' && directContent.trim().length > 0) {
        return directContent;
      }
      return null;
    }
    const content = message.content;
    if (typeof content === 'string') {
      return content.trim().length > 0 ? content : null;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content as ContentBlock[]) {
        // 仅 text 块为可显示；thinking(思维链)/tool_use/observation 排除
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

  /** 把事件 source 映射为 yondermesh MessageRole */
  private eventRole(obj: EventObject): MessageRole {
    const src = typeof obj.source === 'string' ? obj.source : '';
    return src === 'agent' ? 'assistant' : 'user';
  }

  /** 解析 ISO 时间戳为 epoch 毫秒；非法/缺失返回 undefined */
  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    // 兼容 ISO 与 epoch 两种形态
    if (/^\d+$/.test(value)) {
      const n = Number(value);
      // 10 位秒级 → 毫秒；13 位毫秒级原样
      return n > 1e12 ? n : n * 1000;
    }
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
}
