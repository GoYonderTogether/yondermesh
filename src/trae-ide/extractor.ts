/**
 * Trae IDE session 提取器（覆盖等级 B —— 兼容 importer，summary-only）
 *
 * Trae 把 chat history 存在两处：
 *   1. SQLCipher 加密的 SQLite：~/Library/Application Support/TRAE SOLO[ CN]/ModularData/ai-agent/database.db
 *      - 加密 header 实测为 16 字节随机数据（非 SQLite "format 3" magic）
 *      - 常见密码（空 / trae / TRAE / tre-cn / bytedance / doudao / sqlcipher / 12345678）全部失败
 *      - cipher_compatibility 1-4 + 空密码均失败
 *      - Trae.app 二进制名为 Electron（标准 Electron 应用），strings 提取不到 SQLCipher key
 *      - **结论：SQLCipher key 极可能由 Trae 在运行时从 macOS Keychain 或本机特征派生**
 *      - **本次破解失败 → 降级为 B 级 JSONL 摘要采集**
 *
 *   2. JSONL 摘要（可读，B 级采集源）：
 *      ~/.trae-cn/memory/projects/<encoded-project>/<YYYYMMDD>/session_memory_<sessionId>.jsonl
 *      - 实测 130+ 个文件可读
 *      - 每行是一个 message 级别的 AI 生成摘要（非完整 transcript）：
 *        {intent, actions[], outcome, learned[], message_summary_time, message_id}
 *        · intent: 用户的请求（自然语言摘要）
 *        · actions[]: assistant 执行的动作列表
 *        · outcome: assistant 的最终结果摘要
 *        · learned[]: 本次学到的事实
 *        · message_summary_time: "YYYY-MM-DD HH:MM:SS" 格式
 *        · message_id: 该 message 的 UUID（与 session id 不同）
 *      - 文件名 session_memory_<sessionId>.jsonl 的 sessionId 是 session 级别 UUID
 *
 * 采集策略：
 *   - 主源：JSONL 摘要（B 级，可读）
 *   - 兼源：尝试 SQLCipher 破解（如果未来发现 key 来源，可升级为 A 级）
 *   - session 建模：每个 session_memory_<sessionId>.jsonl 文件 = 一个 session
 *     native_session_id = sessionId（从文件名提取）
 *     cwd = 解码自 <encoded-project> 目录名
 *     startedAt = 该文件内最早 message_summary_time
 *   - 消息建模（best-effort，因 JSONL 是摘要而非 transcript）：
 *     每行 → 一对 (user, assistant) 消息：
 *       user message: intent
 *       assistant message: outcome + "\n\nActions:\n- " + actions.join("\n- ")
 *                       + "\n\nLearned:\n- " + learned.join("\n- ")
 *     timestamp = message_summary_time
 *   - sourceKind = 'B'（兼容 importer），source = 'trae-ide'
 *
 * 路径解码：trae 用 `-` 替换 `/`，前导 `-` 表示前导 `/`
 *   -Users-zoran-Documents-projects-zeth-ai → /Users/zoran/Documents/projects/zeth-ai
 *   ry-Application-Support-TRAE-SOLO-CN-ModularData-ai-agent-work-mode-projects-<id>-<suffix>
 *     → /ry/Application/Support/... （内部 ModularData 路径，不是真实 cwd）
 *   后者归类为"Trae 内部 session"，cwd 设为 undefined
 *
 * 核心约束（沿用架构 §2 / §4）：
 *   - 只读：绝不写入 Trae 私有 database.db / memory/projects
 *   - 身份三元组：device_id + source_instance_id + native_session_id
 *   - 幂等：依赖 SessionStore.content_hash 判定
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

/** Trae 配置目录候选（macOS 实测两个变体都存在） */
const TRAE_CONFIG_DIRS = [
  path.join(os.homedir(), '.trae-cn'),
  path.join(os.homedir(), '.trae'),
];

