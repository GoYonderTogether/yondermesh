/**
 * 卡住检测 — L4 派生层第一块
 *
 * 完全 deterministic，零 LLM（ARCHITECTURE §III.6「内核零 LLM」）。
 * 供 orchestrate / 诊断等下游消费。
 *
 * 判定口径（默认，可配）：
 *   - stale：距上次活动 ≥ staleHours（默认 2 小时）
 *   - assistant 结尾：最后一条消息 role === 'assistant'
 *     （含义：assistant 已发言但无后续 user/tool_result 跟进，session 处于“等待”态）
 *   - 默认 stuck = stale AND assistant_ending
 *
 * 时间取值优先级：fileModifiedAt（文件 mtime，更接近真实活动）→ lastSeenAt。
 *
 * 对应 roadmap T2.4.2。
 */

import type { MessageRole } from '../store/types.js';

/** 卡住检测的输入项（字段为 SessionRecord 的子集 + 可选 lastMessage） */
export interface StuckSessionInput {
  id: string;
  source?: string;
  cwd?: string | null;
  projectPath?: string | null;
  /** 最近活动时间戳（ms） */
  lastSeenAt: number;
  /** session 文件 mtime（ms）；存在时优先作为“上次活动” */
  fileModifiedAt?: number | null;
  /** 最后一条消息；缺失时只用时间判定（requireAssistantEnding 须为 false 才可能命中） */
  lastMessage?: { role: MessageRole; content: string } | null;
}

/** 卡住检测可配参数；阈值常量化便于下游覆盖 */
export interface StuckOptions {
  /** 超过此小时数无更新视为 stale。默认 DEFAULT_STUCK_STALE_HOURS（2）。 */
  staleHours?: number;
  /** 当前时间戳（ms）；测试注入。默认 Date.now()。 */
  now?: number;
  /** 是否要求最后一条消息是 assistant 才算卡住。默认 true。
   *  false 时仅按时间判定（stale 即 stuck）。 */
  requireAssistantEnding?: boolean;
}

/** 卡住原因标签 */
export type StuckReason = 'stale' | 'assistant_ending';

/** 单个卡住 session 的判定结果 */
export interface StuckResult {
  sessionId: string;
  source?: string;
  cwd?: string | null;
  projectPath?: string | null;
  /** 命中的原因集合（至少一个） */
  reasons: StuckReason[];
  /** 判定用的“上次活动”时间戳（ms） */
  lastSeenAt: number;
  /** 距上次活动的小时数 */
  hoursSinceUpdate: number;
  /** 最后一条消息的 role + 内容预览（前 100 字符）；无消息时为 null */
  lastMessage: { role: MessageRole; contentPreview: string } | null;
}

/** 默认 stale 阈值：2 小时无更新视为 stale */
export const DEFAULT_STUCK_STALE_HOURS = 2;

/**
 * 纯函数：判定哪些 session 卡住。
 *
 * @param sessions 待判定的 session 列表（字段见 StuckSessionInput）
 * @param opts 阈值与判定开关
 * @returns 被判定为“卡住”的 session 列表（按输入顺序）
 */
export function detectStuckSessions(
  sessions: readonly StuckSessionInput[],
  opts: StuckOptions = {},
): StuckResult[] {
  const staleHours = opts.staleHours ?? DEFAULT_STUCK_STALE_HOURS;
  const now = opts.now ?? Date.now();
  const requireEnding = opts.requireAssistantEnding ?? true;

  const results: StuckResult[] = [];
  for (const s of sessions) {
    // 时间取值优先级：fileModifiedAt → lastSeenAt
    const lastUpdate = s.fileModifiedAt ?? s.lastSeenAt;
    const hoursSince = (now - lastUpdate) / 3_600_000;
    // 边界：刚好 staleHours 处判定为 stale（>=）
    const isStale = hoursSince >= staleHours;

    const lastMsg = s.lastMessage ?? null;
    const isAssistantEnding = !!lastMsg && lastMsg.role === 'assistant';

    const reasons: StuckReason[] = [];
    if (isStale) reasons.push('stale');
    if (isAssistantEnding) reasons.push('assistant_ending');

    const stuck = requireEnding ? (isStale && isAssistantEnding) : isStale;
    if (!stuck) continue;

    results.push({
      sessionId: s.id,
      source: s.source,
      cwd: s.cwd,
      projectPath: s.projectPath,
      reasons,
      lastSeenAt: lastUpdate,
      hoursSinceUpdate: round2(hoursSince),
      lastMessage: lastMsg
        ? { role: lastMsg.role, contentPreview: lastMsg.content.slice(0, 100) }
        : null,
    });
  }
  return results;
}

/** 保留 2 位小数，避免浮点噪音 */
function round2(n: number): number {
  return Number(n.toFixed(2));
}
