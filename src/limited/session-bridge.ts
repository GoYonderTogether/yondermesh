/**
 * Session Bridge —— 有限 agent 的 session 转交桥接器
 *
 * 四个「能力有限」agent（Aider / Amp / ChatGPT Desktop / trae-cli）各自格式迥异：
 *   - Aider：per-project markdown（.aider.chat.history.md）
 *   - Amp：云端 JSON（amp threads export，v5 schema）
 *   - ChatGPT Desktop：SaaS only，本机无 session（C 级，无可转交数据）
 *   - trae-cli：trajectory JSON（llm_interactions / agent_steps）
 *
 * 本桥接器把任意一种格式归一化为「中性 JSONL」，每行一条消息：
 *   { "role", "content", "tool_calls", "timestamp", "model" }
 *
 * 中性 JSONL 可直接喂给能力更强的 agent（Hermes / OpenCode / Pi / Codex 等）继续执行，
 * 也可反过来把前序 session 作为 `--message` 注入 Aider（一次性）或 trajectory 注入 trae-cli。
 *
 * 核心方法：
 *   - toNeutralMessages(sourceCli, sessionData) → NeutralMessage[]   归一化
 *   - toNeutralJsonl(sourceCli, sessionData)    → string              JSONL 文本
 *   - convertSession(sourceCli, sessionData, targetCli) → string      按目标格式输出
 */

import type { SessionMessageInput } from '../store/types.js';
import { parseAiderMarkdown } from '../aider/importer.js';
import { parseAmpExport } from '../amp/importer.js';
import { parseTrajectory } from '../trae-cli/importer.js';

/** 支持的「有限」source CLI 名（canonical，与 source-aliases 对齐） */
export type LimitedSourceCli = 'aider' | 'amp' | 'chatgpt' | 'trae_cli';

/** 中性消息格式 */
export interface NeutralMessage {
  /** 消息角色（仅 user/assistant/system/tool 四种） */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 消息文本内容 */
  content: string;
  /** 工具调用（有限 agent 多数无结构化 tool_calls，故可选；Amp/trae-cli 可能有） */
  tool_calls?: unknown[];
  /** 时间戳（epoch ms，可选） */
  timestamp?: number;
  /** 模型名（来自 session 元数据，可选） */
  model?: string;
}

/** Session 数据的宽松输入类型：结构化对象 / 原始 JSON 字符串 / Aider markdown 字符串 */
export type SessionData =
  | { messages?: unknown; model?: string } & Record<string, unknown>
  | string;

// ─── JSON 松散访问助手 ─────────────────────────────────────────────────
type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const asArr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

/** 从一个松散 message 对象提取 role/content/timestamp */
function normalizeOneMessage(m: unknown, fallbackModel?: string): NeutralMessage | null {
  const mo = asObj(m);
  if (!mo) return null;
  const roleRaw = asStr(mo.role);
  let role: NeutralMessage['role'] | null = null;
  if (roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'tool') {
    role = roleRaw;
  } else if (roleRaw === 'agent') {
    role = 'assistant'; // cass / 部分 agent 用 'agent' 表示 assistant
  }
  if (!role) return null;
  // content 可能是 string 或 [{text,type}]
  let content: string | null = null;
  if (typeof mo.content === 'string') {
    content = mo.content;
  } else {
    const arr = asArr(mo.content);
    if (arr) {
      const parts: string[] = [];
      for (const b of arr) {
        const blk = asObj(b);
        if (blk) {
          const t = asStr(blk.text) ?? asStr(blk.input_text) ?? asStr(blk.output_text);
          if (t) parts.push(t);
        }
      }
      content = parts.length > 0 ? parts.join('\n') : null;
    }
  }
  if (!content || content.trim().length === 0) return null;
  const ts = asNum(mo.timestamp) ?? asNum(asObj(mo.meta)?.sentAt);
  const model = asStr(mo.model) ?? fallbackModel;
  const toolCalls = asArr(mo.tool_calls) ?? undefined;
  const out: NeutralMessage = { role, content };
  if (ts !== undefined) out.timestamp = ts;
  if (model) out.model = model;
  if (toolCalls) out.tool_calls = toolCalls;
  return out;
}

/** 把 SessionMessageInput[]（store 内部格式）直接映射为 NeutralMessage[] */
function fromSessionMessages(msgs: SessionMessageInput[], model?: string): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  for (const m of msgs) {
    if (!m.content || m.content.trim().length === 0) continue;
    const nm: NeutralMessage = { role: m.role, content: m.content };
    if (m.timestamp !== undefined) nm.timestamp = m.timestamp;
    if (model) nm.model = model;
    out.push(nm);
  }
  return out;
}

/**
 * 把任意 source 的 session 数据归一化为中性消息列表。
 *
 * 已识别的 sourceCli 走专用解析器：
 *   - 'aider'     → 若为字符串按 markdown 解析（取所有 session 拼接）；若为对象取 .messages
 *   - 'amp'        → parseAmpExport（v5 JSON）；若已是 {messages} 直接取
 *   - 'trae_cli'   → parseTrajectory（trajectory JSON）
 *   - 'chatgpt'    → 恒空（SaaS 无可提取 session）
 *
 * 未识别的 sourceCli 走通用回退：对象取 .messages（OpenAI chat 格式）；字符串尝试 JSON.parse。
 */