/** Trae memory/projects 根目录（JSONL 摘要存放处） */
function traeMemoryProjectsRoot(configDir: string): string {
  return path.join(configDir, 'memory', 'projects');
}

/** Trae SQLCipher database.db 候选路径（按 SOLO CN / SOLO 顺序探测） */
const TRAE_DATABASE_CANDIDATES = [
  path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'TRAE SOLO CN',
    'ModularData',
    'ai-agent',
    'database.db',
  ),
  path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'TRAE SOLO',
    'ModularData',
    'ai-agent',
    'database.db',
  ),
];

/** session_memory_<sessionId>.jsonl 文件名前缀 */
const SESSION_MEMORY_PREFIX = 'session_memory_';
const SESSION_MEMORY_SUFFIX = '.jsonl';

/** SQLCipher 破解尝试的密码候选列表 */
const SQLCIPHER_PASSWORD_CANDIDATES = [
  '',
  'trae',
  'TRAE',
  'trae-cn',
  'traecn',
  'bytedance',
  'ByteDance',
  'doudao',
  'marscode',
  'sqlcipher',
  '12345678',
  'password',
  'trae-solo',
  'trae-solo-cn',
];

/** 导入器选项 */
export interface TraeIdeExtractOptions {
  /** 直接指定 ~/.trae[-cn] 根目录（默认两个都扫） */
  configDirs?: string[];
  /** 直接指定 SQLCipher database.db 路径 */
  databasePath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
  /** 跳过 SQLCipher 破解尝试（仅用 JSONL） */
  skipSqlcipher?: boolean;
}

/** 导入统计 */
export interface TraeIdeExtractStats {
  /** 本次 scan_run id */
  scanRunId: number;
  /** trae-ide source instance id */
  sourceInstanceId: string;
  /** 扫描到的 session 总数（按 sessionId 文件名去重） */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 session 数（无有效消息） */
  skipped: number;
  /** JSONL 文件总数 */
  jsonlFiles: number;
  /** SQLCipher 破解结果 */
  sqlcipher: {
    /** 是否尝试过 */
    attempted: boolean;
    /** 是否破解成功 */
    cracked: boolean;
    /** 成功的密码（破解成功时填） */
    password?: string;
    /** 失败原因（破解失败时填） */
    failureReason?: string;
    /** database.db 路径 */
    databasePath?: string;
  };
}

/** Trae JSONL 单行摘要结构（实测） */
interface TraeSummaryLine {
  /** 用户请求的意图摘要 */
  intent?: string;
  /** assistant 执行的动作列表 */
  actions?: string[];
  /** assistant 的最终结果摘要 */
  outcome?: string;
  /** 本次学到的事实 */
  learned?: string[];
  /** "YYYY-MM-DD HH:MM:SS" 格式 */
  message_summary_time?: string;
  /** 该 message 的 UUID */
  message_id?: string;
}

