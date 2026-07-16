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
           priority, expires_at, thread_id, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
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
      );

    const id = Number(result.lastInsertRowid);
    const message = this.getMessage(id);
    if (message) {
      this.notifier.notifyNewMessage(message);
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

    const ids = messages.map((m) => m.id);
    const now = Date.now();
    const stmt = this.db.prepare(
      'UPDATE agent_messages SET read_at = ? WHERE id = ? AND read_at IS NULL',
    );
    const marked: number[] = [];
    for (const id of ids) {
      const r = stmt.run(now, id);
      if (Number(r.changes) > 0) marked.push(id);
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
        // 排除自己发给自己项目的广播（from_session_id = me）
        const r2 = this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM agent_messages
             WHERE to_project = ? AND read_at IS NULL
               AND (from_session_id IS NULL OR from_session_id != ?)
               AND ${expiryClause}`,
          )
          .get(project, forSessionId, now) as Row;
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
   * 解析当前调用方的 self session id。
   *
   * 1. env YONDERMESH_SELF_SESSION_ID（wrapper 注入）
   * 2. caller 显式传入
   * 3. 用 cwd 匹配最近活跃的 live session
   *
   * 返回 null 表示无法解析。
   */
  resolveSelfSession(options: { explicit?: string; cwd?: string }): string | null {
    // 层 1: env
    const envSid = process.env.YONDERMESH_SELF_SESSION_ID;
    if (envSid && typeof envSid === 'string') return envSid;

    // 层 2: caller 显式传入
    if (options.explicit) return options.explicit;

    // 层 3: cwd 匹配
    const cwd = options.cwd ?? process.cwd();
    if (!cwd) return null;

    // 优先：cwd 精确匹配 + 最近 live（2 分钟内有文件活动）
    const now = Date.now();
    const liveThreshold = now - LIVE_THRESHOLD_MS;
    const liveRow = this.db
      .prepare(
        `SELECT id FROM sessions
         WHERE cwd = ? AND retention = 'live'
           AND COALESCE(file_modified_at, last_seen_at) >= ?
         ORDER BY COALESCE(file_modified_at, last_seen_at) DESC
         LIMIT 1`,
      )
      .get(cwd, liveThreshold) as Row | undefined;
    if (liveRow?.id) return liveRow.id as string;

    // 退化：cwd 精确匹配 + 任意最近 session（5 分钟内）
    const recentThreshold = now - 5 * 60_000;
    const recentRow = this.db
      .prepare(
        `SELECT id FROM sessions
         WHERE cwd = ? AND retention = 'live'
           AND COALESCE(file_modified_at, last_seen_at) >= ?
         ORDER BY COALESCE(file_modified_at, last_seen_at) DESC
         LIMIT 1`,
      )
      .get(cwd, recentThreshold) as Row | undefined;
    if (recentRow?.id) return recentRow.id as string;

    // 兜底：cwd 前缀匹配（应对路径符号链接/大小写差异）
    const prefixRow = this.db
      .prepare(
        `SELECT id FROM sessions
         WHERE ? LIKE cwd || '%' AND retention = 'live'
           AND COALESCE(file_modified_at, last_seen_at) >= ?
         ORDER BY COALESCE(file_modified_at, last_seen_at) DESC
         LIMIT 1`,
      )
      .get(cwd, recentThreshold) as Row | undefined;
    if (prefixRow?.id) return prefixRow.id as string;

    return null;
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
    };
  }
}
