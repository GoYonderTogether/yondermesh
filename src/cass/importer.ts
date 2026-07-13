/**
 * cass 历史导入（LOOP-002）
 *
 * 只读导入本机 cass（coding_agent_session_search）历史索引到 Session Vault。
 * 覆盖等级 B（architecture.md §2.2）：广覆盖、归一化消息、不可用于原生恢复。
 *
 * 核心约束：
 *   - 只读：以 readOnly 打开 cass DB，绝不写入 cass（架构 §2 关键取舍）。
 *   - 流式：按 conversation 逐条读取消息，单次只持有一个 conversation 的消息，
 *     内存占用不随消息总量线性增长（LOOP-002 验收门）。
 *   - provenance：session.source 写入底层 agent slug；source_instance 为 coverage=B
 *     的单一 cass 实例；nativeSessionId 取 external_id（回退 source_id → id）。
 *   - 幂等：依赖 SessionStore 的 content_hash 判定，重复导入不新增 revision；
 *     内容变化生成新 revision。
 */

import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

// node:sqlite 实验性内置，vitest/vite 静态解析会误判为裸包；
// 用 createRequire 运行时加载，绕过 vite 预优化（同 store 的做法）。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** macOS 默认 cass 数据目录（cass diag 实测路径） */
const DEFAULT_CASS_DATA_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'com.coding-agent-search.coding-agent-search',
);

/** cass DB 文件名（相对数据目录） */
const CASS_DB_FILENAME = 'agent_search.db';

/** 导入器选项 */
export interface CassImportOptions {
  /** 直接指定 cass DB 路径，优先级最高（覆盖 CASS_DATA_DIR 与默认路径） */
  dbPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface CassImportStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** cass source instance id */
  sourceInstanceId: string;
  /** 扫描到的 conversation 总数 */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 conversation 数（无消息 / 脏数据 / agent 缺失） */
  skipped: number;
}

/** cass conversations 行（JOIN agents/workspaces 后） */
interface CassConversationRow {
  id: number;
  agent_id: number;
  workspace_id: number | null;
  source_id: string;
  external_id: string | null;
  started_at: number | null;
  agent_slug: string | null;
  workspace_path: string | null;
}

/** cass messages 行 */
interface CassMessageRow {
  idx: number;
  role: string;
  content: string;
  created_at: number | null;
}

/**
 * 解析 cass DB 路径。优先级：dbPath 选项 > CASS_DATA_DIR > 默认 macOS 路径。
 */
