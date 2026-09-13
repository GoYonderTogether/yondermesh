/**
 * Session Store SQLite schema
 *
 * 6 张表（architecture.md §3.2 建议）：
 *   source_instances / sessions / session_revisions /
 *   messages / session_relationships / scan_runs
 *
 * 身份 = device_id + source_instance_id + native_session_id（§3.1）。
 */

export const SCHEMA = `
-- 1. 来源实例：某设备上的一个采集入口（如 claude-code 的 ~/.claude/projects）
CREATE TABLE IF NOT EXISTS source_instances (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL,
  source       TEXT NOT NULL,
  root_path    TEXT,
  coverage     TEXT NOT NULL DEFAULT 'B',
  presence     TEXT NOT NULL DEFAULT 'present',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (device_id, source, root_path)
);

-- 2. sessions：session 身份 + 当前指针 + 多维切分 + 正交状态
CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,
  device_id             TEXT NOT NULL,
  source_instance_id    TEXT NOT NULL,
  native_session_id     TEXT NOT NULL,
  source                TEXT NOT NULL,
  cwd                   TEXT,
  project_path          TEXT,
  topology              TEXT NOT NULL DEFAULT 'root',
  presence              TEXT NOT NULL DEFAULT 'present',
  retention             TEXT NOT NULL DEFAULT 'live',
  sync_state            TEXT NOT NULL DEFAULT 'local',
  content_hash          TEXT NOT NULL,
  current_revision_id   INTEGER,
  message_count         INTEGER NOT NULL DEFAULT 0,
  started_at            INTEGER,
  last_seen_at          INTEGER NOT NULL,
  ended_at              INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  -- 元数据扩展（LOOP-012）
  model                 TEXT,
  cli_version           TEXT,
  originator            TEXT,
  entry_source          TEXT,
  thread_source         TEXT,
  estimated_cost_usd    REAL,
  total_input_tokens    INTEGER,
  total_output_tokens   INTEGER,
  tool_call_count       INTEGER,
  file_modified_at       INTEGER,
 UNIQUE (device_id, source_instance_id, native_session_id),
  FOREIGN KEY (source_instance_id) REFERENCES source_instances(id)
);

-- 3. session_revisions：内容变更历史
CREATE TABLE IF NOT EXISTS session_revisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  message_count   INTEGER NOT NULL DEFAULT 0,
  source_kind     TEXT,
  recorded_at     INTEGER NOT NULL,
  UNIQUE (session_id, revision_number),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 4. messages：按 revision 保存消息快照
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  revision_id  INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  timestamp    INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (revision_id) REFERENCES session_revisions(id)
);

-- 5. session_relationships：关系单独建模（§3.4）
CREATE TABLE IF NOT EXISTS session_relationships (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session_id TEXT NOT NULL,
  to_session_id   TEXT NOT NULL,
  relation_type   TEXT NOT NULL,
  evidence        TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (from_session_id, to_session_id, relation_type),
  FOREIGN KEY (from_session_id) REFERENCES sessions(id),
  FOREIGN KEY (to_session_id) REFERENCES sessions(id)
);

-- 6. scan_runs：扫描运行记录
CREATE TABLE IF NOT EXISTS scan_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_instance_id TEXT,
  device_id          TEXT,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  status             TEXT NOT NULL DEFAULT 'running',
  sessions_seen      INTEGER NOT NULL DEFAULT 0,
  sessions_new       INTEGER NOT NULL DEFAULT 0,
  sessions_updated   INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  FOREIGN KEY (source_instance_id) REFERENCES source_instances(id)
);

-- 6.5 workspaces：工作目录的归属与分组（**人为判断**，机器推不出来）
-- 为什么需要单独一张表：project_path 只能从 CLI 的 cwd 自动推导，
-- 但「这几个目录属于同一摊事」「这个目录叫什么」是用户的判断，必须能写。
CREATE TABLE IF NOT EXISTS workspaces (
  path        TEXT PRIMARY KEY,
  label       TEXT,
  group_name  TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 6.6 scanned_files：增量扫描索引（文件 → 上次扫描时的 mtime/size）
-- 为什么需要：完整扫描的瓶颈是**读文件**（实测 claude 111 个文件读全文 1809ms，
-- 而 stat 全部只要 1ms）。只有 mtime/size 变了才需要重新读+解析。
-- 用「文件路径」而不是 native_session_id 做键 —— 后者的格式各 CLI 不同，
-- 而且必须读文件才知道，起不到「读之前先跳过」的作用。
CREATE TABLE IF NOT EXISTS scanned_files (
  path        TEXT PRIMARY KEY,
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  scanned_at  INTEGER NOT NULL
);

-- 7. agent_messages：跨 session 消息总线
CREATE TABLE IF NOT EXISTS agent_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  to_session_id   TEXT,
  to_project      TEXT,
  from_session_id TEXT,
  body            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'info',
  created_at      INTEGER NOT NULL,
  read_at         INTEGER,
  -- mailbox v2 扩展（src/mailbox/core.ts）
  priority        TEXT NOT NULL DEFAULT 'normal',
  expires_at      INTEGER,
  thread_id       TEXT,
  reply_to_id     INTEGER,
  FOREIGN KEY (reply_to_id) REFERENCES agent_messages(id)
);

-- 7.1 agent_message_reads：广播的**按收件人**已读状态
-- 为什么需要：agent_messages.read_at 是单列，只够表达「一条消息一个已读者」。
-- 广播（to_project）的语义是「发给该项目所有 agent」，用单列会导致**第一个
-- check 的 agent 把消息从其他 agent 手里偷走**（实测 91% 的 mailbox 流量是广播）。
-- 直投（to_session_id）继续用 read_at；广播用本表按 session 记已读。
CREATE TABLE IF NOT EXISTS agent_message_reads (
  message_id  INTEGER NOT NULL,
  session_id  TEXT NOT NULL,
  read_at     INTEGER NOT NULL,
  PRIMARY KEY (message_id, session_id),
  FOREIGN KEY (message_id) REFERENCES agent_messages(id)
);

-- 8. message_tool_calls：结构化工具调用（loop build-tool-calls-schema）
--    不动 messages 表（避免 12M 行 ALTER）；新建独立表存储 tool_use / function_call。
--    幂等：UNIQUE(message_id, call_seq) → INSERT OR IGNORE 重复跑不重复插入。
CREATE TABLE IF NOT EXISTS message_tool_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL,
  session_id   TEXT NOT NULL,
  call_seq     INTEGER NOT NULL,
  tool_name    TEXT NOT NULL,
  tool_input   TEXT,
  UNIQUE (message_id, call_seq),
  -- ON DELETE CASCADE：消息被清理（compact / retain）时，其工具调用必须一起走。
  -- 否则任何 DELETE FROM messages 都会撞 FOREIGN KEY constraint failed。
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`;

