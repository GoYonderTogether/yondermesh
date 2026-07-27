/**
 * generator.ts — 复盘数据组装（loop build-retrospective §B）
 *
 * 不变式（loop §3 行动约束）：
 *   - 确定性：纯函数 + 只读 store，无 I/O 副作用（B3）
 *   - 零 LLM：不调用任何 LLM API（ARCHITECTURE §III.6 内核零 LLM）
 *   - 不写文件：仅产出 RetrospectiveFact 结构，由调用方决定输出
 *
 * 输入：{ sessionId, store }
 * 输出：RetrospectiveFact（含 originalNeed / toolCalls / detours /
 *      stuckSegments / sessionMeta / firstUserMessageAt / durationSec）
 *
 * detours 检测：复用 derive/prior-attempts.ts 的 DEFAULT_FAILURE_PATTERNS，
 * 每条消息逐条匹配，命中则记录 { seq, snippet, pattern }。
 *
 * toolCalls 提取：扫描 assistant + tool 消息中的 tool_use / tool_call 形态
 * （Claude 风格 `{"type":"tool_use","name":"X",...}` 与通用 `{"name":"X",...}`）。
 */

import type { SessionStore, SessionMessage, SessionRecord } from '../store/index.js';
import { DEFAULT_FAILURE_PATTERNS } from '../derive/prior-attempts.js';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 单条工具调用记录 */
export interface ToolCallEntry {
  /** 在 messages 数组中的 seq */
  seq: number;
  /** 工具名（如 Read / Bash / Edit） */
  name: string;
}

/** 单条弯路（命中失败模式）记录 */
export interface DetourEntry {
  /** 在 messages 数组中的 seq */
  seq: number;
  /** 命中的消息片段（前 N 字符） */
  snippet: string;
  /** 命中的模式（正则 source 截断） */
  pattern: string;
}

/** session 元数据快照 */
export interface SessionMeta {
  source: string;
  cwd: string | null;
  projectPath: string | null;
  startedAt: number | null;
  lastSeenAt: number;
  messageCount: number;
}

/** 卡住段（v0 不启用，预留字段） */
export interface StuckSegment {
  seq: number;
  reason: string;
  snippet: string;
}

/** 复盘事实层结构（deterministic） */
export interface RetrospectiveFact {
  sessionId: string;
  /** 首条真实 user 消息（剥 task-notification / system-reminder preamble） */
  originalNeed: string;
  /** 工具调用列表（按 seq 升序） */
  toolCalls: ToolCallEntry[];
  /** 工具调用总数 */
  toolCallCount: number;
  /** 命中失败模式的消息片段 */
  detours: DetourEntry[];
  /** 卡住段（v0 未启用，空数组） */
  stuckSegments: StuckSegment[];
  /** session 元数据 */
  sessionMeta: SessionMeta;
  /** 首条 user 消息时间戳（无 user 消息则 undefined） */
  firstUserMessageAt?: number;
  /** session 时长（秒） = (lastSeenAt - startedAt) / 1000 */
  durationSec: number;
}

/** generateRetrospective 入参 */
export interface GenerateRetrospectiveInput {
  sessionId: string;
  store: SessionStore;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** snippet 截断长度 */
const SNIPPET_LEN = 200;

/** pattern source 截断长度（避免长正则噪音） */
const PATTERN_LEN = 120;

/**
 * 工具调用形态正则（覆盖多种 CLI 协议）：
 *   1. Claude 风格：{"type":"tool_use","name":"Read","input":{...}}
 *   2. 通用 JSON：{"name":"Read", ...} （需在 tool / assistant 消息中）
 *   3. OpenAI function_call：function_call 块含 "name":"X"
 *
 * 全局匹配；name 字段取第一个双引号字符串。
 */
const TOOL_USE_RE = /"type"\s*:\s*"tool_use"\s*,\s*"name"\s*:\s*"([^"]+)"/g;
const GENERIC_NAME_RE = /"name"\s*:\s*"([^"]+)"/g;

