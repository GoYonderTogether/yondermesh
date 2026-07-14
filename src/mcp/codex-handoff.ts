/**
 * MCP 任务接管 handoff 包构造（LOOP-014）
 *
 * 从 codex rollout JSONL 提取富上下文：compacted 摘要、function_call/_output、
 * custom_tool_call（含 update_plan），专为任务接管场景设计。供 MCP 工具
 * get_session_handoff 与 CLI `ymesh handoff` 共享复用，避免重复实现。
 *
 * 当前 server.ts 的 parseCodexMessages 只取 response_item.payload.type==='message'
 * 的 input_text/output_text，剥掉了 handoff 最关键的上下文（compacted 摘要、tool 调用
 * 与结果、update_plan）。本模块补齐这些信息。
 *
 * 设计原则：
 *   - 零外部依赖，纯 node:* + 标准库
 *   - 只读源文件，绝不写入
 *   - 截断防过大（arguments/output 默认 2000 字符）
 *   - compacted 按 window_number 排序，去掉 replacement_history 噪音
 */

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_TAIL_MESSAGES = 30;
const DEFAULT_TRUNCATE = 2000;
const DEFAULT_LIVE_THRESHOLD_MS = 120_000; // 2 分钟内有写入 = LIVE

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** handoff 包里的一条消息（user/assistant/tool_call 各形态） */
export interface HandoffMessage {
  seq: number;
  role: string;
  content: string;
  /** function_call / custom_tool_call 的工具名 */
  name?: string;
  /** function_call / custom_tool_call 的入参（已截断） */
  arguments?: string;
  /** function_call_output / custom_tool_call_output 的输出（已截断） */
  output?: string;
  timestamp?: number;
}

/** codex session 元数据 */
export interface HandoffSessionMeta {
  cwd: string | null;
  topology: 'root' | 'subagent' | null;
  model: string | null;
  cliVersion: string | null;
  originator: string | null;
  entrySource: string | null;
}

/** 单条 compacted 摘要（按 window_number 排序后） */
export interface CompactedSummary {
  window_number: number;
  message: string;
}

/** 完整 handoff 包 */
export interface HandoffPackage {
  session_id: string | null;
  source: 'codex' | 'claude';
  file_path: string;
  session_meta: HandoffSessionMeta;
  compacted_summaries: CompactedSummary[];
  last_user_message: string | null;
  recent_messages: HandoffMessage[];
  task_plan: string | null;
  is_live: boolean;
  last_activity_sec_ago: number;
  message_count: number;
}

export interface BuildHandoffOptions {
  /** 尾部消息条数，默认 30 */
  tailMessages?: number;
  /** arguments 截断长度，默认 2000 */
  truncateArgs?: number;
  /** output 截断长度，默认 2000 */
  truncateOutput?: number;
  /** 判定 LIVE 的阈值毫秒，默认 120000 */
  liveThresholdMs?: number;
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 截断字符串到 maxLen，超出加省略标记 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...[truncated]';
}

/**
 * 判断 user 消息是否为系统注入 preamble（AGENTS.md / user_instructions /
 * environment_context 等 codex 自动注入的内容），handoff 时跳过这些以取真实用户意图。
 */
function isSystemPreamble(text: string): boolean {
  return (
    text.includes('<user_instructions>') ||
    text.includes('<environment_context>') ||
    text.includes('<system_message>') ||
    text.includes('<system-reminder>')
  );
}

/** 递归查找包含 sessionId 的 .jsonl 文件 */
function findSessionFile(dir: string, sessionId: string): string | null {
  if (!existsSync(dir)) return null;
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as typeof entries;
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findSessionFile(full, sessionId);
      if (found) return found;
    } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
      return full;
    }
  }
  return null;
}

/** 在 codex sessions 根下查找 session 文件 */
export function findCodexSessionFile(codexRoot: string, sessionId: string): string | null {
  return findSessionFile(codexRoot, sessionId);
}

/** 在 claude projects 根下查找 session 文件 */
export function findClaudeSessionFile(claudeRoot: string, sessionId: string): string | null {
  return findSessionFile(claudeRoot, sessionId);
}

