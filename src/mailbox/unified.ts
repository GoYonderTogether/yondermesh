/**
 * Unified agent_message —— 跨 session 通信的**唯一入口**。
 *
 * 为什么要有这个（2026-09-11 设计）：
 *   收敛前，「跟别的 agent 说话」散在 13 个 MCP 工具里（send / mailbox /
 *   yondermesh_send / yondermesh_mailbox_* / post_message / get_messages /
 *   launch_agent / inject_session / transfer_session …）。对模型来说这是
 *   工具面膨胀 + 语义重叠，选错工具比没工具更糟。
 *
 *   收敛后只有一个动作面：**发消息 / 看消息**，外加一个 **投递时机** 参数。
 *   「邮箱」不再是需要模型主动去轮询的独立东西，而只是同一个工具的一种读法。
 *
 * 投递时机（delivery）：
 *   · now        —— 立刻发（目标必须已停/空闲，走 resume；目标在跑则拒绝，
 *                   因为对运行中的会话外部注入有双写风险）
 *   · after_turn —— **发送方**本轮结束再发；同目标的积压会合并成一条发出
 *   · on_reply   —— **目标**回复完用户那一刻再发，且以用户口吻（不暴露是别的 agent）
 *
 * after_turn / on_reply 只是入队；真正的投递由 daemon 在检测到
 * 「某 session 从 live 变 idle」时统一 flush（见 src/daemon/delivery.ts）。
 *
 * 设计原则：
 *   · 复用既有状态机 —— 入队走 MailboxCore.postMessage，投递走
 *     MailboxCore.send（其内部已有 TriggerAdapter/ReplyAdapter），不重造。
 *   · 自动定位 CLI —— 调用方只说「发给哪个 session」，不用知道它属于哪个 CLI。
 */

import type { MailboxCore } from './core.js';
import type { DeliveryPolicy } from './types.js';
import type { SessionStore } from '../store/index.js';
import { formatSelfSessionFailure } from './core.js';

/** 调用方给的投递时机（人话版） */
export type DeliveryChoice = 'now' | 'after_turn' | 'on_reply';

export interface AgentMessageInput {
  /** send = 发消息；check = 看发给我的消息 */
  action: 'send' | 'check';

  // ── send ──
  /** 目标：session id（DB 主键 / native id / 唯一前缀都行），或 "all" 广播 */
  to?: string;
  /** 消息正文 */
  body?: string;
  /** 投递时机，默认 now */
  delivery?: DeliveryChoice;
  /** 回复某条消息（自动串 thread） */
  replyTo?: number;

  // ── check ──
  /** 最多返回几条，默认 20 */
  limit?: number;
  /** 读完是否标记已读，默认 true */
  markRead?: boolean;
  /** 只看未读，默认 true */
  unreadOnly?: boolean;

  /** 自己的 session id（不传则自动解析） */
  selfSessionId?: string;
}

export interface AgentMessageTarget {
  sessionId: string;
  nativeSessionId: string | null;
  source: string;
  cwd: string | null;
  live: boolean;
}

export interface AgentMessageSendResult {
  ok: boolean;
  action: 'send';
  delivery?: DeliveryChoice | 'queued';
  /** 消息在 agent_messages 里的 id */
  messageId?: number;
  to?: AgentMessageTarget;
  /** now 才可能有：目标的回复 */
  response?: string;
  /** 是否已真正送达（now 成功 / 队列已 flush） */
  delivered: boolean;
  error?: string;
  /** 给模型的下一步建议 */
  hint?: string;
}

export interface AgentMessageCheckResult {
  ok: boolean;
  action: 'check';
  selfSessionId?: string;
  unread?: number;
  total?: number;
  messages?: Array<{
    id: number;
    from: string | null;
    body: string;
    kind: string;
    createdAt: number;
    replyToId: number | null;
    /** 还在队列里（等投递），尚未真正送达 */
    pending?: boolean;
  }>;
  error?: string;
}

export type AgentMessageResult = AgentMessageSendResult | AgentMessageCheckResult;

/** 把 delivery 参数翻成 DB 的 deliver_on 值 */
export function toDeliveryPolicy(choice: DeliveryChoice): DeliveryPolicy | null {
  if (choice === 'after_turn') return 'sender_idle';
  if (choice === 'on_reply') return 'target_idle';
  return null;
}

