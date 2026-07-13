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

import { SessionStore } from '../store/index.js';
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

    // 全量扫描
    await this.fullScan();

    // 启动 watcher（Claude / Codex）
    if (!this.config.skipClaude) {
      this.startWatch('claude', resolveClaudeProjectsPath());
    }
    if (!this.config.skipCodex) {
      this.startWatch('codex', resolveCodexSessionsPath());
    }

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
    };
  }

  // ─── 全量扫描 ─────────────────────────────────────────────────────────

  /** 执行一次全量扫描，按来源依次调用 importer */
  async fullScan(): Promise<FullScanResult> {
    const startedAt = Date.now();
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

    const finishedAt = Date.now();
    this.lastScan = { results, startedAt, finishedAt };
    return this.lastScan;
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

  /** 对某个来源目录启动 fs.watch（macOS 递归模式） */
  private startWatch(key: string, watchPath: string): void {
    try {
      if (!fs.existsSync(watchPath)) {
        // 目录不存在不报错，只是跳过
        return;
      }

      const watcher = fs.watch(
        watchPath,
        { recursive: true },
        (_eventType, filename) => {
          // 只关心 .jsonl 文件变化
          if (filename && !filename.endsWith('.jsonl')) return;
          this.scheduleDebouncedScan(key);
        },
      );

      watcher.on('error', (err) => {
        this.watchErrors.push(`[${key}] watch error: ${String(err)}`);
      });

      this.watchers.push(watcher);
    } catch (err) {
      // watch 不可用时静默降级到纯定时扫描
      this.watchErrors.push(`[${key}] watch init failed: ${String(err)}`);
    }
  }

  /** debounce 后触发对应来源的增量扫描 */
  private scheduleDebouncedScan(key: string): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      // 增量扫描只扫对应来源
      if (key === 'claude') {
        this.scanClaude();
      } else if (key === 'codex') {
        this.scanCodex();
      }
    }, this.config.debounceMs);

    this.debounceTimers.set(key, timer);
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
