/**
 * Trae IDE wrapper —— Always-on rules + 单 session 提取/转交
 *
 * Trae IDE 与 Cursor 类似，没有「直接 CLI 发起 session」的能力：
 *   - `trae` CLI 是 VS Code fork 的 `code` 命令（用于打开文件/工作区，不发起 AI session）
 *   - session 只能在 GUI 内由用户在 Chat 面板触发
 *
 * 与 Cursor 不同处：
 *   - Trae 有 always-on context 文件：~/.trae[-cn]/project_rules.md（实测支持）
 *   - Trae 的 SQLCipher database.db 加密无法破解 → 仅能用 JSONL 摘要（B 级）
 *   - Trae 没有公开的 hooks.json 配置（不像 Cursor 的 18 hooks）
 *     因此 session 启停观察依赖 ymesh daemon 定期扫描 ~/.trae-cn/memory/projects
 *
 * 提供的能力：
 *   - extractSession(sessionId) —— 从 JSONL 摘要提取单个 session
 *   - transferSession(sessionId, toAgent) —— 把某 session 标记为可被目标 agent 继续的上下文
 *   - observeActiveSessions() —— 主动扫描最近活跃的 Trae session（替代 hooks）
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultDataDir } from '../daemon/config.js';
import { SessionStore } from '../store/session-store.js';
import { TraeIdeExtractor } from './extractor.js';

/** Trae 配置目录候选 */
export const TRAE_CONFIG_DIRS = [
  path.join(os.homedir(), '.trae-cn'),
  path.join(os.homedir(), '.trae'),
];

/** Always-on rules 文件路径（每个 configDir 一个） */
export function traeRulesPath(configDir: string): string {
  return path.join(configDir, 'project_rules.md');
}

/** ymesh awareness 段标记 */
export const TRAE_RULES_START = '<!-- YONDERMESH_AWARENESS_START -->';
export const TRAE_RULES_END = '<!-- YONDERMESH_AWARENESS_END -->';

/** 提取单个 session 的结果 */
export interface TraeExtractSessionResult {
  /** ymesh 内部 session id */
  sessionId?: string;
  /** native session id（从 JSONL 文件名提取） */
  nativeSessionId: string;
  /** 提取到的消息数 */
  messageCount: number;
  /** 是否新创建 */
  created: boolean;
  /** SQLCipher 破解状态 */
  sqlcipherCracked: boolean;
}

/** 转交结果 */
export interface TraeTransferSessionResult {
  /** 源 ymesh session id */
  fromSessionId: string;
  /** 目标 agent 名 */
  toAgent: string;
  /** 转交到的 ymesh 内部标记 session id */
  toSessionId: string;
  /** 转交的消息数 */
  messageCount: number;
}

/** 活跃 session 观察结果（替代 hooks 的被动观察） */
export interface TraeActiveSessionObservation {
  /** 观察时间戳 */
  observedAt: number;
  /** 最近 N 分钟内修改过 JSONL 的 sessionId 列表 */
  activeSessionIds: string[];
  /** 总 session 数 */
  totalSessions: number;
  /** 最近修改时间 */
  latestModifiedAt?: number;
}

/**
 * 提取单个 Trae session（按 sessionId）。
 *
 * 实现策略：调用 TraeIdeExtractor 全量提取后查 store 找目标。
 * 全量提取幂等，重复调用不会产生重复 revision。
 */
export function extractSession(
  sessionId: string,
  options: {
    configDirs?: string[];
    databasePath?: string;
    dbPath?: string;
    deviceId?: string;
    skipSqlcipher?: boolean;
  } = {},
): TraeExtractSessionResult {
  const dbPath = options.dbPath ?? path.join(defaultDataDir(), 'yondermesh.db');
  const store = new SessionStore(dbPath);
  let sqlcipherCracked = false;
  try {
    const extractor = new TraeIdeExtractor(store, {
      configDirs: options.configDirs,
      databasePath: options.databasePath,
      deviceId: options.deviceId,
      skipSqlcipher: options.skipSqlcipher,
    });
    const stats = extractor.extract();
    sqlcipherCracked = stats.sqlcipher.cracked;

    const sessions = store.querySessions({
      source: 'trae-ide',
      limit: 1_000_000,
    });
    const target = sessions.find((s) => s.nativeSessionId === sessionId);
    return {
      sessionId: target?.id,
      nativeSessionId: sessionId,
      messageCount: target?.messageCount ?? 0,
      created: target?.currentRevisionId === 1,
      sqlcipherCracked,
    };
  } finally {
    store.close();
  }
}

