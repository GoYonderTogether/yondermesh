/**
 * Mailbox Core —— 跨 session 消息总线核心
 *
 * 唯一业务实现层。CLI（src/bin/ymesh.ts）和 MCP（src/mcp/server.ts、tools.ts）
 * 都是薄壳交互层，全部走这里。
 *
 * 架构层级：
 *   交互层 (CLI / MCP / daemon poll)  →  MailboxCore  →  SQLite agent_messages
 *
 * daemon 联动：daemon 实现 MailboxNotifier 接口并通过 registerNotifier() 注册。
 * 注册后每次 postMessage 都会回调 notifier.notifyNewMessage()，由 daemon 决定
 * 是否写 tray 文件 / 触发其他推送通道。daemon 未上线时走 NoopNotifier（polling 模式）。
 *
 * 自识别三层降级：
 *   1. env YONDERMESH_SELF_SESSION_ID（wrapper 注入，最稳）
 *   2. caller 显式传入 selfSessionId（MCP arg / CLI flag）
 *   3. 用 cwd + 最近 live session 自动匹配（兜底）
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import { LIVE_THRESHOLD_MS } from '../store/session-store.js';
import { TriggerAdapter } from '../trigger/adapter.js';
import { ReplyAdapter } from '../trigger/reply-adapter.js';
import type { TriggerRequest } from '../trigger/types.js';
import type {
  MailKind,
  MailPriority,
  MailboxMessage,
  MailboxNotifier,
  MarkReadInput,
  MessageFilter,
  PostMessageInput,
  SendResult,
  SendTarget,
  TrayNotice,
  UnreadCount,
  DeliveryPolicy,
  PendingDelivery,
} from './types.js';
import { MAIL_KINDS, MAIL_PRIORITIES, NoopNotifier } from './types.js';

// node:sqlite 实验性内置，用 createRequire 在运行时加载绕过 vite 预优化
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** 行记录的松散类型 */
type Row = Record<string, unknown>;

/** 默认查询上限 */
const DEFAULT_LIMIT = 50;

/** tray 文件目录名（位于 dataDir 下） */
const TRAY_DIRNAME = 'mailbox-tray';

/**
 * MailboxCore
 *
 * 每个实例持有自己的 SQLite 连接（与 SessionStore 同一个 DB 文件，不同连接）。
 * SQLite 默认 journal 模式下，单进程多连接的读写是安全的（write 时获得文件锁）。
 */