/** 解析后的 session */
interface ParsedTraeSession {
  /** native session id（从文件名提取的 sessionId UUID） */
  sessionId: string;
  /** cwd（解码自目录名；Trae 内部 session 为 undefined） */
  cwd?: string;
  /** startedAt 毫秒 */
  startedAt?: number;
  /** lastUpdatedAt 毫秒 */
  lastUpdatedAt?: number;
  /** 消息列表 */
  messages: SessionMessageInput[];
  /** 配置目录来源（~/.trae-cn 或 ~/.trae） */
  configDir: string;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 解码 Trae memory/projects 下的 encoded-project 目录名为绝对路径。
 * 实测 Trae 用 `-` 替换 `/`，前导 `-` 表示前导 `/`。
 * 与 Cursor 同样存在字面 `-` 歧义问题（best-effort）。
 *
 * 特殊情况：ry-Application-Support-TRAE-SOLO-CN-... 是 Trae 内部 ModularData 路径，
 * 不是真实项目 cwd，返回 undefined。
 */
function decodeTraeProjectDir(dirName: string): string | undefined {
  // Trae 内部 session（ModularData/ai-agent/work-mode 路径）—— 不是真实 cwd
  if (dirName.startsWith('ry-Application-Support-TRAE')) {
    return undefined;
  }
  // 一般情况：前导 `-` = `/`，其余 `-` 也 = `/`
  const stripped = dirName.startsWith('-') ? dirName.slice(1) : dirName;
  return '/' + stripped.split('-').join('/');
}

/**
 * 解析 "YYYY-MM-DD HH:MM:SS" 为 epoch 毫秒。
 * 兼容 ISO 8601 格式（"YYYY-MM-DDTHH:MM:SSZ"）。
 * 非法返回 undefined。
 */
function parseTraeTimestamp(s: string | undefined): number | undefined {
  if (!s) return undefined;
  // Trae 用本地时区 "YYYY-MM-DD HH:MM:SS"，Date.parse 在 V8 中能识别带空格的格式
  // 但为稳妥起见，转成 ISO 格式
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** 安全 JSON.parse：失败返回 undefined */
function safeJsonParse<T = unknown>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/**
 * 把一行 Trae summary 转换为 (user, assistant) 消息对。
 *   user message: intent（用户请求摘要）
 *   assistant message: outcome + actions + learned 拼接
 * 任一为空则跳过对应角色消息；两者都空则跳过整行。
 */
function summaryLineToMessages(line: TraeSummaryLine): SessionMessageInput[] {
  const out: SessionMessageInput[] = [];
  const ts = parseTraeTimestamp(line.message_summary_time);

  if (typeof line.intent === 'string' && line.intent.trim().length > 0) {
    out.push({ role: 'user' as MessageRole, content: line.intent, timestamp: ts });
  }

  const parts: string[] = [];
  if (typeof line.outcome === 'string' && line.outcome.trim().length > 0) {
    parts.push(line.outcome);
  }
  if (Array.isArray(line.actions) && line.actions.length > 0) {
    parts.push('Actions:\n- ' + line.actions.filter((a) => typeof a === 'string' && a.length > 0).join('\n- '));
  }
  if (Array.isArray(line.learned) && line.learned.length > 0) {
    parts.push('Learned:\n- ' + line.learned.filter((l) => typeof l === 'string' && l.length > 0).join('\n- '));
  }
  if (parts.length > 0) {
    out.push({ role: 'assistant' as MessageRole, content: parts.join('\n\n'), timestamp: ts });
  }

  return out;
}

/**
 * 扫描 ~/.trae[-cn]/memory/projects/<encoded-project>/<YYYYMMDD>/session_memory_<sessionId>.jsonl
 * 返回 sessionId → ParsedTraeSession 映射。
 *
 * 同 sessionId 可能在多个 YYYYMMDD 目录下有文件（实测如此，同 session 跨日）：
 *   ~/.trae-cn/memory/projects/<proj>/20260704/session_memory_<id>.jsonl
 *   ~/.trae-cn/memory/projects/<proj>/20260705/session_memory_<id>.jsonl
 * 此时按日期顺序合并消息（保持时间顺序）。
 */
function readTraeJsonlSummaries(configDirs: string[]): {
  sessions: Map<string, ParsedTraeSession>;
  fileCount: number;
} {
  const sessions = new Map<string, ParsedTraeSession>();
  let fileCount = 0;

  for (const configDir of configDirs) {
    const projectsRoot = traeMemoryProjectsRoot(configDir);
    let projectEntries: fs.Dirent[];
    try {
      projectEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const projDir of projectEntries) {
      if (!projDir.isDirectory()) continue;
      const cwd = decodeTraeProjectDir(projDir.name);
      const projPath = path.join(projectsRoot, projDir.name);

      // 按 YYYYMMDD 日期目录稳定排序
      let dateDirs: fs.Dirent[];
      try {
        dateDirs = fs.readdirSync(projPath, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        continue;
      }
      dateDirs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const dateDir of dateDirs) {
        const datePath = path.join(projPath, dateDir.name);
        let files: fs.Dirent[];
        try {
          files = fs.readdirSync(datePath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.isFile()) continue;
          if (!f.name.startsWith(SESSION_MEMORY_PREFIX) || !f.name.endsWith(SESSION_MEMORY_SUFFIX)) {
            continue;
          }
          fileCount++;
          const sessionId = f.name.slice(
            SESSION_MEMORY_PREFIX.length,
            f.name.length - SESSION_MEMORY_SUFFIX.length,
          );
          if (!sessionId) continue;

          const filePath = path.join(datePath, f.name);
          let raw: string;
          try {
            raw = fs.readFileSync(filePath, 'utf8');
          } catch {
            continue;
          }

          // 同 sessionId 跨日期合并
          let sess = sessions.get(sessionId);
          if (!sess) {
            sess = {
              sessionId,
              cwd,
              messages: [],
              configDir,
            };
            sessions.set(sessionId, sess);
          }

          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const obj = safeJsonParse<TraeSummaryLine>(trimmed);
            if (!obj) continue;
            const msgs = summaryLineToMessages(obj);
            for (const m of msgs) {
              sess.messages.push(m);
              if (m.timestamp !== undefined) {
                if (sess.startedAt === undefined || m.timestamp < sess.startedAt) {
                  sess.startedAt = m.timestamp;
                }
                if (sess.lastUpdatedAt === undefined || m.timestamp > sess.lastUpdatedAt) {
                  sess.lastUpdatedAt = m.timestamp;
                }
              }
            }
          }
        }
      }
    }
  }

  return { sessions, fileCount };
}

/**
 * 尝试用 sqlcipher CLI 破解 Trae database.db。
 *
 * 策略：
 *   1. 检查 sqlcipher 是否安装（brew install sqlcipher）
 *   2. 遍历 SQLCIPHER_PASSWORD_CANDIDATES，对每个密码尝试 PRAGMA key + SELECT
 *   3. 尝试 cipher_compatibility 1-4 + 各种密码组合
 *   4. 全部失败 → 返回 { attempted: true, cracked: false, failureReason }
 *
 * 注：此函数仅做"暴力试密码"，不做：
 *   - 从 Trae 二进制提取 key（Trae 是 Electron，key 在 JS bundle 中加密，需逆向 asar）
 *   - 从 macOS Keychain 提取（需用户授权，且 Trae 极可能用此方式）
 *   - 从 database.db-shm / -wal 文件恢复明文（WAL 也是加密的）
 */
export function tryCrackTraeSqlcipher(databasePath?: string): {
  attempted: boolean;
  cracked: boolean;
  password?: string;
  failureReason?: string;
  databasePath?: string;
} {
  // 1. 找到 database.db
  const dbPath =
    databasePath ?? TRAE_DATABASE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!dbPath) {
    return {
      attempted: false,
      cracked: false,
      failureReason: 'no database.db found in TRAE SOLO[ CN] ModularData',
    };
  }

