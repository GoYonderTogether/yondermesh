/**
 * MCP 工具返回指引生成器
 *
 * 核心设计：工具查询结束后，返回结果附带"下一步建议"，引导调用 agent
 * 不只是罗列数据，而是主动查看 session 内容细节并向用户提议操作。
 *
 * 指引基于实际数据生成，不会凭空产生。
 */

import type { ActiveSummary, AwaitingReviewSession } from '../store/types.js';

/** 单条指引 */
export interface ToolHint {
  /** 优先级：review=需要立即关注, action=建议行动, info=信息性 */
  priority: 'review' | 'action' | 'info';
  /** 指引文本 */
  text: string;
}

/** 短 id：前 12 字符 + ... */
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + '...' : id;
}

/** 截断到 max 字符 */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * 根据活跃 session 摘要 + 等待审阅列表，生成上下文感知的下一步指引。
 *
 * 指引生成规则（按优先级排序）：
 *   1. review：有 session 等待用户审阅 -> 提醒调用方查看最后一条消息内容，
 *      主动向用户汇报并提出下一步操作建议。
 *   2. action：有正在运行的 session -> 建议查看最新进展。
 *   3. action：有空闲 session -> 建议检查是否卡住。
 *   4. info：有已停止 session -> 建议查看最终结果。
 *   5. info：有过期 session -> 建议关注。
 */
export function buildActiveSessionHints(
  summary: ActiveSummary,
  awaitingReview: AwaitingReviewSession[],
): ToolHint[] {
  const hints: ToolHint[] = [];

  // 1. 等待审阅：最高优先级
  if (awaitingReview.length > 0) {
    const top = awaitingReview.slice(0, 5);
    const sessionLines = top
      .map(
        (s) =>
          `  - ${s.source}:${shortId(s.nativeSessionId)} "${truncate(s.lastMessagePreview, 50)}"`,
      )
      .join('\n');

    hints.push({
      priority: 'review',
      text: `有 ${awaitingReview.length} 个 session 最后一条消息是 assistant，正在等待用户审阅回复。请逐个调用 get_session_detail（live=true, limit=3）查看它们最后几条消息，了解 agent 需要什么，然后主动向用户汇报这些 session 的状态并提议下一步操作。`,
    });
    hints.push({
      priority: 'review',
      text: `等待审阅的 session:\n${sessionLines}`,
    });
  }

  // 2. 正在运行：建议查看进展
  if (summary.liveCount > 0) {
    hints.push({
      priority: 'action',
      text: `有 ${summary.liveCount} 个 session 正在运行中（文件 2 分钟内有更新）。建议调用 get_session_detail（live=true, limit=5）查看它们的最新进展。`,
    });
  }

  // 3. 空闲：建议检查是否卡住
  if (summary.idleCount > 0) {
    hints.push({
      priority: 'action',
      text: `有 ${summary.idleCount} 个 session 处于空闲状态（2-30 分钟无文件更新）。如果用户之前在工作，这些可能是在等待用户输入。建议查看最后一条消息确认状态。`,
    });
  }

  // 4. 已停止：建议查看结果
  if (summary.stoppedCount > 0) {
    hints.push({
      priority: 'info',
      text: `有 ${summary.stoppedCount} 个 session 已确认停止（进程退出 + 文件超过 30 分钟未更新）。可以查看它们的最终结果，确认任务是否完成。`,
    });
  }

  // 5. 过期：建议关注
  if (summary.staleCount > 0) {
    hints.push({
      priority: 'info',
      text: `有 ${summary.staleCount} 个 session 超过 30 分钟无活动且无法确认进程状态。建议关注。`,
    });
  }

  return hints;
}

/**
 * 格式化 hint 列表为人类可读文本块（追加到 text 格式的 MCP 响应末尾）。
 */
export function formatHintsAsText(hints: ToolHint[]): string {
  if (hints.length === 0) return '';

  const lines: string[] = ['', '--- 下一步建议 ---'];
  for (const h of hints) {
    const tag =
      h.priority === 'review' ? '[!]' :
      h.priority === 'action' ? '[>]' :
      '[i]';
    lines.push(`${tag} ${h.text}`);
  }
  return lines.join('\n');
}