export function resolveCassDbPath(options: { dbPath?: string } = {}): string {
  if (options.dbPath) return options.dbPath;
  const dataDir = process.env.CASS_DATA_DIR ?? DEFAULT_CASS_DATA_DIR;
  return path.join(dataDir, CASS_DB_FILENAME);
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 只读 cass 历史导入器。
 *
 * 用法：
 *   const importer = new CassImporter(store, { deviceId });
 *   const stats = importer.import();
 */
export class CassImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: CassImportOptions = {},
  ) {}

  /** 执行一次完整导入，返回统计并写 scan_runs */
  import(): CassImportStats {
    const dbPath = resolveCassDbPath(this.options);

    // 1. 以只读方式打开 cass DB；不可读时给明确错误（不写 scan_run，避免遗留 running）
    let cass: DatabaseSyncType;
    try {
      cass = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
      throw new Error(`cass 数据库不可读: ${dbPath} (${errorMessage(e)})`);
    }

    try {
      // 2. schema 校验：缺少必需表时记录诊断并中断（LOOP-002 break 条件）
      this.assertCassSchema(cass, dbPath);

      // 3. 注册 cass source instance（coverage=B），rootPath 为 cass 数据目录
      const deviceId = this.options.deviceId ?? os.hostname();
      const rootPath = path.dirname(dbPath);
      const instance = this.store.registerSourceInstance({
        deviceId,
        source: 'cass',
        rootPath,
        coverage: 'B' as Coverage,
      });

      // 4. 开始 scan_run
      const runId = this.store.startScanRun({
        sourceInstanceId: instance.id,
        deviceId,
      });

      // 5. 按 conversation 流式导入；失败必须把 scan_run finish 为 failed 并写 error 后重新抛出
      try {
        const counts = this.streamImport(cass, instance.id, deviceId);
        // 6. 正常完整路径：completed（seen/new/updated 对齐 store 字段；skipped/unchanged 仅在返回值中）
        this.store.finishScanRun(runId, {
          status: 'completed',
          sessionsSeen: counts.scanned,
          sessionsNew: counts.inserted,
          sessionsUpdated: counts.updated,
        });
        return {
          scanRunId: runId,
          sourceInstanceId: instance.id,
          ...counts,
        };
      } catch (err) {
        this.finishRunFailed(runId, err);
        throw err;
      }
    } finally {
      cass.close();
    }
  }

  /** 把 scan_run 标记为 failed 并写 error；记录写入本身失败时不掩盖原始错误 */
  private finishRunFailed(runId: number, err: unknown): void {
    try {
      this.store.finishScanRun(runId, {
        status: 'failed',
        error: errorMessage(err),
      });
    } catch {
      // scan_run 记录写入失败不应掩盖导致导入失败的原始错误
    }
  }

  /**
   * 校验 cass schema：必需表存在，且当前 SQL 依赖的列名齐全。
   * 列不匹配时给清晰错误（LOOP-002 break 条件：schema 不匹配记录诊断并中断）。
   * 依赖列与 streamImport 的 SELECT/JOIN 严格对应，列名变更即在此捕获。
   */
  private assertCassSchema(cass: DatabaseSyncType, dbPath: string): void {
    // 表 → 当前 SQL 依赖的列（须与 streamImport 的 SELECT/JOIN 一致）
    const required: Record<string, string[]> = {
      conversations: ['id', 'agent_id', 'workspace_id', 'source_id', 'external_id', 'started_at'],
      agents: ['id', 'slug'],
      workspaces: ['id', 'path'],
      messages: ['conversation_id', 'idx', 'role', 'content', 'created_at'],
    };
    const tableInfo = cass.prepare('SELECT name FROM pragma_table_info(?)');
    const missingTables: string[] = [];
    const missingCols: string[] = [];
    for (const [table, cols] of Object.entries(required)) {
      const rows = tableInfo.all(table) as { name: string }[];
      if (rows.length === 0) {
        missingTables.push(table);
        continue;
      }
      const present = new Set(rows.map((r) => r.name));
      for (const c of cols) {
        if (!present.has(c)) missingCols.push(`${table}.${c}`);
      }
    }
    if (missingTables.length > 0 || missingCols.length > 0) {
      const parts: string[] = [];
      if (missingTables.length > 0) parts.push(`缺少表 ${missingTables.join(', ')}`);
      if (missingCols.length > 0) parts.push(`缺少列 ${missingCols.join(', ')}`);
      throw new Error(`cass schema 不匹配: ${dbPath} — ${parts.join('；')}`);
    }
  }

  /**
   * 流式导入：遍历 conversation，逐条查询其消息并 upsert。
   * agents/workspaces 通过 JOIN 随 conversation 行取出（行数 = conversation 数，
   * 不随消息数增长）；messages 按 conversation_id 单独查询，单次只持有一个
   * conversation 的消息，绝不一次性加载全部消息。
   */
  private streamImport(
    cass: DatabaseSyncType,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<CassImportStats, 'scanRunId' | 'sourceInstanceId'> {
    const convStmt = cass.prepare(
      `SELECT c.id, c.agent_id, c.workspace_id, c.source_id, c.external_id, c.started_at,
              a.slug AS agent_slug, w.path AS workspace_path
       FROM conversations c
       LEFT JOIN agents a ON a.id = c.agent_id
       LEFT JOIN workspaces w ON w.id = c.workspace_id
       ORDER BY c.id`,
    );
    const msgStmt = cass.prepare(
      'SELECT idx, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY idx',
    );

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const row of convStmt.iterate()) {
      const conv = row as unknown as CassConversationRow;
      scanned++;

      // agent 缺失 → provenance 不完整，跳过并计数（LOOP-002 单条脏数据 continue）
      const slug = conv.agent_slug;
      if (!slug) {
        skipped++;
        continue;
      }

      const nativeSessionId = this.nativeSessionId(conv);
      const cwd = conv.workspace_path ?? undefined;

      // 仅当前 conversation 的消息进入内存
      const msgRows = msgStmt.all(conv.id) as unknown as CassMessageRow[];
      const messages: SessionMessageInput[] = [];
      for (const m of msgRows) {
        const content = (m.content ?? '').trim();
        if (!content) continue; // 空正文 / 纯空白 → 跳过该条消息
        const role = this.normalizeRole(m.role);
        if (!role) continue; // 未知 role → 跳过该条消息
        messages.push({
          role,
          content: m.content,
          timestamp: m.created_at ?? undefined,
        });
      }
      if (messages.length === 0) {
        skipped++; // 无有效消息 → 跳过该 conversation
        continue;
      }

      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId,
        source: slug,
        cwd,
        startedAt: conv.started_at ?? undefined,
        sourceKind: 'B',
        messages,
      });

      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    return { scanned, inserted, updated, unchanged, skipped };
  }

  /**
   * nativeSessionId 回退链：external_id → source_id:id。
   * external_id 是原生 CLI 自己的 session id，优先使用，便于后续与原生 adapter
   * 记录建 import_alias_of 关系（architecture.md §3.4）。
   *
   * external_id 缺失时不能只用 source_id：cass 的 source_id 可全部为 'local'，
   * 单用会在同一 source_instance 内碰撞。拼接 conversation 数值 id（PK，稳定唯一）
   * 保证 nativeSessionId 在同一 cass 实例内不重复。
   */
  private nativeSessionId(conv: CassConversationRow): string {
    if (conv.external_id && conv.external_id.length > 0) return conv.external_id;
    return `${conv.source_id}:${conv.id}`;
  }

  /**
   * 归一化 cass 消息 role 到 yondermesh MessageRole；未知返回 null（跳过该条）。
   * cass 真实角色分布（本机实测）：agent / tool / user / developer / system / <cli 专属>。
   *   - agent → assistant（cass 对 assistant 的命名，占绝大多数）
   *   - developer → system（开发者指令，语义等同 system）
   *   - user/tool/system → 同名
   *   - 其他（如 gemini 等 cli 专属角色）→ 跳过
   */
  private normalizeRole(role: string | null | undefined): MessageRole | null {
    switch (role) {
      case 'user':
      case 'assistant':
      case 'system':
      case 'tool':
        return role;
      case 'agent':
        return 'assistant';
      case 'developer':
        return 'system';
      default:
        return null;
    }
  }
}