  // 2. 检查 sqlcipher CLI
  let sqlcipherBin: string;
  try {
    sqlcipherBin = execFileSync('which', ['sqlcipher'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!sqlcipherBin) throw new Error('sqlcipher not in PATH');
  } catch {
    return {
      attempted: false,
      cracked: false,
      databasePath: dbPath,
      failureReason: 'sqlcipher CLI not installed (run `brew install sqlcipher`)',
    };
  }

  // 3. 尝试所有密码候选 × cipher_compatibility
  for (const compat of [4, 3, 2, 1]) {
    for (const pw of SQLCIPHER_PASSWORD_CANDIDATES) {
      // 空密码在 sqlcipher 中需要特殊处理（PRAGMA key=''）
      const keyPragma = pw === '' ? `PRAGMA key = '';` : `PRAGMA key = '${pw.replace(/'/g, "''")}';`;
      const sql = `${keyPragma} PRAGMA cipher_compatibility = ${compat}; SELECT count(*) FROM sqlite_master;`;
      try {
        const out = execFileSync(sqlcipherBin, [dbPath, sql], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
        });
        // 成功输出非空数字 → 破解成功
        if (out.trim() && /^\d+$/.test(out.trim())) {
          return {
            attempted: true,
            cracked: true,
            password: pw,
            databasePath: dbPath,
          };
        }
      } catch {
        // 此密码失败，继续下一个
      }
    }
  }