/** 把 DB 的 deliver_on 翻回人话 */
export function fromDeliveryPolicy(policy: DeliveryPolicy | null): DeliveryChoice {
  if (policy === 'sender_idle') return 'after_turn';
  if (policy === 'target_idle') return 'on_reply';
  return 'now';
}

/**
 * 解析目标 session。接受 DB 主键 / native_session_id / 唯一前缀。
 * 返回 null = 找不到；抛错 = 前缀歧义。
 */
export function resolveTarget(store: SessionStore, to: string): AgentMessageTarget | null {
  const id = store.resolveSessionId(to);
  if (!id) return null;
  const s = store.getSession(id);
  if (!s) return null;
  const live = Date.now() - (s.fileModifiedAt ?? s.lastSeenAt ?? 0) < 120_000;
  return {
    sessionId: s.id,
    nativeSessionId: s.nativeSessionId ?? null,
    source: s.source,
    cwd: s.cwd ?? null,
    live,
  };
}

/**
 * 合并一组待投递消息为一条。
 *
 * 为什么合并：after_turn 的语义是「等本轮结束，把攒的多条一次性发过去」——
 * 分 3 次唤醒目标 agent 会烧 3 倍 token，合并成 1 条只烧 1 次。
 */
export function coalesce(msgs: Array<{ body: string; fromSessionId?: string | null }>): string {
  if (msgs.length === 1) return msgs[0].body;
  return msgs.map((m, i) => `（${i + 1}/${msgs.length}）${m.body}`).join('\n');
}

/**
 * 队列消息真正投出去时用的正文包装。
 *
 * after_turn（agent → agent）：标明来自哪个 session，让对方知道这是同事不是用户。
 * on_reply（agent → 用户口吻）：**不加任何来源标记**——用户要的就是"像用户说的话"
 * 注入进去，让目标 agent 自然地把这当作需求继续做。
 */
export function wrapForDelivery(
  policy: DeliveryPolicy,
  body: string,
  fromSessionId: string | null,
): string {
  if (policy === 'target_idle') return body;
  const from = fromSessionId ? fromSessionId.slice(0, 12) : '未知 session';
  return `[来自另一个 agent 会话 ${from} 的消息]\n${body}`;
}

/**
 * 统一入口。CLI / MCP / daemon 都调这一个函数，不再各写一套。
 */