/**
 * 索引定义。必须在 MIGRATION_COLUMNS 之后执行，因为部分索引引用了
 * 迁移新增的列（如 idx_msg_thread 引用 thread_id）。旧库的 agent_messages
 * 表在 CREATE TABLE IF NOT EXISTS 时不会重建，必须先 ALTER 再建索引。
 */
export const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sessions_device        ON sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_sessions_instance      ON sessions(source_instance_id);
CREATE INDEX IF NOT EXISTS idx_sessions_source        ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_topology      ON sessions(topology);
CREATE INDEX IF NOT EXISTS idx_sessions_started       ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_revisions_session      ON session_revisions(session_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_messages_session       ON messages(session_id, revision_id, seq);
CREATE INDEX IF NOT EXISTS idx_rel_from               ON session_relationships(from_session_id);
CREATE INDEX IF NOT EXISTS idx_rel_to                 ON session_relationships(to_session_id);
CREATE INDEX IF NOT EXISTS idx_rel_type               ON session_relationships(relation_type);
CREATE INDEX IF NOT EXISTS idx_scanruns_instance      ON scan_runs(source_instance_id);
CREATE INDEX IF NOT EXISTS idx_msg_to_session         ON agent_messages(to_session_id);
CREATE INDEX IF NOT EXISTS idx_msg_to_project         ON agent_messages(to_project);
CREATE INDEX IF NOT EXISTS idx_msg_created            ON agent_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_unread             ON agent_messages(read_at, to_session_id);
CREATE INDEX IF NOT EXISTS idx_msg_thread             ON agent_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_msg_expires            ON agent_messages(expires_at);
-- 投递队列：按 (投递时机, 未投递) 找待发消息
CREATE INDEX IF NOT EXISTS idx_msg_queue              ON agent_messages(deliver_on, delivered_at);
-- 广播已读：按收件人查未读广播
CREATE INDEX IF NOT EXISTS idx_msg_reads_session      ON agent_message_reads(session_id, message_id);

CREATE INDEX IF NOT EXISTS idx_mtc_message             ON message_tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_mtc_session             ON message_tool_calls(session_id);
`;

/**
 * FTS5 全文索引（messages.content）+ 同步触发器。
 *
 * 设计要点（v2 — 体积优化版）：
 *   - **只索引 user 消息**：用户消息是搜索的主要目标（找"我问过 X 的 session"），
 *     assistant 消息体量大但搜索价值低（多为代码/长回复）。这一限制将 FTS 行数
 *     从 11.3M 降到 ~885K，FTS 体积从预估 13GB 降到 ~0.9GB。
 *   - **截断到 500 字符**：trigram 索引体积与 content 长度线性相关。
 *     user 消息中 > 500 字符的占 18% 但占 80% 字节；截断后查询仍能匹配前 500 字符的子串。
 *   - **Regular FTS5（非 contentless）**：存储 content + UNINDEXED 列（session_id 等）。
 *     contentless 看似节省 ~50% 体积，但 UNINDEXED 列无法检索（xColumnValue 不可用），
 *     导致 JOIN 查询失败。Regular + 截断后 content 存储仅 ~177MB，可接受。
 *   - 使用 trigram 分词器：原生支持 CJK 子串匹配 + 英文子串匹配（大小写不敏感）
 *   - 触发器带 `WHEN new.role = 'user'` 条件，非 user 消息不索引（零开销）
 *   - 查询时通过 session_id + revision_id = sessions.current_revision_id 过滤
 *   - trigram 限制：<3 字符的 token 无法走 FTS，由 store 层 LIKE 回退
 *   - 旧库升级时由 syncFtsIfStale() 回填（见 session-store.ts）
 *   - 零新依赖：better-sqlite3 / node:sqlite 原生支持 FTS5 + trigram
 *
 * 体积对比（11.3M messages 库）：
 *   v1 全量回填：~13GB（content 3.4GB + trigram 10GB）
 *   v2 只 user + 截断 500：~0.9GB（content 177MB + trigram 700MB）
 */
export const SCHEMA_FTS = `
-- FTS5 虚拟表：仅 user 消息的全文索引（trigram 分词器，支持 CJK 子串匹配）
--
-- v3 关键约定：**rowid = messages.id**
--   为什么必须这样：v2 的删除触发器是
--       DELETE FROM messages_fts WHERE message_id = old.id
--   而 message_id 声明为 UNINDEXED（列值不可索引，只有 rowid 可）——于是每删一条
--   messages 都要把整张 FTS 表扫一遍。实战库上 12M 行 FTS × 27 万条删除 =
--   完全卡死（retain apply 因此需要临时 DROP 触发器才能跑完）。
--   rowid 是 FTS5 的索引列，DELETE WHERE rowid = ? 是 O(1)。
--   代价：插入时必须显式指定 rowid（见三个触发器），迁移时需重建一次 FTS。
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  message_id UNINDEXED,
  revision_id UNINDEXED,
  tokenize = 'trigram'
);