/** 解析 ISO 时间戳为 epoch ms；非法/缺失返回 undefined */
function parseTs(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

/** 从 thread-origin 元数据中提取 subagent 谱系（兼容 source / thread_source 两种位置） */
function extractSubagentLineage(payload: {
  source?: unknown;
  thread_source?: unknown;
}): { isSubagent: boolean } {
  for (const raw of [payload.source, payload.thread_source]) {
    if (!raw || typeof raw !== 'object') continue;
    const sub = (raw as { subagent?: unknown }).subagent;
    if (!sub || typeof sub !== 'object') continue;
    const spawn = (sub as { thread_spawn?: unknown }).thread_spawn;
    if (spawn && typeof spawn === 'object') return { isSubagent: true };
  }
  return { isSubagent: false };
}

/** 把任意值安全 stringify（用于 tool_call 入参） */
function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// codex 文件解析
// ---------------------------------------------------------------------------

interface CodexParseResult {
  sessionId: string | null;
  meta: HandoffSessionMeta;
  compacted: Array<{ window_number: number; message: string }>;
  messages: HandoffMessage[];
  messageCount: number;
}

/** 解析 codex rollout JSONL，收集 session_meta / compacted / 全量消息事件（含 tool call） */
function parseCodexFile(
  filePath: string,
  truncateArgs: number,
  truncateOutput: number,
): CodexParseResult | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let topology: 'root' | 'subagent' | null = null;
  let model: string | null = null;
  let cliVersion: string | null = null;
  let originator: string | null = null;
  let entrySource: string | null = null;
  let metaApplied = false;

  const compacted: Array<{ window_number: number; message: string }> = [];
  const messages: HandoffMessage[] = [];
  let messageCount = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    // session_meta：首条记录元数据（重发不覆盖，与 codex importer 一致）
    if (obj.type === 'session_meta') {
      const p = (obj.payload as Record<string, unknown> | undefined) ?? {};
      if (!metaApplied) {
        metaApplied = true;
        if (typeof p.id === 'string' && p.id.length > 0) sessionId = p.id;
        if (typeof p.cwd === 'string' && p.cwd.length > 0) cwd = p.cwd;
        if (typeof p.model_provider === 'string') model = p.model_provider;
        if (typeof p.cli_version === 'string') cliVersion = p.cli_version;
        if (typeof p.originator === 'string') originator = p.originator;
        if (typeof p.source === 'string') entrySource = p.source;
        const lineage = extractSubagentLineage(p as { source?: unknown; thread_source?: unknown });
        topology = lineage.isSubagent ? 'subagent' : 'root';
      }
      continue;
    }

    // compacted：post-compact 摘要（replacement_history 是冗余历史，忽略）
    if (obj.type === 'compacted') {
      const p = (obj.payload as Record<string, unknown> | undefined) ?? {};
      const msg = typeof p.message === 'string' ? p.message : '';
      const wn = typeof p.window_number === 'number' ? p.window_number : 0;
      if (msg) compacted.push({ window_number: wn, message: msg });
      continue;
    }

    // response_item：消息 / function_call / function_call_output / custom_tool_call
    if (obj.type === 'response_item') {
      const p = (obj.payload as Record<string, unknown> | undefined) ?? {};
      const ptype = typeof p.type === 'string' ? p.type : '';
      const role = typeof p.role === 'string' ? p.role : '';
      const ts = parseTs(obj.timestamp);

      if (ptype === 'message' && (role === 'user' || role === 'assistant')) {
        const content = p.content;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const parts: string[] = [];
          for (const block of content as Array<Record<string, unknown>>) {
            const bt = typeof block?.type === 'string' ? block.type : '';
            if (bt === 'text' || bt === 'input_text' || bt === 'output_text') {
              if (typeof block?.text === 'string') parts.push(block.text);
            }
          }
          text = parts.join('\n');
        }
        if (text && text.trim().length > 0) {
          messageCount++;
          messages.push({ seq: messages.length, role, content: text, timestamp: ts });
        }
        continue;
      }

      if (ptype === 'function_call') {
        const name = typeof p.name === 'string' ? p.name : '?';
        const args = typeof p.arguments === 'string' ? p.arguments : safeStringify(p.arguments);
        messages.push({
          seq: messages.length,
          role: 'function_call',
          content: '',
          name,
          arguments: truncate(args, truncateArgs),
          timestamp: ts,
        });
        continue;
      }

      if (ptype === 'function_call_output') {
        const out = typeof p.output === 'string' ? p.output : safeStringify(p.output);
        messages.push({
          seq: messages.length,
          role: 'function_call_output',
          content: '',
          output: truncate(out, truncateOutput),
          timestamp: ts,
        });
        continue;
      }

      if (ptype === 'custom_tool_call' || ptype === 'custom_tool_call_output') {
        const name = typeof p.name === 'string' ? p.name : '?';
        // custom_tool_call 用 input（结构化），也兼容 arguments
        const argsRaw = p.input !== undefined ? p.input : p.arguments;
        const argsStr = safeStringify(argsRaw);
        const msg: HandoffMessage = {
          seq: messages.length,
          role: ptype,
          content: '',
          name,
          arguments: truncate(argsStr, truncateArgs),
          timestamp: ts,
        };
        if (ptype === 'custom_tool_call_output') {
          const out = typeof p.output === 'string' ? p.output : safeStringify(p.output);
          msg.output = truncate(out, truncateOutput);
        }
        messages.push(msg);
        continue;
      }

      // reasoning / agent_reasoning / web_search_call 等：handoff 不需要，跳过
    }
  }

  return {
    sessionId,
    meta: { cwd, topology, model, cliVersion, originator, entrySource },
    compacted,
    messages,
    messageCount,
  };
}

