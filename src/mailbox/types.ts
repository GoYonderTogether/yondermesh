/**
 * Mailbox 类型定义
 *
 * 消息总线核心数据结构。被 CLI / MCP / daemon 三个交互层共用，
 * 确保存储与分发逻辑只有一份实现（src/mailbox/core.ts）。
 */

/** 消息类型 */
export type MailKind = 'info' | 'warning' | 'question' | 'task_update';

/** 优先级 */
export type MailPriority = 'low' | 'normal' | 'high' | 'urgent';

/** 合法的 kind 列表 */
export const MAIL_KINDS: readonly MailKind[] = ['info', 'warning', 'question', 'task_update'] as const;

/** 合法的 priority 列表 */
export const MAIL_PRIORITIES: readonly MailPriority[] = ['low', 'normal', 'high', 'urgent'] as const;

/** 投递消息入参 */
export interface PostMessageInput {
  /** 目标 session id（直投）。与 toProject 至少一个非空 */
  toSessionId?: string;
  /** 目标项目（广播给该项目下所有 session）。与 toSessionId 至少一个非空 */
  toProject?: string;
  /** 发送方 session id（可空，匿名消息） */
  fromSessionId?: string;
  /** 消息体 */
  body: string;
  /** 消息类型，默认 info */
  kind?: MailKind;
  /** 优先级，默认 normal */
  priority?: MailPriority;
  /** 过期时间戳（ms），过期消息会被 cleanupExpired 删除 */
  expiresAt?: number;
  /** 线程 id（用于将消息分组到一个会话中） */
  threadId?: string;
  /** 回复的消息 id（自动派生 threadId 若未提供） */
  replyToId?: number;
}

/** 持久化的消息记录 */
export interface MailboxMessage {
  id: number;
  toSessionId: string | null;
  toProject: string | null;
  fromSessionId: string | null;
  body: string;
  kind: MailKind;
  priority: MailPriority;
  createdAt: number;
  readAt: number | null;
  expiresAt: number | null;
  threadId: string | null;
  replyToId: number | null;
}

/** 查询消息的过滤条件 */
export interface MessageFilter {
  /** 收件人 session id（直投消息） */
  forSessionId?: string;
  /** 收件人项目（广播消息） */
  forProject?: string;
  /** 起始时间（ms） */
  sinceMs?: number;
  /** 截止时间（ms） */
  untilMs?: number;
  /** 仅未读 */
  unreadOnly?: boolean;
  /** 线程 id 过滤 */
  threadId?: string;
  /** 优先级过滤 */
  priority?: MailPriority;
  /** 返回条数上限，默认 50 */
  limit?: number;
}

/** 标记已读的入参 */
export interface MarkReadInput {
  /** 单条消息 id（与 allForSession 二选一） */
  id?: number;
  /** 标记该 session 的全部未读为已读 */
  allForSession?: string;
  /** 标记该项目下的全部未读为已读 */
  allForProject?: string;
}

/** 未读消息计数 */
export interface UnreadCount {
  /** 直投给该 session 的未读数 */
  direct: number;
  /** 广播给该 session 所属项目的未读数 */
  broadcast: number;
  /** 总未读数 = direct + broadcast */
  total: number;
}

/** tray 文件通知（daemon 写入，mailbox_check 消费） */
export interface TrayNotice {
  /** 收件人 session id */
  sessionId: string;
  /** 触发通知的消息 id */
  messageIds: number[];
  /** 通知写入时间戳 */
  notifiedAt: number;
}

/**
 * Mailbox Notifier 接口
 *
 * daemon 实现这个接口并调用 `MailboxCore.registerNotifier()` 注册。
 * 注册后，每次 postMessage 都会触发 notifier.notifyNewMessage()，
 * 由 daemon 决定如何推送（写 tray 文件 / 触发 hook / 调用其他通道）。
 *
 * daemon 未上线时，notifier 为 no-op（polling 模式：每次 MCP 调用直查 DB）。
 */
export interface MailboxNotifier {
  /** 新消息投递时回调 */
  notifyNewMessage(message: MailboxMessage): void;
  /** 消息被标记已读时回调 */
  notifyRead(messageIds: number[]): void;
}

/** no-op notifier，daemon 未注册时的默认实现 */
export class NoopNotifier implements MailboxNotifier {
  notifyNewMessage(_message: MailboxMessage): void {
    /* no-op */
  }
  notifyRead(_messageIds: number[]): void {
    /* no-op */
  }
}

// ─── v3 同步注入模型 ────────────────────────────────────────────────────────

/**
 * v3 投递模式。
 *
 * - stopped: resume 一个已停止的 session 并带 message，等执行完拿到回复
 * - running: 向运行中的 session stdin/API 注入 message
 * - new:     创建新 session，支持指定 model 和 effort
 */
export type SendMode = 'stopped' | 'running' | 'new';

/**
 * SendTarget —— MailboxCore.send() 的入参。
 *
 * 这是 v3 同步注入模型的统一调用入口：调用方指定目标 CLI + 消息，
 * MailboxCore 内部依次执行审计写入 → TriggerAdapter 投递 → ReplyAdapter
 * 提取回复 → 审计写入回复，最后返回 SendResult。
 */
export interface SendTarget {
  /** 目标 CLI id（如 hermes / claude / opencode / trae-ide） */
  cli: string;
  /** 目标 session id（stopped/running 模式需要，new 模式忽略） */
  sessionId?: string;
  /** 投递模式，默认 new */
  mode: SendMode;
  /** 要注入的 user message */
  message: string;
  /** 新 session 指定 model（new 模式） */
  model?: string;
  /** 新 session 指定 effort（如 low/medium/high，new 模式） */
  effort?: string;
  /** 工作目录 */
  cwd?: string;
  /** 超时毫秒，默认 60000 */
  timeoutMs?: number;
  /** 发送方 session id（用于审计；不传则匿名） */
  fromSessionId?: string;
}

/**
 * SendResult —— MailboxCore.send() 的返回值。
 *
 * - delivered: 消息是否成功投递到目标 CLI（即使 agent 没回也 true）
 * - response:  ReplyAdapter 清洗后的 agent 回复文本（可能为空字符串）
 * - exitCode:  cli-spawn 模式的进程退出码
 * - channel:   实际使用的触发通道
 * - latencyMs: send() 总耗时（含 trigger + reply 提取）
 * - newSessionId: new 模式创建出的 session id
 * - error:     失败时的错误信息（delivered=false 时一定有）
 * - messageId: 审计写入的 user 消息 id（始终有，即使投递失败）
 * - replyMessageId: 审计写入的 assistant 回复消息 id（有回复时才有）
 */
export interface SendResult {
  delivered: boolean;
  response: string;
  exitCode?: number;
  channel: string;
  latencyMs: number;
  newSessionId?: string;
  error?: string;
  messageId: number;
  replyMessageId?: number;
}