-- 触发器：user 消息 INSERT → 索引（截断到 500 字符控制 trigram 体积）
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages WHEN new.role = 'user' BEGIN
  INSERT INTO messages_fts(rowid, content, session_id, message_id, revision_id)
  VALUES (new.id, substr(new.content, 1, 500), new.session_id, new.id, new.revision_id);
END;

-- 触发器：user 消息 DELETE → 从 FTS 删除（O(1)，按 rowid）
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages WHEN old.role = 'user' BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
END;

-- 触发器：user 消息 UPDATE → 重建该行的 FTS 索引
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages WHEN new.role = 'user' BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
  INSERT INTO messages_fts(rowid, content, session_id, message_id, revision_id)
  VALUES (new.id, substr(new.content, 1, 500), new.session_id, new.id, new.revision_id);
END;
`;

/**
 * FTS schema 重建：删除触发器 + 删除 FTS 表，由 SCHEMA_FTS 重新创建。
 *
 * 历史上用于两件事，都是同一个动作（重建才能改 rowid 映射 / 改索引范围）：
 *   v1 → v2：全消息索引 → 仅 user + 截断 500
 *   v2 → v3：message_id 列删除（O(n) 全表扫）→ rowid 删除（O(1)）
 *
 * 幂等：DROP IF EXISTS。调用方负责随后的「回填」（rebuild 后 FTS 为空）。
 */
export const FTS_REBUILD_MIGRATION = `
DROP TRIGGER IF EXISTS messages_fts_ai;
DROP TRIGGER IF EXISTS messages_fts_ad;
DROP TRIGGER IF EXISTS messages_fts_au;

