/**
 * Mailbox 模块入口
 *
 * 架构层级（v3 同步注入模型）：
 *   交互层 (CLI / MCP / daemon poll)
 *     → MailboxCore.send()  ── 审计写入 + 调度适配层
 *       → TriggerAdapter.trigger()  ── 把 message 注入目标 CLI
 *       ← ReplyAdapter.extractReply()  ── 从 TriggerResult 清洗回复
 *     ← SendResult
 *
 * 旧 v2 异步邮箱（postMessage + peek/pop）仍保留用于审计读取与向后兼容。
 */

export { MailboxCore } from './core.js';
export {
  MAIL_KINDS,
  MAIL_PRIORITIES,
  NoopNotifier,
} from './types.js';
export type {
  MailKind,
  MailPriority,
  MailboxMessage,
  MailboxNotifier,
  MarkReadInput,
  MessageFilter,
  PostMessageInput,
  SendMode,
  SendResult,
  SendTarget,
  TrayNotice,
  UnreadCount,
} from './types.js';