/** 把解析失败的诊断渲染成**给人看的多行提示**（CLI 与 MCP 共用同一份口径）。 */
export function formatSelfSessionFailure(d: SelfSessionDiagnosis): string {
  const lines: string[] = [];
  const why =
    d.reason === 'daemon-down'
      ? '本机 daemon 未运行 → 新会话不会被入库，所以按当前目录匹配不到你'
      : d.reason === 'no-sessions'
        ? '数据库里还没有任何 session（从未 scan 过）'
        : `当前目录（${d.cwd ?? '?'}）匹配不到任何 live 会话（本会话可能尚未入库，或 cwd 不一致）`;
  lines.push('无法解析 self session id（即：我不知道"我自己"是哪个会话）。');
  lines.push(`  原因：${why}`);
  lines.push('  怎么修：');
  for (const h of d.hints) lines.push(`    · ${h}`);
  if (d.nearby && d.nearby.length > 0) {
    lines.push('  最近活跃的会话（大概率其中就有你自己，可用它做 --for）：');
    for (const n of d.nearby) {
      const mins = Math.floor(n.ageMs / 60000);
      const age = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.floor(mins / 60)} 小时前`;
      lines.push(`    · ${n.id.slice(0, 12)}…  ${n.source.padEnd(10)}  ${n.cwd}  ${age}`);
    }
  }
  return lines.join('\n');
}

/** self session 解析失败的原因（用于给可操作的报错，而不是黑盒 null）。 */
export type SelfSessionFailureReason =
  /** daemon 没在跑：新会话不会入库，cwd 匹配必然落空 */
  | 'daemon-down'
  /** 库里一条 session 都没有（还没 scan 过） */
  | 'no-sessions'
  /** daemon 在跑但当前 cwd 匹配不到任何会话（本会话尚未入库 / cwd 不一致） */
  | 'cwd-mismatch';

/** `resolveSelfSessionDetailed()` 的返回：要么给 id，要么给「为什么 + 怎么办」。 */
export interface SelfSessionDiagnosis {
  /** 解析出的 session id；失败为 null */
  sid: string | null;
  /** 成功时说明靠哪一层解析出来的 */
  via?: 'env' | 'explicit' | 'cwd-live' | 'cwd-recent';
  /** 失败原因 */
  reason?: SelfSessionFailureReason;
  /** 失败时：daemon 是否存活 */
  daemonUp?: boolean;
  /** 失败时：本次用于匹配的 cwd */
  cwd?: string;
  /** 失败时：最近活跃的几个会话（帮用户认领自己的 id） */
  nearby?: Array<{ id: string; cwd: string; source: string; ageMs: number }>;
  /** 失败时：可操作的建议（按优先级） */
  hints: string[];
}

export class MailboxCore {
  private readonly db: DatabaseSyncType;
  private readonly dataDir: string;
  private notifier: MailboxNotifier = new NoopNotifier();
  private readonly triggerAdapter: TriggerAdapter;
  private readonly replyAdapter: ReplyAdapter;

  /**
   * @param dbPath SQLite 数据库文件路径（与 SessionStore 同一个文件）
   * @param dataDir yondermesh 数据目录（用于 tray 文件落地）
   * @param triggerAdapter 可选注入 TriggerAdapter（v3 send 用），默认 new TriggerAdapter()
   * @param replyAdapter   可选注入 ReplyAdapter（v3 send 用），默认 new ReplyAdapter()
   */
  constructor(
    dbPath: string,
    dataDir: string,
    triggerAdapter?: TriggerAdapter,
    replyAdapter?: ReplyAdapter,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON');
    // 与 SessionStore 对齐的连接设置。
    // 不设 busy_timeout 的后果实测过：daemon 里 mailbox 连接与 store 连接同库并发时，
    // mailbox 的写会**立刻**抛 "database is locked"（而不是等一会儿重试），
    // 表现为投递/扫描随机失败。
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.dataDir = dataDir;
    this.triggerAdapter = triggerAdapter ?? new TriggerAdapter();
    this.replyAdapter = replyAdapter ?? new ReplyAdapter();
  }

  /** 关闭 DB 连接 */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* 忽略关闭错误 */
    }
  }

  /** 注册 notifier（通常由 daemon 调用）。覆盖前一个 notifier */
  registerNotifier(notifier: MailboxNotifier): void {
    this.notifier = notifier;
  }

  /** 当前 notifier（测试用） */
  getNotifier(): MailboxNotifier {
    return this.notifier;
  }

  // ─── 写入 ────────────────────────────────────────────────────────────

  /**
   * 投递一条消息。
   *
   * 若指定了 replyToId 且未指定 threadId，自动从被回复消息派生 threadId
   * （被回复消息无 threadId 时使用其 id 作为 thread 根）。
   *
   * 投递成功后回调 notifier.notifyNewMessage()。
   *
   * @deprecated v2 异步邮箱模型。新代码请用 {@link send}（v3 同步注入模型）。
   * postMessage 仍保留用于消息审计读取 / 旧 MCP 工具向后兼容，不会被移除。
   */
  postMessage(input: PostMessageInput): number {
    if (!input.body || typeof input.body !== 'string') {
      throw new Error('body 不能为空');
    }
    if (!input.toSessionId && !input.toProject) {
      throw new Error('toSessionId 与 toProject 至少需要一个');
    }

    const kind = input.kind ?? 'info';
    if (!MAIL_KINDS.includes(kind)) {
      throw new Error(`无效 kind: ${kind}（合法值: ${MAIL_KINDS.join(', ')}）`);
    }

    const priority = input.priority ?? 'normal';
    if (!MAIL_PRIORITIES.includes(priority)) {
      throw new Error(`无效 priority: ${priority}（合法值: ${MAIL_PRIORITIES.join(', ')}）`);
    }

    // 派生 threadId
    let threadId = input.threadId ?? null;
    if (input.replyToId && !threadId) {
      const parent = this.db
        .prepare('SELECT id, thread_id FROM agent_messages WHERE id = ?')
        .get(input.replyToId) as Row | undefined;
      if (parent) {
        threadId = (parent.thread_id as string | null) ?? `thread-${parent.id as number}`;
      }
    }

    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO agent_messages
          (to_session_id, to_project, from_session_id, body, kind, created_at, read_at,
           priority, expires_at, thread_id, reply_to_id, deliver_on, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.toSessionId ?? null,
        input.toProject ?? null,
        input.fromSessionId ?? null,
        input.body,
        kind,
        now,
        priority,
        input.expiresAt ?? null,
        threadId,
        input.replyToId ?? null,
        input.deliverOn ?? null,
        // 非队列消息：一写入就算“已投递”（只是存着供收件人读）
        input.deliverOn ? null : now,
      );

    const id = Number(result.lastInsertRowid);
    // 队列消息（deliverOn）先不通知收件人——它还不到时候。
    // 真正送出时由 flush 路径调用 notifyDelivered() 再通知。
    if (!input.deliverOn) {
      const message = this.getMessage(id);
      if (message) {
        this.notifier.notifyNewMessage(message);
      }
    }
    return id;
  }

  // ─── v3 同步注入（send）──────────────────────────────────────────────

  /**
   * v3 同步注入：把 user message 立刻投递到目标 agent CLI session，
   * 并同步拿到 agent 的回复。
   *
   * 流程（架构三层）：
   *   1. 消息层：把 user message 写到 agent_messages 表（审计）
   *   2. 适配层-触发：TriggerAdapter.trigger() 把 message 注入目标 CLI
   *   3. 适配层-回复接收：ReplyAdapter.extractReply() 从 TriggerResult 清洗出回复文本
   *   4. 消息层：把回复也写到 agent_messages（作为 assistant 消息，from=target.sessionId）
   *   5. 返回 SendResult（含 messageId + replyMessageId）
   *
   * 失败语义：
   *   - 即使 TriggerAdapter 投递失败，messageId 也会有值（审计先行）。
   *   - 即使 agent 没回（response 为空），delivered 仍可能为 true（投递成功但无回复）。
   *   - delivered=false 时 error 字段一定有值。
   *
   * @param target SendTarget
   */
  async send(target: SendTarget): Promise<SendResult> {
    const start = Date.now();
    if (!target?.cli) {
      throw new Error('send() 需要 target.cli');
    }
    if (!target?.message || typeof target.message !== 'string') {
      throw new Error('send() 需要 target.message');
    }
    if (target.mode !== 'stopped' && target.mode !== 'running' && target.mode !== 'new') {
      throw new Error(`send() 无效 mode: ${target.mode}`);
    }
    if ((target.mode === 'stopped' || target.mode === 'running') && !target.sessionId) {
      throw new Error(`${target.mode} 模式需要 target.sessionId`);
    }

    // 1) 审计写入 user message（to_session_id = target.sessionId, kind=question）
    const auditInput: PostMessageInput = {
      toSessionId: target.sessionId,
      toProject: undefined,
      fromSessionId: target.fromSessionId,
      body: target.message,
      kind: 'question',
      priority: 'normal',
    };
    // new 模式没有 toSessionId，但 postMessage 要求 toSessionId 或 toProject 至少一个。
    // 用一个稳定的占位 project 路径："ymesh-send/<cli>"，让审计记录可被 forProject 查到。
    if (!auditInput.toSessionId) {
      auditInput.toProject = `ymesh-send/${target.cli}`;
    }
    const messageId = this.postMessage(auditInput);

    // 2) TriggerAdapter.trigger() 投递
    const triggerReq: TriggerRequest = {
      cli: target.cli,
      sessionId: target.sessionId,
      message: target.message,
      mode: target.mode,
      model: target.model,
      effort: target.effort,
      cwd: target.cwd,
      timeoutMs: target.timeoutMs,
    };

    let triggerResult;
    try {
      triggerResult = await this.triggerAdapter.trigger(triggerReq);
    } catch (err) {
      return {
        delivered: false,
        response: '',
        channel: 'cli-spawn',
        latencyMs: Date.now() - start,
        error: `trigger 抛错: ${err instanceof Error ? err.message : String(err)}`,
        messageId,
      };
    }

    // 3) ReplyAdapter 提取回复
    const reply = this.replyAdapter.extractReply(triggerResult, target.cli);

    // 4) 审计写入 assistant 回复（from_session_id = newSessionId 或 target.sessionId）
    let replyMessageId: number | undefined;
    if (reply.text && reply.text.length > 0) {
      const replyAuditInput: PostMessageInput = {
        // 回复方向反过来：from 是目标 agent，to 是原发送方（若已知）
        toSessionId: target.fromSessionId,
        toProject: !target.fromSessionId ? `ymesh-send/${target.cli}` : undefined,
        fromSessionId: triggerResult.newSessionId ?? target.sessionId,
        body: reply.text,
        kind: 'task_update',
        priority: 'normal',
        replyToId: messageId,
        threadId: `thread-${messageId}`,
      };
      try {
        replyMessageId = this.postMessage(replyAuditInput);
      } catch {
        // 审计写入失败不影响 send 主流程
      }
    }

    // 5) 返回 SendResult
    const result: SendResult = {
      delivered: triggerResult.delivered,
      response: reply.text,
      exitCode: triggerResult.exitCode,
      channel: triggerResult.channel,
      latencyMs: Date.now() - start,
      newSessionId: triggerResult.newSessionId,
      error: triggerResult.error,
      messageId,
    };
    if (replyMessageId !== undefined) {
      result.replyMessageId = replyMessageId;
    }
    return result;
  }

  // ─── 读取 ────────────────────────────────────────────────────────────

  /**
   * peek 消息：不标记已读。用于 Channel A 的 hint 注入（"你有 N 条未读"）。
   *
   * 自动过滤已过期消息（expires_at < now），但不删除（删除由 cleanupExpired 异步做）。
   * 同时返回直投（to_session_id = sid）与广播（to_project = sid 所在 project）的消息。
   * 若同时传 forProject，返回该项目下的所有广播。
   */
  peekMessages(filter: MessageFilter): MailboxMessage[] {
    const { sql, params } = this.buildFilterQuery(filter, /* includeExpired */ false);
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map((r) => this.rowToMessage(r));
  }

  /**
   * pop 消息：读取并标记已读。用于 mailbox_check 工具。
   * 行为同 peekMessages，但读后自动 markRead 全部返回的消息。
   */
  popMessages(filter: MessageFilter): MailboxMessage[] {
    const messages = this.peekMessages(filter);
    if (messages.length === 0) return [];

    const now = Date.now();
    const directStmt = this.db.prepare(
      'UPDATE agent_messages SET read_at = ? WHERE id = ? AND read_at IS NULL',
    );
    const broadcastStmt = this.db.prepare(
      'INSERT OR IGNORE INTO agent_message_reads(message_id, session_id, read_at) VALUES (?, ?, ?)',
    );
    const marked: number[] = [];
    for (const m of messages) {
      if (m.toProject) {
        // 广播：只记「我读过了」。read_at 是全局单列，对广播保持为 NULL——
        // 谁先读就把所有人的消息标成已读，是我们要修的 bug。
        const reader = filter.forSessionId;
        if (reader) broadcastStmt.run(m.id, reader, now);
        marked.push(m.id);
      } else {
        const r = directStmt.run(now, m.id);
        if (Number(r.changes) > 0) marked.push(m.id);
      }
    }
    if (marked.length > 0) {
      this.notifier.notifyRead(marked);
    }
    return messages;
  }

  /** 单条消息（不过滤已过期） */
  getMessage(id: number): MailboxMessage | null {
    const row = this.db
      .prepare('SELECT * FROM agent_messages WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? this.rowToMessage(row) : null;
  }

  /**
   * 标记已读。id / allForSession / allForProject 三选一。
   * 返回实际标记的条数。
   */
  markRead(input: MarkReadInput): number {
    const now = Date.now();
    let result: { changes: number | bigint };

    if (typeof input.id === 'number') {
      result = this.db
        .prepare('UPDATE agent_messages SET read_at = ? WHERE id = ? AND read_at IS NULL')
        .run(now, input.id);
    } else if (input.allForSession) {
      result = this.db
        .prepare(
          'UPDATE agent_messages SET read_at = ? WHERE to_session_id = ? AND read_at IS NULL',
        )
        .run(now, input.allForSession);
    } else if (input.allForProject) {
      result = this.db
        .prepare(
          'UPDATE agent_messages SET read_at = ? WHERE to_project = ? AND read_at IS NULL',
        )
        .run(now, input.allForProject);
    } else {
      return 0;
    }

    const changes = Number(result.changes);
    if (changes > 0) {
      // notifyRead 期望具体的 id 列表，这里简化：用一次查询取出
      // 实际场景下 markRead 通常不会批量上千条，可接受
      this.notifier.notifyRead([]);
    }
    return changes;
  }

  /**
   * 计算未读消息数。
   *
   * 若传入 sessionId，自动用该 session 的 project_path 解析广播归属
   * （session 自己发自己项目的广播不计入）。
   */
  countUnread(forSessionId?: string, forProject?: string): UnreadCount {
    const now = Date.now();
    const expiryClause = '(expires_at IS NULL OR expires_at > ?)';

    let direct = 0;
    let broadcast = 0;

    if (forSessionId) {
      // 直投
      const r = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM agent_messages
           WHERE to_session_id = ? AND read_at IS NULL AND ${expiryClause}`,
        )
        .get(forSessionId, now) as Row;
      direct = Number(r.c);

      // 广播：需要查该 session 的 project_path
      const sessionRow = this.db
        .prepare('SELECT project_path FROM sessions WHERE id = ?')
        .get(forSessionId) as Row | undefined;
      const project = sessionRow?.project_path as string | null;
      if (project) {
        // 排除自己发给自己项目的广播（from_session_id = me）；
        // 已读判定按收件人（agent_message_reads），这样同项目的多个 agent
        // 都能看到同一条广播，而不是被第一个 check 的人吃掉。
        const r2 = this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM agent_messages m
             WHERE m.to_project = ? AND m.read_at IS NULL
               AND (m.from_session_id IS NULL OR m.from_session_id != ?)
               AND NOT EXISTS (
                 SELECT 1 FROM agent_message_reads r
                 WHERE r.message_id = m.id AND r.session_id = ?
               )
               AND ${expiryClause}`,
          )
          .get(project, forSessionId, forSessionId, now) as Row;
        broadcast = Number(r2.c);
      }
    } else if (forProject) {
      const r = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM agent_messages
           WHERE to_project = ? AND read_at IS NULL AND ${expiryClause}`,
        )
        .get(forProject, now) as Row;
      broadcast = Number(r.c);
    }

    return { direct, broadcast, total: direct + broadcast };
  }

  /** 列出所有有消息的 session 邮箱 */
  listMailboxes(): Array<{ sessionId: string; messageCount: number; unreadCount: number; lastPostedAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT to_session_id AS sid, COUNT(*) AS c,
                SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread,
                MAX(created_at) AS last
         FROM agent_messages
         WHERE to_session_id IS NOT NULL
         GROUP BY to_session_id
         ORDER BY last DESC`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      sessionId: r.sid as string,
      messageCount: Number(r.c),
      unreadCount: Number(r.unread),
      lastPostedAt: Number(r.last),
    }));
  }

  // ─── 过期清理（daemon 调用） ─────────────────────────────────────────

  /**
   * 删除已过期的消息（expires_at < now）。
   * 返回删除的条数。daemon 应在 reconcile 周期里调用。
   */
  cleanupExpired(): number {
    const now = Date.now();
    const result = this.db.prepare('DELETE FROM agent_messages WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
    return Number(result.changes);
  }

  // ─── tray 文件（daemon 写入的 push 通知） ───────────────────────────

  /**
   * 读取并清空某个 session 的 tray 文件。
   * 用于 mailbox_check 工具：daemon 推送的通知会落到这里，agent 调 check 时消费。
   *
   * daemon 未上线时 tray 文件不存在，返回空数组（polling 模式仍可用 peekMessages）。
   */
  consumeTray(sessionId: string): TrayNotice[] {
    const trayFile = this.trayPath(sessionId);
    if (!existsSync(trayFile)) return [];

    try {
      const content = readFileSync(trayFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      const notices: TrayNotice[] = [];
      for (const line of lines) {
        try {
          notices.push(JSON.parse(line) as TrayNotice);
        } catch {
          // 跳过损坏行
        }
      }
      // 消费后清空文件
      unlinkSync(trayFile);
      return notices;
    } catch {
      return [];
    }
  }

  /** daemon 调用：写入 tray 通知 */
  writeTrayNotice(sessionId: string, messageIds: number[]): void {
    const trayFile = this.trayPath(sessionId);
    try {
      mkdirSync(join(this.dataDir, TRAY_DIRNAME), { recursive: true });
      const notice: TrayNotice = {
        sessionId,
        messageIds,
        notifiedAt: Date.now(),
      };
      // 追加模式（一次可能有多个通知）
      const line = JSON.stringify(notice) + '\n';
      const existing = existsSync(trayFile) ? readFileSync(trayFile, 'utf-8') : '';
      writeFileSync(trayFile, existing + line, 'utf-8');
    } catch {
      // tray 写失败不影响 mailbox 主流程
    }
  }

  /** tray 文件路径 */
  private trayPath(sessionId: string): string {
    return join(this.dataDir, TRAY_DIRNAME, `${sessionId}.txt`);
  }

  // ─── 自识别（3 层降级） ──────────────────────────────────────────────

  /**
   * 解析当前调用方的 self session id —— **带诊断**版本（推荐新代码使用）。
   *
   * 自识别四层降级：env → 显式传入 → cwd 精确匹配（live 2min → recent 5min）→ cwd 前缀。
   * 全部落空时**不再是黑盒**：返回结构化失败原因 + 最近活跃会话候选 + 可操作修法。
   *
   * 为什么要这样做：旧版只返回 null，调用方只能打印一句「无法解析 self session id」，
   * 用户看不出根因（最常见是 **daemon 没跑 → 新会话没入库**），也不知道该做什么。
   */
  resolveSelfSessionDetailed(options: {
    explicit?: string;
    cwd?: string;
    /** 覆盖 daemon pid 文件路径（测试用）。默认走 install/paths。 */
    daemonPidPath?: string;
  }): SelfSessionDiagnosis {
    // 层 1: env
    const envSid = process.env.YONDERMESH_SELF_SESSION_ID;
    if (envSid && typeof envSid === 'string') {
      return { sid: envSid, via: 'env', hints: [] };
    }

    // 层 2: caller 显式传入
    if (options.explicit) {
      return { sid: options.explicit, via: 'explicit', hints: [] };
    }

    const cwd = options.cwd ?? process.cwd();
    const now = Date.now();

    const pick = (sql: string, ...params: (string | number)[]): string | undefined => {
      const row = this.db.prepare(sql).get(...params) as Row | undefined;
      return row?.id ? String(row.id) : undefined;
    };

    if (cwd) {
      const liveThreshold = now - LIVE_THRESHOLD_MS;
      const base = `SELECT id FROM sessions
         WHERE cwd = ? AND retention = 'live'
           AND COALESCE(file_modified_at, last_seen_at) >= ?
         ORDER BY COALESCE(file_modified_at, last_seen_at) DESC
         LIMIT 1`;

      const recentThreshold = now - 5 * 60_000;

      const hit =
        pick(base, cwd, liveThreshold) ??
        pick(base, cwd, recentThreshold) ??
        pick(
          `SELECT id FROM sessions
             WHERE ? LIKE cwd || '%' AND retention = 'live'
               AND COALESCE(file_modified_at, last_seen_at) >= ?
             ORDER BY COALESCE(file_modified_at, last_seen_at) DESC
             LIMIT 1`,
          cwd,
          recentThreshold,
        );

      if (hit) {
        const via =
          pick(base, cwd, liveThreshold) === hit ? 'cwd-live' : 'cwd-recent';
        return { sid: hit, via, hints: [] };
      }
    }

    // ── 全部落空：构造可操作的诊断 ──────────────────────────────────
    const daemonUp = this.isDaemonAlive(options.daemonPidPath);
    const totalSessions =
      (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as Row | undefined)?.n ?? 0;

    // 最近活跃的几个会话，帮用户「认领」自己的 id
    const nearby = this.db
      .prepare(
        `SELECT id, cwd, source, COALESCE(file_modified_at, last_seen_at) AS ts
           FROM sessions
          WHERE retention = 'live'
          ORDER BY COALESCE(file_modified_at, last_seen_at) DESC
          LIMIT 5`,
      )
      .all() as Row[];

    const nearbyOut = nearby.map((r) => ({
      id: String(r.id),
      cwd: String(r.cwd ?? ''),
      source: String(r.source ?? ''),
      ageMs: now - Number(r.ts ?? 0),
    }));

    const reason: SelfSessionFailureReason = !daemonUp
      ? 'daemon-down'
      : totalSessions === 0
        ? 'no-sessions'
        : 'cwd-mismatch';

    const hints: string[] = [];
    if (!daemonUp) {
      hints.push('本机 daemon 未运行 → 先把 daemon 跑起来：`ymesh daemon`（会实时监听 + 定时 reconcile）');
      hints.push('或先做一次全量入库：`ymesh scan`');
    } else {
      hints.push('本会话可能还没入库 → 跑一次 `ymesh scan`，或稍等 daemon 的定时 reconcile');
    }
    hints.push('也可以直接指定：`ymesh mailbox check --for <sid>`（用 `ymesh sessions` 查 id）');
    hints.push('长期方案：让 wrapper 注入 `YONDERMESH_SELF_SESSION_ID`（最稳，不依赖 cwd 猜测）');

    return { sid: null, reason, daemonUp, cwd, nearby: nearbyOut, hints };
  }

  /** daemon 是否存活（读 pid 文件 + kill(0) 探活）。失败一律当作未运行。 */
  private isDaemonAlive(pidPathOverride?: string): boolean {
    try {
      const pidPath = pidPathOverride ?? join(this.dataDir, 'daemon.pid');
      if (!pidPath || !existsSync(pidPath)) return false;
      const pid = Number(readFileSync(pidPath, 'utf-8').trim());
      if (!Number.isFinite(pid) || pid <= 0) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 解析当前调用方的 self session id（薄包装，保持旧签名兼容）。
   *
   * 新代码建议直接用 `resolveSelfSessionDetailed()` 拿诊断信息。
   * 返回 null 表示无法解析（想看"为什么"就用 detailed 版本）。
   */
  resolveSelfSession(options: { explicit?: string; cwd?: string }): string | null {
    return this.resolveSelfSessionDetailed(options).sid;
  }

  // ─── 内部辅助 ────────────────────────────────────────────────────────

  /**
   * 构建 peekMessages 的 SQL。
   *
   * 支持 forSessionId 自动包含广播归属：若传入 forSessionId，
   * 自动查其 project_path 并合并 to_project = ? 的广播消息。
   */
  private buildFilterQuery(filter: MessageFilter, _includeExpired: boolean): { sql: string; params: (string | number)[] } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    const now = Date.now();

    // 默认过滤已过期
    conditions.push('(expires_at IS NULL OR expires_at > ?)');
    params.push(now);

    if (filter.forSessionId) {
      // 同时匹配直投 + 该 session 所在 project 的广播（排除自己发的）
      const sessionRow = this.db
        .prepare('SELECT project_path FROM sessions WHERE id = ?')
        .get(filter.forSessionId) as Row | undefined;
      const project = sessionRow?.project_path as string | null;

      if (project) {
        conditions.push(
          `((to_session_id = ?) OR (to_project = ? AND (from_session_id IS NULL OR from_session_id != ?)))`,
        );
        params.push(filter.forSessionId, project, filter.forSessionId);
      } else {
        conditions.push('to_session_id = ?');
        params.push(filter.forSessionId);
      }
    } else if (filter.forProject) {
      conditions.push('to_project = ?');
      params.push(filter.forProject);
    }

    if (typeof filter.sinceMs === 'number') {
      conditions.push('created_at >= ?');
      params.push(filter.sinceMs);
    }
    if (typeof filter.untilMs === 'number') {
      conditions.push('created_at <= ?');
      params.push(filter.untilMs);
    }
    if (filter.unreadOnly) {
      conditions.push('read_at IS NULL');
      // 广播的已读是「按收件人」的：我在本项目里读过的广播不算未读，
      // 但别人还没读过不影响我。没有这一条就会退化成「谁先读谁吃掉」。
      if (filter.forSessionId) {
        conditions.push(
          `NOT EXISTS (SELECT 1 FROM agent_message_reads r
             WHERE r.message_id = agent_messages.id AND r.session_id = ?)`,
        );
        params.push(filter.forSessionId);
      }
    }
    if (filter.threadId) {
      conditions.push('thread_id = ?');
      params.push(filter.threadId);
    }
    if (filter.priority) {
      conditions.push('priority = ?');
      params.push(filter.priority);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : DEFAULT_LIMIT;
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM agent_messages ${where} ORDER BY created_at ASC LIMIT ${limit}`;
    return { sql, params };
  }

  /** Row → MailboxMessage */
  private rowToMessage(r: Row): MailboxMessage {
    return {
      id: r.id as number,
      toSessionId: (r.to_session_id as string | null) ?? null,
      toProject: (r.to_project as string | null) ?? null,
      fromSessionId: (r.from_session_id as string | null) ?? null,
      body: r.body as string,
      kind: (r.kind as MailKind) ?? 'info',
      priority: (r.priority as MailPriority) ?? 'normal',
      createdAt: r.created_at as number,
      readAt: (r.read_at as number | null) ?? null,
      expiresAt: (r.expires_at as number | null) ?? null,
      threadId: (r.thread_id as string | null) ?? null,
      replyToId: (r.reply_to_id as number | null) ?? null,
      deliverOn: (r.deliver_on as DeliveryPolicy | null) ?? null,
      deliveredAt: (r.delivered_at as number | null) ?? null,
    };
  }

  // ─── 投递队列（unified agent_message）──────────────────────────────

  /**
   * 取出待投递的队列消息。
   *
   * @param deliverOn  投递时机
   * @param sessionId  对 sender_idle 而言是**发送方**；对 target_idle 而言是**目标**
   */
  pendingDeliveries(deliverOn: DeliveryPolicy, sessionId: string): PendingDelivery[] {
    const column = deliverOn === 'sender_idle' ? 'from_session_id' : 'to_session_id';
    const rows = this.db
      .prepare(
        `SELECT id, to_session_id, from_session_id, body, deliver_on, created_at,
                COALESCE(delivery_attempts, 0) AS attempts
           FROM agent_messages
          WHERE deliver_on = ? AND delivered_at IS NULL AND ${column} = ?
          ORDER BY created_at ASC`,
      )
      .all(deliverOn, sessionId) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      toSessionId: (r.to_session_id as string | null) ?? null,
      fromSessionId: (r.from_session_id as string | null) ?? null,
      body: r.body as string,
      deliverOn: r.deliver_on as DeliveryPolicy,
      createdAt: r.created_at as number,
      attempts: (r.attempts as number) ?? 0,
    }));
  }

  /**
   * 取某个投递时机的**全部**待投消息（不按 session 过滤）。
   *
   * 供 DeliveryFlusher 用：它要自己判断「哪一侧已经 idle」，
   * 所以先拿全量再在内存里分组（队列规模本来就小，不值得下推成 SQL）。
   */
  pendingDeliveriesAll(deliverOn: DeliveryPolicy): PendingDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT id, to_session_id, from_session_id, body, deliver_on, created_at,
                COALESCE(delivery_attempts, 0) AS attempts
           FROM agent_messages
          WHERE deliver_on = ? AND delivered_at IS NULL
          ORDER BY created_at ASC`,
      )
      .all(deliverOn) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      toSessionId: (r.to_session_id as string | null) ?? null,
      fromSessionId: (r.from_session_id as string | null) ?? null,
      body: r.body as string,
      deliverOn: r.deliver_on as DeliveryPolicy,
      createdAt: r.created_at as number,
      attempts: (r.attempts as number) ?? 0,
    }));
  }

  /** 记录一次投递尝试（成功与否都算；用于给重试设上限）。 */
  recordDeliveryAttempt(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      'UPDATE agent_messages SET delivery_attempts = COALESCE(delivery_attempts, 0) + 1 WHERE id = ?',
    );
    for (const id of ids) stmt.run(id);
  }

  /**
   * 放弃投递（尝试超限）：标记 delivered_at 让它退出队列，但**不删消息**，
   * 也不标记已读——人还能在库里看到它、知道没送出去。
   */
  abandonDelivery(ids: number[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE agent_messages SET delivered_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  }

  /** 把队列消息标记为已投递（幂等；只有仍在队列里的会被标记）。 */
  markDelivered(ids: number[]): number {
    if (ids.length === 0) return 0;
    const now = Date.now();
    const stmt = this.db.prepare(
      'UPDATE agent_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
    );
    let changed = 0;
    const delivered: number[] = [];
    for (const id of ids) {
      const r = stmt.run(now, id);
      if (Number(r.changes) > 0) {
        changed += 1;
        delivered.push(id);
      }
    }
    // 送出后才通知收件人（入队时故意没通知）
    for (const id of delivered) {
      const m = this.getMessage(id);
      if (m) this.notifier.notifyNewMessage(m);
    }
    return changed;
  }
}