export function toNeutralMessages(
  sourceCli: string,
  sessionData: SessionData,
): NeutralMessage[] {
  const src = sourceCli.toLowerCase();

  // 字符串输入
  if (typeof sessionData === 'string') {
    if (src === 'aider') {
      // Aider markdown 字符串：解析所有 session 块的消息拼接
      const sessions = parseAiderMarkdown(sessionData);
      const out: NeutralMessage[] = [];
      for (const s of sessions) {
        out.push(...fromSessionMessages(s.messages, s.model));
      }
      return out;
    }
    // 尝试作为 JSON 解析后递归
    try {
      const obj = JSON.parse(sessionData);
      return toNeutralMessages(sourceCli, obj as SessionData);
    } catch {
      // 非 JSON 的裸字符串 → 视为单条 user 消息
      return [{ role: 'user', content: sessionData }];
    }
  }

  // 对象输入
  const obj = asObj(sessionData);
  if (!obj) return [];

  if (src === 'amp') {
    const parsed = parseAmpExport(obj);
    if (parsed) return fromSessionMessages(parsed.messages);
    // 兜底：对象自带 messages（已是 amp 结构子集）
  }
  if (src === 'trae_cli') {
    const parsed = parseTrajectory(obj, asStr(obj.id) ?? 'trajectory');
    if (parsed) return fromSessionMessages(parsed.messages, parsed.model);
  }
  if (src === 'chatgpt') {
    return []; // SaaS only，无可提取
  }

  // 通用：对象自带 messages 数组（OpenAI chat 格式 / store 内部格式）
  const msgs = asArr(obj.messages);
  if (msgs) {
    const model = asStr(obj.model);
    const out: NeutralMessage[] = [];
    for (const m of msgs) {
      const nm = normalizeOneMessage(m, model);
      if (nm) out.push(nm);
    }
    return out;
  }

  // aider 对象（ParsedAiderSession）有 messages 字段，已被上面覆盖；
  // 若对象是单个 ParsedAiderSession（无 source 区分），也兜底取 messages
  return [];
}

/** 把中性消息列表序列化为 JSONL 文本（每行一条 JSON，末尾换行） */
export function toNeutralJsonl(
  sourceCli: string,
  sessionData: SessionData,
): string {
  const msgs = toNeutralMessages(sourceCli, sessionData);
  if (msgs.length === 0) return '';
  return msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
}

/**
 * 解析 JSONL 文本回中性消息列表（与 toNeutralJsonl 互逆，便于目标侧读取）。
 */
export function parseNeutralJsonl(jsonl: string): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const nm = normalizeOneMessage(JSON.parse(trimmed));
      if (nm) out.push(nm);
    } catch {
      /* 脏行跳过 */
    }
  }
  return out;
}

/**
 * 把前序 session 构造为「转交提示词」——供目标 agent 理解这是接力上下文。
 * 拼接为：preamble + 每条消息（role: content）。
 */
export function buildHandoffPrompt(
  messages: NeutralMessage[],
  opts: { sourceCli?: string; task?: string } = {},
): string {
  const lines: string[] = [];
  lines.push('# Session Handoff');
  if (opts.sourceCli) lines.push(`Source: ${opts.sourceCli}`);
  if (opts.task) lines.push(`Task: ${opts.task}`);
  lines.push('');
  lines.push('Below is the prior conversation. Continue from here:');
  lines.push('');
  for (const m of messages) {
    lines.push(`## ${m.role}`);
    lines.push(m.content);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

/**
 * 核心转交方法：把 sourceCli 的 sessionData 转换为目标 targetCli 可消费的格式。
 *
 * 输出格式：
 *   - targetCli === 'aider'：返回单条 handoff 提示词字符串（喂给 `aider --message`）；
 *     Aider 无 JSONL 摄入能力，只能一次性 --message。
 *   - targetCli === 'amp'：返回 handoff 提示词（喂给 `amp threads new --message`）。
 *   - 其它（hermes / opencode / pi / codex / trae_cli / 默认）：返回中性 JSONL，
 *     这些 agent 可直接消费 JSONL 消息列表。
 *
 * 返回值即「可直接喂给目标 CLI 的文本」。
 */
export function convertSession(
  sourceCli: string,
  sessionData: SessionData,
  targetCli: string,
): string {
  const messages = toNeutralMessages(sourceCli, sessionData);
  const target = targetCli.toLowerCase();

  // Aider / Amp 只能一次性 --message，无法逐条摄入 → 拼成 handoff 提示词
  if (target === 'aider' || target === 'amp') {
    return buildHandoffPrompt(messages, { sourceCli });
  }

  // ChatGPT Desktop 不可写入（SaaS）→ 返回 handoff 提示词供人工粘贴
  if (target === 'chatgpt') {
    return buildHandoffPrompt(messages, { sourceCli });
  }

  // Hermes / OpenCode / Pi / Codex / trae_cli 等 → 中性 JSONL
  return messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length > 0 ? '\n' : '');
}