/**
 * 系统注入 preamble 模式 — 这些内容应从 originalNeed 中剥离：
 *   - <task-notification>...</task-notification> 块
 *   - <system-reminder>...</system-reminder> 块
 *   - <system>...</system> 块
 *
 * 非贪婪匹配；DOTALL 让 . 跨行。
 */
const PREAMBLE_BLOCK_RE =
  /<(?:task-notification|system-reminder|system|context-reminder)>[\s\S]*?<\/(?:task-notification|system-reminder|system|context-reminder)>/g;

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 纯函数：从 store 读取 session + messages，组装 RetrospectiveFact。
 *
 * 不调用 LLM；不写文件；只读 store（B3）。
 * 任何 store 异常向上抛（调用方负责 try/catch + stderr 透传，ARCHITECTURE §III.5）。
 */
export function generateRetrospective(
  input: GenerateRetrospectiveInput,
): RetrospectiveFact {
  const { sessionId, store } = input;

  // 统一 id 解析：允许传入 DB 主键（sha256）、native_session_id 或其唯一前缀。
  // 之前只认主键 → 用户从 `ymesh sessions` 复制到的截断 hash / pi 的 UUID
  // 一律得到「session not found」。
  const resolved = store.resolveSessionId(sessionId) ?? sessionId;
  const session = store.getSession(resolved);
  if (!session) {
    throw new Error(
      `session not found: ${sessionId}\n` +
        `  （已尝试 DB 主键 / native_session_id / 唯一前缀；用 \`ymesh sessions --json\` 查可用 id）`,
    );
  }

  const messages = store.getMessages(resolved);

  return assembleFact(resolved, session, messages);
}

// ---------------------------------------------------------------------------
// 内部纯函数（拆分以便单测）
// ---------------------------------------------------------------------------

/** 组装 RetrospectiveFact（纯函数，无 store 依赖） */
function assembleFact(
  sessionId: string,
  session: SessionRecord,
  messages: ReadonlyArray<SessionMessage>,
): RetrospectiveFact {
  const originalNeed = extractOriginalNeed(messages);
  const firstUserMessageAt = findFirstUserTimestamp(messages);
  const toolCalls = extractToolCalls(messages);
  const detours = detectDetours(messages);
  // trae-ide 等 source 把 tool_call_count 存在 sessions 表（非 message_tool_calls）：
  // 结构化/正则都提取不到时，回退到 session.toolCallCount（loop build-tool-calls-schema §F3）
  const effectiveToolCallCount =
    toolCalls.length > 0
      ? toolCalls.length
      : (session.toolCallCount ?? 0);
  const stuckSegments: StuckSegment[] = []; // v0 不启用
  const durationSec = computeDurationSec(session);

  return {
    sessionId,
    originalNeed,
    toolCalls,
    toolCallCount: effectiveToolCallCount,
    detours,
    stuckSegments,
    sessionMeta: {
      source: session.source,
      cwd: session.cwd,
      projectPath: session.projectPath,
      startedAt: session.startedAt,
      lastSeenAt: session.lastSeenAt,
      messageCount: messages.length,
    },
    firstUserMessageAt,
    durationSec,
  };
}

/**
 * 提取首条「真实」user 消息：
 *   1. 取第一条 role=user 的消息
 *   2. 剥离 <task-notification> / <system-reminder> 等 preamble 块
 *   3. trim 后若为空，继续取下一条 user 消息
 *
 * 无 user 消息则返回空串。
 */
function extractOriginalNeed(messages: ReadonlyArray<SessionMessage>): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const stripped = stripPreamble(m.content).trim();
    if (stripped) return stripped;
  }
  return '';
}

/** 剥离 preamble 块；剥离后若只剩空白，返回空串 */
function stripPreamble(content: string): string {
  if (!content) return '';
  // 快速短路：不含任何 preamble 标签时直接返回
  if (
    content.indexOf('<task-notification>') === -1 &&
    content.indexOf('<system-reminder>') === -1 &&
    content.indexOf('<system>') === -1 &&
    content.indexOf('<context-reminder>') === -1
  ) {
    return content;
  }
  return content.replace(PREAMBLE_BLOCK_RE, '');
}