// ---------------------------------------------------------------------------
// handoff 包构造
// ---------------------------------------------------------------------------

/** 从尾部 custom_tool_call 中提取 task_plan（update_plan / 含 plan/explanation） */
function extractTaskPlan(messages: HandoffMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'custom_tool_call') continue;
    const name = m.name ?? '';
    const args = m.arguments ?? '';
    if (
      name === 'update_plan' ||
      name.includes('plan') ||
      args.includes('"plan"') ||
      args.includes('"explanation"')
    ) {
      // 尝试解析 JSON 提取 plan/explanation
      try {
        const parsed = JSON.parse(args) as Record<string, unknown>;
        const parts: string[] = [];
        if (typeof parsed.explanation === 'string' && parsed.explanation.length > 0) {
          parts.push(parsed.explanation);
        }
        if (Array.isArray(parsed.plan)) {
          for (const step of parsed.plan) {
            if (typeof step === 'string') {
              parts.push(`- ${step}`);
            } else if (step && typeof step === 'object') {
              const s = step as Record<string, unknown>;
              const stepText =
                typeof s.step === 'string'
                  ? s.step
                  : typeof s.content === 'string'
                    ? s.content
                    : JSON.stringify(s);
              parts.push(`- ${stepText}`);
            }
          }
        }
        if (parts.length > 0) return parts.join('\n');
      } catch {
        // 非 JSON，直接返回原始 args（已截断）
        if (args) return args;
      }
      if (args) return args;
    }
  }
  return null;
}

/** 找最后一条真实 user 消息（跳过系统 preamble 注入） */
function findLastUserMessage(messages: HandoffMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (isSystemPreamble(m.content)) continue;
    return m.content;
  }
  return null;
}