  return {
    attempted: true,
    cracked: false,
    databasePath: dbPath,
    failureReason:
      'all password candidates failed (empty/trae/TRAE/bytedance/doudao/marscode/sqlcipher/... × cipher_compatibility 1-4); key likely derived from macOS Keychain at runtime',
  };
}

/**
 * Trae IDE 提取器。
 *
 * 用法：
 *   const extractor = new TraeIdeExtractor(store, { configDirs, databasePath });
 *   const stats = extractor.extract();
 */
export class TraeIdeExtractor {
  constructor(
    private readonly store: SessionStore,
    private readonly options: TraeIdeExtractOptions = {},
  ) {}

  /** 执行一次完整提取，返回统计并写 scan_runs */
  extract(): TraeIdeExtractStats {
    const configDirs = this.options.configDirs ?? TRAE_CONFIG_DIRS.filter((d) => fs.existsSync(d));
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. 注册 coverage=B 的 trae-ide source instance
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'trae-ide',
      rootPath: configDirs[0] ?? path.join(os.homedir(), '.trae-cn'),
      coverage: 'B' as Coverage,
    });

    // 2. 开始 scan_run
    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.doExtract(configDirs, instance.id, deviceId);
      this.store.finishScanRun(runId, {
        status: 'completed',
        sessionsSeen: counts.scanned,
        sessionsNew: counts.inserted,
        sessionsUpdated: counts.updated,
      });
      return { scanRunId: runId, sourceInstanceId: instance.id, ...counts };
    } catch (err) {
      try {
        this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
      } catch {
        /* 不掩盖原始错误 */
      }
      throw err;
    }
  }

  /** 实际提取逻辑 */
  private doExtract(
    configDirs: string[],
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<TraeIdeExtractStats, 'scanRunId' | 'sourceInstanceId'> {
    // 1. SQLCipher 破解尝试（即使失败也继续，仅记录结果）
    let sqlcipherResult: TraeIdeExtractStats['sqlcipher'] = {
      attempted: false,
      cracked: false,
    };
    if (!this.options.skipSqlcipher) {
      sqlcipherResult = tryCrackTraeSqlcipher(this.options.databasePath);
    }

    // 2. 读 JSONL 摘要（B 级主源）
    const { sessions, fileCount } = readTraeJsonlSummaries(configDirs);

    // 3. 入库
    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const sess of sessions.values()) {
      scanned++;
      if (sess.messages.length === 0) {
        skipped++;
        continue;
      }
      // 消息按 timestamp 稳定排序（跨日期合并后保证时序）
      const ordered = sess.messages.slice().sort((a, b) => {
        if (a.timestamp !== undefined && b.timestamp !== undefined) {
          if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
        } else if (a.timestamp !== undefined) {
          return -1;
        } else if (b.timestamp !== undefined) {
          return 1;
        }
        return 0;
      });

      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: sess.sessionId,
        source: 'trae-ide',
        cwd: sess.cwd,
        projectPath: sess.cwd,
        startedAt: sess.startedAt,
        topology: 'root',
        sourceKind: 'B',
        messages: ordered,
        // Trae 摘要无 model 字段
        entrySource: sqlcipherResult.cracked ? 'sqlite+jsonl' : 'jsonl-summary',
      });
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    return {
      scanned,
      inserted,
      updated,
      unchanged,
      skipped,
      jsonlFiles: fileCount,
      sqlcipher: sqlcipherResult,
    };
  }
}
