/**
 * yondermesh Daemon — LOOP-006
 *
 * 职责：
 *   1. 启动时全量扫描 cass / claude / codex（cass 只扫一次）
 *   2. 监听 Claude / Codex 目录变化，debounce 后增量扫描
 *   3. 定时 reconcile 兜底 watch 遗漏
 *   4. 单实例锁（PID 文件）
 *   5. SIGINT/SIGTERM 优雅退出
 *
 * 只依赖 node:fs 的 fs.watch；watch 不稳定时回退纯定时扫描。
 */

import * as fs from 'node:fs';

import { hostname } from 'node:os';
import { join } from 'node:path';

import { SessionStore, expandSource } from '../store/index.js';
import { CassImporter, resolveCassDbPath } from '../cass/index.js';
import { ClaudeCodeImporter, resolveClaudeProjectsPath } from '../claude/index.js';
import { CodexImporter, resolveCodexSessionsPath } from '../codex/index.js';
import type { DaemonConfig } from './config.js';
import { defaultDaemonConfig } from './config.js';

/** 单个来源的扫描结果 */
export interface SourceScanResult {
  source: string;
  scanned: number;
  inserted: number;
  updated: number;
  skipped: boolean;
  error?: string;
}

/** 一次全量扫描的结果 */
export interface FullScanResult {
  results: SourceScanResult[];
  startedAt: number;
  finishedAt: number;
}

/** daemon 运行状态快照 */
export interface DaemonStatus {
  running: boolean;
  pid: number;
  dataDir: string;
  dbPath: string;
  startedAt: number;
  lastScan?: FullScanResult;
  watchErrors: string[];
  /** 当前正在 fs.watch 的目录列表 */
  watchedPaths: string[];
}

/**
 * yondermesh Daemon Orchestrator
 *
 * 管理 store 生命周期、adapter 注册、文件监听和定时 reconcile。
 */
export class YondermeshDaemon {
  readonly config: DaemonConfig;
  readonly store: SessionStore;
  private readonly deviceId: string;
  private startedAt = 0;
  private running = false;
  private cassImported = false; // cass 只全量导入一次
  private lastScan?: FullScanResult;
  private watchErrors: string[] = [];
  /** 当前正在 fs.watch 的目录列表（启动时收集，stop 时清空） */
  private watchedPaths: string[] = [];