/** 计算文件的 is_live / last_activity_sec_ago */
function computeLiveness(filePath: string, liveThresholdMs: number): {
  isLive: boolean;
  lastActivitySecAgo: number;
} {
  try {
    const stat = statSync(filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    return {
      isLive: ageMs < liveThresholdMs,
      lastActivitySecAgo: Math.round(ageMs / 1000),
    };
  } catch {
    return { isLive: false, lastActivitySecAgo: -1 };
  }
}

/** 从 codex 文件构建 handoff 包；文件不可读返回 null */
export function buildCodexHandoff(
  filePath: string,
  options: BuildHandoffOptions = {},
): HandoffPackage | null {
  const tailMessages = options.tailMessages ?? DEFAULT_TAIL_MESSAGES;
  const truncateArgs = options.truncateArgs ?? DEFAULT_TRUNCATE;
  const truncateOutput = options.truncateOutput ?? DEFAULT_TRUNCATE;
  const liveThresholdMs = options.liveThresholdMs ?? DEFAULT_LIVE_THRESHOLD_MS;

  const parsed = parseCodexFile(filePath, truncateArgs, truncateOutput);
  if (!parsed) return null;

  // compacted 按 window_number 升序排序
  const compactedSummaries = parsed.compacted
    .slice()
    .sort((a, b) => a.window_number - b.window_number)
    .map((c) => ({ window_number: c.window_number, message: c.message }));

  const recentMessages = parsed.messages.slice(-tailMessages);
  const lastUserMessage = findLastUserMessage(parsed.messages);
  const taskPlan = extractTaskPlan(parsed.messages);
  const { isLive, lastActivitySecAgo } = computeLiveness(filePath, liveThresholdMs);

  return {
    session_id: parsed.sessionId,
    source: 'codex',
    file_path: filePath,
    session_meta: parsed.meta,
    compacted_summaries: compactedSummaries,
    last_user_message: lastUserMessage,
    recent_messages: recentMessages,
    task_plan: taskPlan,
    is_live: isLive,
    last_activity_sec_ago: lastActivitySecAgo,
    message_count: parsed.messageCount,
  };
}

// ---------------------------------------------------------------------------
// claude 文件 handoff（简版：无 compacted / 无 tool_call 细化）
// ---------------------------------------------------------------------------

/** 从 claude 文件构建简版 handoff 包；文件不可读返回 null */
export function buildClaudeHandoff(
  filePath: string,
  options: BuildHandoffOptions = {},
): HandoffPackage | null {
  const tailMessages = options.tailMessages ?? DEFAULT_TAIL_MESSAGES;
  const liveThresholdMs = options.liveThresholdMs ?? DEFAULT_LIVE_THRESHOLD_MS;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let sessionId: string | null = null;
  let cwd: string | null = null;
  const messages: HandoffMessage[] = [];
  let messageCount = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!sessionId && typeof obj.sessionId === 'string') sessionId = obj.sessionId;
    if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
    const t = typeof obj.type === 'string' ? obj.type : '';
    if (t === 'user' || t === 'assistant') {
      const msg = obj.message as Record<string, unknown> | undefined;
      const c = msg?.content ?? obj.content;
      let text = '';
      if (typeof c === 'string') {
        text = c;
      } else if (Array.isArray(c)) {
        const parts: string[] = [];
        for (const part of c as Array<Record<string, unknown>>) {
          const pt = typeof part?.type === 'string' ? part.type : '';
          if (pt === 'text' && typeof part?.text === 'string') parts.push(part.text);
          else if (pt === 'tool_use') {
            parts.push(`[tool: ${typeof part?.name === 'string' ? part.name : '?'}]`);
          } else if (pt === 'tool_result') {
            parts.push('[tool_result]');
          }
        }
        text = parts.join(' ');
      }
      if (text) {
        messageCount++;
        messages.push({ seq: messages.length, role: t, content: text });
      }
    }
  }

  const recentMessages = messages.slice(-tailMessages);
  const lastUserMessage = findLastUserMessage(messages);
  const { isLive, lastActivitySecAgo } = computeLiveness(filePath, liveThresholdMs);

  return {
    session_id: sessionId,
    source: 'claude',
    file_path: filePath,
    session_meta: {
      cwd,
      topology: null,
      model: null,
      cliVersion: null,
      originator: null,
      entrySource: null,
    },
    compacted_summaries: [],
    last_user_message: lastUserMessage,
    recent_messages: recentMessages,
    task_plan: null,
    is_live: isLive,
    last_activity_sec_ago: lastActivitySecAgo,
    message_count: messageCount,
  };
}

// ---------------------------------------------------------------------------
// 顶层入口
// ---------------------------------------------------------------------------

/**
 * 根据 session id 查找源文件并构建 handoff 包。
 * 优先 codex（handoff 主目标，含 compacted + tool_call），回退 claude（简版）。
 * 找不到文件返回 null。
 */
export function buildSessionHandoff(
  sessionId: string,
  claudePath: string,
  codexPath: string,
  options: BuildHandoffOptions = {},
): HandoffPackage | null {
  const codexFile = findCodexSessionFile(codexPath, sessionId);
  if (codexFile) return buildCodexHandoff(codexFile, options);

  const claudeFile = findClaudeSessionFile(claudePath, sessionId);
  if (claudeFile) return buildClaudeHandoff(claudeFile, options);

  return null;
}