/** 找首条 user 消息时间戳 */
function findFirstUserTimestamp(
  messages: ReadonlyArray<SessionMessage>,
): number | undefined {
  for (const m of messages) {
    if (m.role === 'user' && typeof m.timestamp === 'number') {
      return m.timestamp;
    }
  }
  return undefined;
}

/**
 * 提取工具调用列表（按 seq 升序）。
 *
 * 优先使用结构化 toolCalls 字段（loop build-tool-calls-schema §E1）：
 *   - 若消息有 m.toolCalls（来自 message_tool_calls 表），直接用其 toolName
 *     填 ToolCallEntry，不再跑正则。
 *   - 若消息无结构化 toolCalls，回退到原正则扫描 content（兼容老数据）。
 *
 * 正则回退扫描 assistant + tool 消息内容，匹配 Claude 风格 tool_use 与通用
 * JSON `{"name":"X"}` 形态。同一条消息内多次出现也分别记录。
 */
function extractToolCalls(messages: ReadonlyArray<SessionMessage>): ToolCallEntry[] {
  const out: ToolCallEntry[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' && m.role !== 'tool') continue;

    // 优先：结构化 toolCalls 字段（loop build-tool-calls-schema §E1）
    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        out.push({ seq: m.seq, name: tc.toolName });
      }
      continue; // 该消息已用结构化数据，不再跑正则
    }

    // 回退：正则扫描 content（兼容无结构化 toolCalls 的老数据）
    const content = m.content ?? '';
    if (!content || content.indexOf('"name"') === -1) continue;

    // 1. Claude 风格 tool_use（优先，避免被通用规则误抓 input.name）
    const toolUseRe = new RegExp(TOOL_USE_RE.source, 'g');
    let m1: RegExpExecArray | null;
    while ((m1 = toolUseRe.exec(content)) !== null) {
      const name = m1[1];
      if (name) out.push({ seq: m.seq, name });
    }

    // 2. 通用 {"name":"X"}（仅在 tool 角色消息中补抓，避免重复抓 assistant
    //    中已被 tool_use 覆盖的 name）。tool 消息通常是工具结果，但部分 CLI
    //    把 tool_call 也写在 tool 角色里。
    if (m.role === 'tool') {
      const genericRe = new RegExp(GENERIC_NAME_RE.source, 'g');
      const seen = new Set<string>();
      let m2: RegExpExecArray | null;
      while ((m2 = genericRe.exec(content)) !== null) {
        const name = m2[1];
        if (name && !seen.has(name)) {
          seen.add(name);
          out.push({ seq: m.seq, name });
        }
      }
    }
  }
  // 按 seq 升序稳定排序
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/**
 * 检测弯路：逐条消息匹配 DEFAULT_FAILURE_PATTERNS，命中则记录。
 *
 * 跳过 user 消息（用户描述失败不算弯路）；assistant / tool / system 都参与。
 */
function detectDetours(messages: ReadonlyArray<SessionMessage>): DetourEntry[] {
  const out: DetourEntry[] = [];
  for (const m of messages) {
    if (m.role === 'user') continue;
    const content = m.content ?? '';
    if (!content) continue;

    for (const re of DEFAULT_FAILURE_PATTERNS) {
      const hit = re.exec(content);
      if (hit) {
        out.push({
          seq: m.seq,
          snippet: content.slice(0, SNIPPET_LEN),
          pattern: re.source.slice(0, PATTERN_LEN),
        });
        // 同一条消息只记录每条 pattern 的第一次命中（避免噪音）
        break;
      }
    }
  }
  return out;
}

/** 计算 session 时长（秒）；缺失字段兜底为 0 */
function computeDurationSec(session: SessionRecord): number {
  const started = session.startedAt;
  const last = session.lastSeenAt;
  if (typeof started !== 'number' || typeof last !== 'number') return 0;
  if (last < started) return 0;
  return Math.max(0, Math.floor((last - started) / 1000));
}