export async function agentMessage(
  deps: { core: MailboxCore; store: SessionStore },
  input: AgentMessageInput,
): Promise<AgentMessageResult> {
  const { core, store } = deps;

  // ── 看消息 ──────────────────────────────────────────────────────────
  if (input.action === 'check') {
    const diag = core.resolveSelfSessionDetailed({ explicit: input.selfSessionId });
    if (!diag.sid) {
      return { ok: false, action: 'check', error: formatSelfSessionFailure(diag) };
    }
    const unread = core.countUnread(diag.sid);
    const filter = { forSessionId: diag.sid };
    const raw = input.markRead === false ? core.peekMessages(filter) : core.popMessages(filter);
    const limit = input.limit ?? 20;
    const onlyUnread = input.unreadOnly !== false;
    const picked = (onlyUnread ? raw.filter((m) => m.readAt === null) : raw).slice(0, limit);
    return {
      ok: true,
      action: 'check',
      selfSessionId: diag.sid,
      unread: unread.total,
      total: raw.length,
      messages: picked.map((m) => ({
        id: m.id,
        from: m.fromSessionId,
        body: m.body,
        kind: m.kind,
        createdAt: m.createdAt,
        replyToId: m.replyToId,
        pending: m.deliverOn !== null && m.deliveredAt === null,
      })),
    };
  }

  // ── 发消息 ──────────────────────────────────────────────────────────
  const body = (input.body ?? '').trim();
  if (!body) {
    return { ok: false, action: 'send', delivered: false, error: 'body 不能为空' };
  }
  const to = (input.to ?? '').trim();
  if (!to) {
    return {
      ok: false,
      action: 'send',
      delivered: false,
      error: 'to 不能为空',
      hint: '用 list_active / sessions 拿到目标 session id；广播用 to="all"',
    };
  }

  const choice: DeliveryChoice = input.delivery ?? 'now';
  const policy = toDeliveryPolicy(choice);

  // 广播：只能走队列（没有单一投递目标）
  if (to === 'all') {
    if (!policy) {
      return {
        ok: false,
        action: 'send',
        delivered: false,
        error: '广播不支持 delivery=now（没有单一目标可注入）',
        hint: '广播请用 delivery=after_turn 或 on_reply，目标 agent 会在下一轮自己读到',
      };
    }
    const id = core.postMessage({
      toProject: '*',
      fromSessionId: input.selfSessionId,
      body,
      deliverOn: policy,
      replyToId: input.replyTo,
    });
    return {
      ok: true,
      action: 'send',
      delivery: 'queued',
      messageId: id,
      delivered: false,
    };
  }

  // 队列路径：只入队，daemon 稍后 flush。
  // 注意：**不要求目标已入库** —— 允许给一个还没被扫描到的 session 留言
  //（消息先躺着，等它入库/变 idle 时再投）。这也和旧 post_message 行为一致。
  if (policy) {
    let resolved: AgentMessageTarget | null = null;
    try {
      resolved = resolveTarget(store, to);
    } catch {
      resolved = null; // 前缀歧义：按原样字符串入队
    }

    // 发送方身份必须在**入队时**定下来：
    //   sender_idle 的触发条件是「发送方这一轮结束」，from_session_id 为空就永远
    //   匹配不上任何 session —— 消息会静默烂在队列里（实测 6 条协作通知躺了一天）。
    //   所以先自动解析「我是谁」（env → cwd 匹配），解析不到就降级成 target_idle
    //   （等目标空闲再投，保证送达），并把降级明说出来。
    const selfId = input.selfSessionId ?? core.resolveSelfSession({}) ?? undefined;
    let deliverOn: DeliveryPolicy = policy;
    let degraded = false;
    if (policy === 'sender_idle' && !selfId) {
      deliverOn = 'target_idle';
      degraded = true;
    }

    const id = core.postMessage({
      toSessionId: resolved?.sessionId ?? to,
      fromSessionId: selfId,
      body,
      deliverOn,
      replyToId: input.replyTo,
    });
    return {
      ok: true,
      action: 'send',
      delivery: choice,
      messageId: id,
      to: resolved ?? undefined,
      delivered: false,
      hint: degraded
        ? '⚠️ 没能识别出你属于哪个 session（env/cwd 都对不上），已改为「等目标空闲再投」以保证送达。' +
          '想要 after_turn 语义请显式传 self_session_id。'
        : choice === 'after_turn'
          ? '已排队：等你这一轮结束、daemon 把它投给目标（同目标的积压会合并成一条）'
          : '已排队：等目标回复完用户那一刻投给它，且以用户口吻（不暴露是你发的）',
    };
  }

  // 立即投递：必须先解析出目标（要知道它是哪个 CLI 才能投）
  let target: AgentMessageTarget | null;
  try {
    target = resolveTarget(store, to);
  } catch (err) {
    return {
      ok: false,
      action: 'send',
      delivered: false,
      error: String(err instanceof Error ? err.message : err),
    };
  }
  if (!target) {
    return {
      ok: false,
      action: 'send',
      delivered: false,
      error: `找不到 session: ${to}`,
      hint: 'delivery=now 必须能定位到目标 CLI；想给还没入库的 session 留言请用 after_turn / on_reply',
    };
  }

  // 立即发：目标是"在跑"的会话时拒绝——外部进程注入会与正在跑的进程双写。
  // 这正是 on_reply 存在的意义：安全地对活跃会话说话。
  if (target.live) {
    return {
      ok: false,
      action: 'send',
      delivered: false,
      to: target,
      error: `目标 session 正在运行（${target.source}）。外部直接注入会与它自己的进程双写，可能损坏会话，已拒绝。`,
      hint: '改用 delivery="on_reply"（等它这一轮回复完再投，安全）或 delivery="after_turn"',
    };
  }

  const res = await core.send({
    cli: target.source,
    sessionId: target.nativeSessionId ?? target.sessionId,
    mode: 'stopped',
    message: body,
    cwd: target.cwd ?? undefined,
    fromSessionId: input.selfSessionId,
  });

  return {
    ok: res.delivered,
    action: 'send',
    delivery: 'now',
    to: target,
    delivered: res.delivered,
    messageId: res.messageId,
    response: res.response,
    error: res.error ?? undefined,
  };
}