/**
 * 转交某 Trae session 到目标 agent。
 *
 * 与 Cursor 同语义：ymesh 是中心 store，目标 agent 通过 query source='trae-ide'
 * 即可拿到上下文。此函数额外在 events 日志中记录转交意图。
 */
export function transferSession(
  sessionId: string,
  toAgent: string,
  options: { dbPath?: string; eventsFile?: string } = {},
): TraeTransferSessionResult {
  const dbPath = options.dbPath ?? path.join(defaultDataDir(), 'yondermesh.db');
  const eventsFile =
    options.eventsFile ?? path.join(defaultDataDir(), 'ide-events.ndjsonl');
  const store = new SessionStore(dbPath);
  try {
    const sessions = store.querySessions({
      source: 'trae-ide',
      limit: 1_000_000,
    });
    const target = sessions.find((s) => s.nativeSessionId === sessionId);
    if (!target) {
      throw new Error(
        `Trae session ${sessionId} 未在 ymesh store 中找到；请先调用 extractSession()`,
      );
    }
    const messages = store.getMessages(target.id);

    try {
      fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
      const line =
        JSON.stringify({
          ts: Date.now(),
          ide: 'trae',
          event: 'transferSession',
          fromSessionId: target.id,
          nativeSessionId: sessionId,
          toAgent,
          messageCount: messages.length,
        }) + '\n';
      fs.appendFileSync(eventsFile, line, 'utf-8');
    } catch {
      // 写事件失败不阻止转交
    }

    return {
      fromSessionId: target.id,
      toAgent,
      toSessionId: target.id,
      messageCount: messages.length,
    };
  } finally {
    store.close();
  }
}

/**
 * 主动观察 Trae 活跃 session（替代 hooks 的被动观察）。
 *
 * 扫描 ~/.trae[-cn]/memory/projects 下的 session_memory_*.jsonl 文件 mtime，
 * 找出最近 withinMs 内修改过的 session。
 *
 * 适用场景：ymesh daemon 周期性调用此函数（如每 30s），检测 Trae 是否有正在进行的 session。
 */
export function observeActiveSessions(
  withinMs: number = 30 * 60 * 1000,
  options: { configDirs?: string[] } = {},
): TraeActiveSessionObservation {
  const configDirs = options.configDirs ?? TRAE_CONFIG_DIRS.filter((d) => fs.existsSync(d));
  const now = Date.now();
  const activeSessionIds = new Set<string>();
  let totalSessions = 0;
  let latestModifiedAt: number | undefined;

  for (const configDir of configDirs) {
    const projectsRoot = path.join(configDir, 'memory', 'projects');
    let projectEntries: fs.Dirent[];
    try {
      projectEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const projDir of projectEntries) {
      if (!projDir.isDirectory()) continue;
      const projPath = path.join(projectsRoot, projDir.name);
      let dateDirs: fs.Dirent[];
      try {
        dateDirs = fs.readdirSync(projPath, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        continue;
      }
      for (const dateDir of dateDirs) {
        const datePath = path.join(projPath, dateDir.name);
        let files: fs.Dirent[];
        try {
          files = fs.readdirSync(datePath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.isFile() || !f.name.startsWith('session_memory_')) continue;
          const filePath = path.join(datePath, f.name);
          try {
            const stat = fs.statSync(filePath);
            const sessionId = f.name.slice(
              'session_memory_'.length,
              f.name.length - '.jsonl'.length,
            );
            totalSessions++;
            if (latestModifiedAt === undefined || stat.mtimeMs > latestModifiedAt) {
              latestModifiedAt = stat.mtimeMs;
            }
            if (now - stat.mtimeMs < withinMs) {
              activeSessionIds.add(sessionId);
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }

  return {
    observedAt: now,
    activeSessionIds: [...activeSessionIds],
    totalSessions,
    latestModifiedAt,
  };
}

/**
 * 通过 `trae` CLI 打开 IDE 到某 workspace。
 * 实测：`trae <path>` 可打开工作区（与 `code` 命令同语义）。
 * 不能直接定位到某 session。
 */
export function openTraeWorkspace(workspacePath: string): void {
  try {
    execFileSync('trae', [workspacePath], { stdio: 'ignore' });
  } catch {
    try {
      execFileSync('open', ['-a', 'Trae', workspacePath], { stdio: 'ignore' });
    } catch {
      // 全部失败 → 静默
    }
  }
}