  // watcher 和 timer 资源
  private watchers: fs.FSWatcher[] = [];
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config?: Partial<DaemonConfig>) {
    this.config = { ...defaultDaemonConfig(), ...config };
    this.deviceId = this.config.deviceId ?? hostname();
    // 确保 dataDir 存在
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    this.store = new SessionStore(this.config.dbPath);
  }

  // ─── 生命周期 ─────────────────────────────────────────────────────────

  /** 启动 daemon：获取锁 → 全扫 → 启动 watch + reconcile */
  async start(): Promise<void> {
    if (this.running) return;

    this.acquireLock();
    this.running = true;
    this.startedAt = Date.now();

    // 全量扫描（同步等待完成）
    await this.fullScan();

    // 启动 watcher：
    // 已知有 jsonl session 目录可监听的 CLI 只有 claude / codex；
    // cursor / gemini / windsurf 没有标准 session 目录；
    // trae / trae-cn 的 session 在 IDE 内部存储。
    // 这些不可监听的 CLI 由 reconcile 兜底（默认 1 分钟）。
    const watchTargets: Array<{ cliId: string; path: string; skip?: boolean }> = [
      { cliId: 'claude', path: resolveClaudeProjectsPath(), skip: this.config.skipClaude },
      { cliId: 'codex', path: resolveCodexSessionsPath(), skip: this.config.skipCodex },
    ];
    for (const t of watchTargets) {
      if (t.skip) continue;
      this.startWatchForCli(t.cliId, t.path);
    }

    // 持久化 watchedPaths 供 cmdStatus 读取（daemon 与 CLI 是两个进程）
    this.persistWatchedPaths();

    // 启动定时 reconcile
    this.reconcileTimer = setInterval(() => {
      this.fullScan().catch((err) => {
        this.watchErrors.push(`reconcile error: ${String(err)}`);
      });
    }, this.config.reconcileIntervalMs);

    // 确保进程不会因为 watcher 保持存活（调用方自己决定是否 hold）
  }

  /** 停止 daemon：清理资源 → 释放锁 */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // 清理 debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // 清理 watchers
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* 忽略关闭错误 */
      }
    }
    this.watchers = [];
    this.watchedPaths = [];

    // 清理 watched-paths 持久化文件
    this.clearWatchedPathsFile();

    // 清理 reconcile timer
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }

    // 释放锁
    this.releaseLock();

    // 关闭 store
    try {
      this.store.close();
    } catch {
      /* 忽略关闭错误 */
    }
  }

  /** 获取运行状态快照 */
  getStatus(): DaemonStatus {
    return {
      running: this.running,
      pid: process.pid,
      dataDir: this.config.dataDir,
      dbPath: this.config.dbPath,
      startedAt: this.startedAt,
      lastScan: this.lastScan,
      watchErrors: [...this.watchErrors],
      watchedPaths: [...this.watchedPaths],
    };
  }

  // ─── 全量扫描 ─────────────────────────────────────────────────────────

  /** 执行一次全量扫描，按来源依次调用 importer */
  async fullScan(): Promise<FullScanResult> {
    const startedAt = Date.now();
    const results = this.scanAllKnownSources();
    const finishedAt = Date.now();
    this.lastScan = { results, startedAt, finishedAt };
    return this.lastScan;
  }

  /**
   * 依次扫描所有已知的 source（cass / claude / codex）。
   * 未来新增 source 只需在此方法追加一个分支。
   */
  private scanAllKnownSources(): SourceScanResult[] {
    const results: SourceScanResult[] = [];

    // cass 只导入一次（它不是实时数据源）
    if (!this.cassImported && !this.config.skipCass) {
      results.push(this.scanCass());
    } else if (this.config.skipCass) {
      results.push({ source: 'cass', scanned: 0, inserted: 0, updated: 0, skipped: true });
    }

    // Claude
    if (!this.config.skipClaude) {
      results.push(this.scanClaude());
    } else {
      results.push({ source: 'claude', scanned: 0, inserted: 0, updated: 0, skipped: true });
    }

    // Codex
    if (!this.config.skipCodex) {
      results.push(this.scanCodex());
    } else {
      results.push({ source: 'codex', scanned: 0, inserted: 0, updated: 0, skipped: true });
    }

    return results;
  }

  private scanCass(): SourceScanResult {
    try {
      const dbPath = resolveCassDbPath();
      if (!fs.existsSync(dbPath)) {
        return { source: 'cass', scanned: 0, inserted: 0, updated: 0, skipped: true };
      }
      const importer = new CassImporter(this.store, { deviceId: this.deviceId });
      const stats = importer.import();
      this.cassImported = true;
      return {
        source: 'cass',
        scanned: stats.scanned,
        inserted: stats.inserted,
        updated: stats.updated,
        skipped: false,
      };
    } catch (err) {
      return {
        source: 'cass',
        scanned: 0,
        inserted: 0,
        updated: 0,
        skipped: true,
        error: String(err),
      };
    }
  }

  private scanClaude(): SourceScanResult {
    try {
      const importer = new ClaudeCodeImporter(this.store, { deviceId: this.deviceId });
      const stats = importer.import();
      return {
        source: 'claude',
        scanned: stats.scanned,
        inserted: stats.inserted,
        updated: stats.updated,
        skipped: false,
      };
    } catch (err) {
      return {
        source: 'claude',
        scanned: 0,
        inserted: 0,
        updated: 0,
        skipped: true,
        error: String(err),
      };
    }
  }

  private scanCodex(): SourceScanResult {
    try {
      const importer = new CodexImporter(this.store, { deviceId: this.deviceId });
      const stats = importer.import();
      return {
        source: 'codex',
        scanned: stats.scanned,
        inserted: stats.inserted,
        updated: stats.updated,
        skipped: false,
      };
    } catch (err) {
      return {
        source: 'codex',
        scanned: 0,
        inserted: 0,
        updated: 0,
        skipped: true,
        error: String(err),
      };
    }
  }

  // ─── 文件监听 ─────────────────────────────────────────────────────────

  /**
   * 对某个 CLI 的 session 目录启动 fs.watch（macOS 递归模式）。
   * 目录不存在时跳过并打印日志；watch 不可用时静默降级到纯定时扫描。
   */
  private startWatchForCli(cliId: string, watchPath: string): void {
    if (!fs.existsSync(watchPath)) {
      process.stderr.write(`[yondermesh] 跳过 ${cliId}: 目录不存在\n`);
      return;
    }
    try {
      const watcher = fs.watch(
        watchPath,
        { recursive: true },
        (_eventType, filename) => {
          // 只关心 .jsonl 文件变化
          if (filename && !filename.endsWith('.jsonl')) return;
          this.scheduleDebouncedScan(cliId);
        },
      );

      watcher.on('error', (err) => {
        this.watchErrors.push(`[${cliId}] watch error: ${String(err)}`);
      });

      this.watchers.push(watcher);
      this.watchedPaths.push(watchPath);
      process.stderr.write(`[yondermesh] 监听 ${cliId}: ${watchPath}\n`);
    } catch (err) {
      // watch 不可用时静默降级到纯定时扫描
      this.watchErrors.push(`[${cliId}] watch init failed: ${String(err)}`);
    }
  }

  /** debounce 后触发对应来源的增量扫描；新增 session 时打印单行日志 */
  private scheduleDebouncedScan(key: string): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      // 增量扫描只扫对应来源
      const beforeTs = Date.now();
      let result: SourceScanResult | undefined;
      if (key === 'claude') {
        result = this.scanClaude();
      } else if (key === 'codex') {
        result = this.scanCodex();
      }
      // 新文件检测：扫描到内容且确实新增了 session 时，输出单行 stderr 日志
      if (result && result.scanned > 0 && result.inserted > 0) {
        const sessionId = this.findFirstRecentlyCreatedSession(key, beforeTs);
        if (sessionId) {
          process.stderr.write(
            `[yondermesh] 新 session 检测到: ${key} ${sessionId}\n`,
          );
        }
      }
    }, this.config.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  /**
   * 查询 source 别名集合中 created_at >= sinceTs 的最新一条 session id。
   * 用于 fs.watch 触发后定位刚入库的新 session。
   */
  private findFirstRecentlyCreatedSession(sourceKey: string, sinceTs: number): string | undefined {
    try {
      const aliases = expandSource(sourceKey);
      const placeholders = aliases.map(() => '?').join(', ');
      // 通过 store 内部 db 句柄执行 raw 查询（store 没暴露按 created_at 过滤的 public API）
      const db = (
        this.store as unknown as {
          db: {
            prepare: (sql: string) => {
              get: (...params: (string | number)[]) => { id?: string } | undefined;
            };
          };
        }
      ).db;
      const row = db
        .prepare(
          `SELECT id FROM sessions
           WHERE source IN (${placeholders}) AND created_at >= ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(...aliases, sinceTs) as { id?: string } | undefined;
      return row?.id;
    } catch {
      return undefined;
    }
  }

  // ─── watched-paths 持久化 ──────────────────────────────────────────────

  /** watched-paths 文件路径（与 PID 文件同目录） */
  private watchedPathsFile(): string {
    return join(this.config.dataDir, 'watched-paths.json');
  }

  /** 把当前 watchedPaths 写入文件，供 cmdStatus 跨进程读取 */
  private persistWatchedPaths(): void {
    try {
      fs.writeFileSync(
        this.watchedPathsFile(),
        JSON.stringify({ paths: this.watchedPaths }),
        'utf-8',
      );
    } catch {
      /* 持久化失败不影响 daemon 运行 */
    }
  }

  /** 清理 watched-paths 文件 */
  private clearWatchedPathsFile(): void {
    try {
      const file = this.watchedPathsFile();
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      /* 忽略清理错误 */
    }
  }

  // ─── 单实例锁 ─────────────────────────────────────────────────────────

  /** 获取 PID 文件锁；已有实例运行则抛错 */
  private acquireLock(): void {
    const pidFile = this.config.pidFile;
    if (fs.existsSync(pidFile)) {
      const content = fs.readFileSync(pidFile, 'utf-8').trim();
      const existingPid = parseInt(content, 10);
      if (existingPid && this.isProcessAlive(existingPid)) {
        throw new Error(
          `yondermesh daemon 已在运行 (PID ${existingPid})。如需强制启动，请先停止旧实例。`,
        );
      }
      // 旧 PID 文件但进程已退出——清理后继续
    }
    fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
  }

  /** 释放 PID 文件 */
  private releaseLock(): void {
    try {
      const pidFile = this.config.pidFile;
      if (fs.existsSync(pidFile)) {
        const content = fs.readFileSync(pidFile, 'utf-8').trim();
        const storedPid = parseInt(content, 10);
        // 只清理自己的 PID 文件
        if (storedPid === process.pid) {
          fs.unlinkSync(pidFile);
        }
      }
    } catch {
      /* 忽略清理错误 */
    }
  }

  /** 检查进程是否存活（跨平台 signal 0 探测） */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/** 导出配置类型和默认值 */
export { defaultDaemonConfig, defaultDataDir } from './config.js';
export type { DaemonConfig } from './config.js';