DROP TABLE IF EXISTS messages_fts;
`;

/** @deprecated 保留旧名（v1/v2 → v3 走同一个重建动作），新代码用 FTS_REBUILD_MIGRATION。 */
export const FTS_V2_MIGRATION = FTS_REBUILD_MIGRATION;

/**
 * 已有数据库的列迁移。在 ensureSchema 之后执行，幂等。
 */
export const MIGRATION_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: 'sessions', column: 'model', type: 'TEXT' },
  { table: 'sessions', column: 'cli_version', type: 'TEXT' },
  { table: 'sessions', column: 'originator', type: 'TEXT' },
  { table: 'sessions', column: 'entry_source', type: 'TEXT' },
  { table: 'sessions', column: 'thread_source', type: 'TEXT' },
  { table: 'sessions', column: 'estimated_cost_usd', type: 'REAL' },
  { table: 'sessions', column: 'total_input_tokens', type: 'INTEGER' },
  { table: 'sessions', column: 'total_output_tokens', type: 'INTEGER' },
  { table: 'sessions', column: 'tool_call_count', type: 'INTEGER' },
  { table: 'sessions', column: 'total_cache_read_tokens', type: 'INTEGER' },
  { table: 'sessions', column: 'total_cache_creation_tokens', type: 'INTEGER' },
  { table: 'sessions', column: 'grand_total_tokens', type: 'INTEGER' },
  { table: 'sessions', column: 'api_call_count', type: 'INTEGER' },
  { table: 'sessions', column: 'file_modified_at', type: 'INTEGER' },
  // mailbox v2 扩展（src/mailbox/core.ts）
  { table: 'agent_messages', column: 'priority', type: "TEXT NOT NULL DEFAULT 'normal'" },
  { table: 'agent_messages', column: 'expires_at', type: 'INTEGER' },
  { table: 'agent_messages', column: 'thread_id', type: 'TEXT' },
  { table: 'agent_messages', column: 'reply_to_id', type: 'INTEGER' },
  // 投递队列（unified agent_message）：决定这条消息什么时候、以什么口吻送出去
  { table: 'agent_messages', column: 'deliver_on', type: 'TEXT' },
  { table: 'agent_messages', column: 'delivered_at', type: 'INTEGER' },
  // 投递尝试次数：目标一直不可达时限次放弃（消息仍留在库里，只是不再重试）
  { table: 'agent_messages', column: 'delivery_attempts', type: 'INTEGER NOT NULL DEFAULT 0' },
  // 立即投递的失败原因 / 真正注入目标会话的时刻。
  // 为什么需要单独一列：delivered_at 的语义是「已写进收件人邮箱」（非队列消息插入时
  // 就写上了），跟「真的注入到目标会话里」不是一回事 —— 混用会让"发出去了吗"
  // 永远回答成"发了"，哪怕 spawn 直接失败。
  { table: 'agent_messages', column: 'delivery_error', type: 'TEXT' },
  { table: 'agent_messages', column: 'injected_at', type: 'INTEGER' },
];

/**
 * 数据回填语句：在 runMigrations 之后执行，幂等。
 * 每条 { sql, check }：check 查询返回 1 表示已有非 NULL 值，跳过；否则执行 sql。
 */
export const MIGRATION_BACKFILLS: { check: string; sql: string }[] = [
  {
    check:
      "SELECT EXISTS(SELECT 1 FROM sessions WHERE file_modified_at IS NOT NULL) AS has",
    sql: "UPDATE sessions SET file_modified_at = last_seen_at WHERE file_modified_at IS NULL",
  },
];
