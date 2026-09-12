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
import { mountAll } from '../mount/index.js';
import { getAdapter } from '../adapters/registry.js';
import { resolvePiFlavors } from '../pi/index.js';
import { BriefingScheduler } from './briefing-scheduler.js';
import { DeliveryFlusher } from './delivery.js';
import { MailboxCore } from '../mailbox/index.js';
import type { DaemonConfig } from './config.js';
import { defaultDaemonConfig } from './config.js';

/** 单个来源的扫描结果 */
export interface SourceScanResult {
  source: string;
  scanned: number;
  inserted: number;
  updated: number;
  skipped: boolean;
  /** 增量跳过的条数（未变、没读文件）。0 说明全量重读了 —— 排查性能时看这个 */
  unchanged?: number;
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
  /** registry 动态加载的 importer 模块缓存（避免每轮重复 import） */
  private importerModuleCache = new Map<string, Record<string, unknown>>();
  private reconcileTimer?: ReturnType<typeof setInterval>;
  /** 队列投递器：after_turn / on_reply 的排队消息在 session 变 idle 时送出 */
  private deliveryFlusher?: DeliveryFlusher;
  private mailboxFlusher?: MailboxCore;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 每个来源上次真正扫描的时间。
   *
   * 为什么需要：`fs.watch` 监听的是**正在被写入**的目录——尤其 pi，
   * 干活的那个 agent 本身就在不停写自己的 session 文件。每次改动都触发
   * 一次「全量重读该来源所有 session 文件」的同步扫描，于是变成
   * 扫描(N 秒) → 1s debounce → 扫描 → …… 的**热循环**，
   * 事件循环被占满，60s 的 reconcile 定时器直接被饿死（实测 profiler
   * 显示主线程 100% 在 uv__run_timers 里 ReadFileUtf8）。
   *
   * 加一个最小间隔即可把循环变成「有上限的轮询」：无论目录多吵，
   * 每来源最快 minScanGapMs 才扫一次。
   */
  private lastScanAt = new Map<string, number>();
  private briefingScheduler?: BriefingScheduler;
  /** 首轮扫描的 Promise（启动时异步跑，不阻塞 watch/reconcile 起来） */
  private scanInFlight: Promise<void> | null = null;

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

    // 预热 registry 动态 importer（pi 系走异步 dynamic import；
    // 不预热则首次 fullScan 会漏掉 pi，要等下一轮 reconcile）
    await this.prewarmImporterModules();

    // ⚠️ 这里**不再** `await fullScan()`。
    //
    // 为什么要改：这台机首轮全量扫描要 20~30 秒（cass 11.7s + hermes 8s + codex 4s），
    // 而它是同步阻塞的 —— 于是 watch / reconcile 定时器全被压在扫描后面，
    // 启动期 daemon「活着但什么都不干」（实测 profiler 显示主线程 100% 在读文件
    // 和 JSON.parse）。现在改成：先把监听和 reconcile 起起来，
    // 首轮扫描异步跑（且按来源分片让出事件循环，见 scanAllKnownSourcesAsync）。
    this.scanInFlight = this.runInitialScan();

    // 启动 watcher：
    // 有标准 jsonl session 目录、可做实时监听的 CLI：claude / codex / pi(及 omp/gsd)。
    //   · pi 系（pi/omp/gsd-pi）session 在 <configDir>/sessions/<cwd 编码>/*.jsonl，
    //     是嵌套目录 → 用 fs.watch({recursive:true}) 监听顶层 sessions 目录即可。
    //   · cursor / gemini / windsurf 没有标准 session 目录；
    //   · trae / trae-cn 的 session 在 IDE 内部存储。
    //   这些不可监听的 CLI 由 reconcile 兜底（默认 1 分钟）。
    const watchTargets: Array<{ cliId: string; path: string; skip?: boolean }> = [
      { cliId: 'claude', path: resolveClaudeProjectsPath(), skip: this.config.skipClaude },
      { cliId: 'codex', path: resolveCodexSessionsPath(), skip: this.config.skipCodex },
      ...this.resolvePiWatchTargets(),
    ];
    for (const t of watchTargets) {
      if (t.skip) continue;
      this.startWatchForCli(t.cliId, t.path);
    }

    // 持久化 watchedPaths 供 cmdStatus 读取（daemon 与 CLI 是两个进程）
    this.persistWatchedPaths();

    // 队列投递器：复用 reconcile 节奏，检测 live→idle 后投递排队消息。
    // 复用而非新起定时器/进程——daemon 本来就在定期扫描 session 状态。
    this.mailboxFlusher = new MailboxCore(this.config.dbPath, this.config.dataDir);
    this.deliveryFlusher = new DeliveryFlusher(this.store, this.mailboxFlusher, (line) =>
      process.stderr.write(`${line}\n`),
    );

    // 启动定时 reconcile
    this.reconcileTimer = setInterval(() => {
      // **不重入**：上一轮（含首轮）还没跑完就跳过这一轮。
      // 之前这里写成了 `scanInFlight.then(...)` 的链式空操作，等于没守 ——
      // 结果是首轮扫描和 reconcile 并发抢同一个 SQLite 库，
      // 两边都被拖慢（实测 codex 单项从 4s 涨到 53s）。
      if (this.scanInFlight) {
        process.stderr.write('[yondermesh] 上一轮扫描未完成，跳过本轮 reconcile\n');
        return;
      }
      this.scanInFlight = (async () => {
        await yieldToLoop(); // 同样先让出，别把定时器回调本身堵住
        await this.fullScanAsync();
        if (this.config.autoMount) this.autoMount('reconcile');
        await this.deliveryFlusher?.onScanned();
      })()
        .catch((err) => {
          // 失败永不静默：reconcile 出错只 push 进 watchErrors 是没人看的，
          // 会导致「daemon 活着但什么都不干」而无人察觉（实测踩到）。
          const line = `reconcile error: ${String(err)}`;
          this.watchErrors.push(line);
          process.stderr.write(`[yondermesh] ${line}\n`);
        })
        .finally(() => {
          this.scanInFlight = null;
        });
    }, this.config.reconcileIntervalMs);

    // 启动 briefing 定时生成（每小时，可配置关闭）
    if (this.config.briefingEnabled) {
      this.briefingScheduler = new BriefingScheduler(
        this.store,
        this.config.dataDir,
        this.config.briefingIntervalMs,
      );
      this.briefingScheduler.start();
    }

    // 确保进程不会因为 watcher 保持存活（调用方自己决定是否 hold）
  }

  /**
   * 等首轮扫描跑完（可选）。
   *
   * `start()` 现在**不等**首扫（否则 100 秒的 cass 会把 watcher/reconcile 全堵住）。
   * 但调用方有时确实想知道「首扫扫到了什么」——比如 CLI 要打印扫描摘要。
   * 那就显式等这一个 Promise：等待期间事件循环是活的（扫描按来源分片让出），
   * 所以 watcher / reconcile 早就在跑了。
   */
  async waitInitialScan(): Promise<void> {
    if (this.scanInFlight) await this.scanInFlight;
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

    // 清理 briefing scheduler
    if (this.briefingScheduler) {
      this.briefingScheduler.stop();
      this.briefingScheduler = undefined;
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
  /**
   * 把「扫哪些来源」列成一个步骤表 —— 同步和异步两个驱动共用同一份，
   * 避免两处逻辑漂移。
   */
  private sourceSteps(): Array<{ source: string; skip: boolean; run: () => SourceScanResult[] }> {
    return [
      {
        source: 'cass',
        // cass 是一次性历史导入，不是实时源。持久化标记见 cassImportedOnce。
        skip: this.config.skipCass || this.cassImported || this.cassEverImported(),
        run: () => [this.scanCass()],
      },
      {
        source: 'claude',
        skip: !!this.config.skipClaude,
        run: () => [this.scanClaude()],
      },
      {
        source: 'codex',
        skip: !!this.config.skipCodex,
        run: () => [this.scanCodex()],
      },
      {
        source: 'pi',
        skip: !!this.config.skipPi,
        run: () => this.scanPiFlavors(),
      },
    ];
  }

  /**
   * 异步分片全扫：每扫完一个来源就**让出事件循环**。
   *
   * 为什么：单个来源内部是同步的（读文件 + SQLite），一口气跑完会把主线程占满
   * 20~30 秒，watch / reconcile 定时器全被饿死。按来源切片 + setImmediate 让出，
   * 定时器就有机会插进来。
   */
  async fullScanAsync(): Promise<FullScanResult> {
    const startedAt = Date.now();
    const results: SourceScanResult[] = [];
    for (const step of this.sourceSteps()) {
      if (step.skip) {
        results.push({ source: step.source, scanned: 0, inserted: 0, updated: 0, skipped: true });
        continue;
      }
      const t = Date.now();
      const produced = step.run();
      results.push(...produced);
      const took = Date.now() - t;
      // 失败**必须**报出来 —— 之前这里只记录耗时，而 scanClaude/scanCodex 等
      // 会把异常吞成 `skipped:true, error`，于是「扫描 claude: 2142ms」
      // 看起来像正常变慢，实际是在报错（实测踩到，查了很久）。
      const failed = produced.find((r) => r.error);
      if (failed) {
        process.stderr.write(`[yondermesh] 扫描 ${step.source} 失败（${took}ms）: ${failed.error}\n`);
      } else if (took > 2000) {
        // 只对慢的来源打日志（快的别刷屏）。
        // 带上 unchanged：如果它是 0，说明一个都没跳过 —— 那才是真的慢；
        // 如果 unchanged 接近 scanned，说明增量生效了，慢在别处。
        const s0 = produced[0];
        const detail = s0?.unchanged !== undefined ? `，跳过 ${s0.unchanged}` : '';
        process.stderr.write(
          `[yondermesh] 扫描 ${step.source}: ${took}ms（共 ${s0?.scanned ?? '?'}${detail}）\n`,
        );
      }
      await yieldToLoop();
    }
    const finishedAt = Date.now();
    this.lastScan = { results, startedAt, finishedAt };
    return this.lastScan;
  }

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

    // pi 系（pi / omp / gsd-pi）——之前 daemon **完全没扫 pi**：
    // 只能靠手动 `ymesh scan` 入库，导致 daemon 跑着但 pi 新会话不入库
    //（表现为 mailbox 「按 cwd 找不到自己」）。现在纳入定时 reconcile。
    if (!this.config.skipPi) {
      results.push(...this.scanPiFlavors());
    }

    return results;
  }

  /** 首轮扫描（异步、分片）：不阻塞启动，失败也不影响 daemon 存活 */
  private async runInitialScan(): Promise<void> {
    // ⚠️ 关键：先让出事件循环**再**开始扫。
    // async 函数在第一个 await 之前是**同步执行**的 —— 如果直接开扫，
    // cass 那 11.7 秒的同步 import 会把 start() 堵在这里，
    // 后面的 watcher / reconcile 一个都起不来（实测踩到）。
    await yieldToLoop();
    try {
      const t = Date.now();
      const r = await this.fullScanAsync();
      process.stderr.write(
        `[yondermesh] 首轮扫描完成: ${r.results.filter((x) => !x.skipped).length} 个来源，${Date.now() - t}ms\n`,
      );
    } catch (err) {
      process.stderr.write(`[yondermesh] 首轮扫描失败（daemon 继续运行）: ${String(err)}\n`);
    } finally {
      this.scanInFlight = null; // 释放：让 reconcile 正常接管
    }
  }

  /**
   * cass 是否在历史任何一次中导入过（**持久化**标记）。
   *
   * 为什么必须持久化：cass 是一次性历史导入，实测**每次跑要 100+ 秒**
   * （3210 个会话、每个都要读全部消息）。而它按设计只该导入一次 ——
   * 之前只用内存 flag，于是每次 daemon 重启都要白等 100 秒。
   *
   * 注意不能靠 `source='cass'` 判断：cass 导入时写的是**原始 agent 的 source**
   * （claude/hermes/…），库里根本没有 source='cass' 的会话（实测 0 条）。
   */
  private cassEverImported(): boolean {
    try {
      return this.store.getMeta('cass_imported_at') !== null;
    } catch {
      return false;
    }
  }

  /** 标记 cass 已导入（持久化） */
  private markCassImported(): void {
    try {
      this.store.setMeta('cass_imported_at', String(Date.now()));
    } catch {
      /* 标记写失败不影响导入本身 */
    }
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
      this.markCassImported(); // 持久化：下次启动直接跳过（省 100+ 秒）
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
        unchanged: stats.unchanged,
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

  /** 预热 registry 里的异步 importer 模块（pi / omp / gsd-pi），供同步扫描路径使用。 */
  private async prewarmImporterModules(): Promise<void> {
    const ids = ['pi', 'omp', 'gsd-pi'];
    await Promise.all(
      ids.map(async (id) => {
        const adapter = getAdapter(id);
        if (!adapter?.importerLoader) return;
        try {
          this.importerModuleCache.set(id, (await adapter.importerLoader()) as Record<string, unknown>);
        } catch {
          // 加载失败 → 该 flavor 本轮跳过（不阻断 daemon 启动）
        }
      }),
    );
  }

  /**
   * pi 系采集：pi / omp / gsd-pi 共用 PiImporter，靠 flavors 区分目录。
   * 目录不存在时跳过（不报错）。同步接口（dynamic import 已完成）。
   */
  private scanPiFlavors(): SourceScanResult[] {
    const out: SourceScanResult[] = [];
    for (const cliId of ['pi', 'omp', 'gsd-pi'] as const) {
      const adapter = getAdapter(cliId);
      if (!adapter?.importerLoader) continue;
      const flavor = resolvePiFlavors().find((f) => f.cli === cliId);
      if (!flavor) continue;
      // 目录不存在 → 跳过（用户没装这个 flavor）
      const hasDir = flavor.sessionsDirs.some((d) => fs.existsSync(d));
      if (!hasDir) continue;
      const r = this.scanViaRegistrySync(cliId);
      if (r) out.push(r);
    }
    return out;
  }

  /** pi 系的实时监听目标（取各 flavor 首个存在的 sessions 目录） */
  private resolvePiWatchTargets(): Array<{ cliId: string; path: string; skip?: boolean }> {
    const targets: Array<{ cliId: string; path: string; skip?: boolean }> = [];
    for (const cliId of ['pi', 'omp', 'gsd-pi'] as const) {
      const flavor = resolvePiFlavors().find((f) => f.cli === cliId);
      if (!flavor) continue;
      const dir = flavor.sessionsDirs.find((d) => fs.existsSync(d));
      if (dir) targets.push({ cliId, path: dir, skip: this.config.skipPi });
    }
    return targets;
  }

  /**
   * 经 registry 动态加载某 adapter 的 importer 并跑一次增量采集。
   * 与 CLI `ymesh scan` 共用同一套识别逻辑（找 *Importer / *Extractor 类），
   * 避免 daemon 与 CLI 两套实现漂移。
   *
   * 注意：dynamic import 是异步的，这里用「已缓存模块」同步取用；
   * 首次调用若未缓存则返回 null，由 reconcile 下一轮补上（1 分钟后）。
   */
  private scanViaRegistrySync(cliId: string): SourceScanResult | null {
    const adapter = getAdapter(cliId);
    if (!adapter?.importerLoader) return null;
    const cached = this.importerModuleCache.get(cliId);
    if (!cached) {
      // 预热：异步加载后缓存，下一轮 reconcile 生效
      void adapter
        .importerLoader()
        .then((mod) => this.importerModuleCache.set(cliId, mod as Record<string, unknown>))
        .catch(() => undefined);
      return null;
    }
    try {
      let Cls: (new (store: unknown, opts: unknown) => { import?: () => unknown; extract?: () => unknown }) | null = null;
      for (const key of Object.keys(cached)) {
        if ((key.endsWith('Importer') || key.endsWith('Extractor')) && typeof cached[key] === 'function') {
          Cls = cached[key] as new (store: unknown, opts: unknown) => { import?: () => unknown; extract?: () => unknown };
          break;
        }
      }
      if (!Cls) return null;
      const instance = new Cls(this.store, { deviceId: this.deviceId });
      const stats = (instance.import?.() ?? instance.extract?.()) as Record<string, unknown> | undefined;
      const num = (k: string): number => (stats && typeof stats[k] === 'number' ? (stats[k] as number) : 0);
      return {
        source: cliId,
        scanned: num('scanned') || num('threadsSeen'),
        inserted: num('inserted'),
        updated: num('updated'),
        skipped: false,
      };
    } catch (err) {
      return { source: cliId, scanned: 0, inserted: 0, updated: 0, skipped: true, error: String(err) };
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
        unchanged: stats.unchanged,
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
  private scheduleDebouncedScan(key: string, extraDelayMs = 0): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);

      // 节流：距上次真正扫描不足 minScanGapMs 就顺延（见 lastScanAt 注释）。
      // 不这么做，持续写入的目录会把事件循环占满，饿死 reconcile 定时器。
      const gap = this.config.minScanGapMs ?? 15_000;
      const since = Date.now() - (this.lastScanAt.get(key) ?? 0);
      if (since < gap) {
        this.scheduleDebouncedScan(key, gap - since);
        return;
      }
      this.lastScanAt.set(key, Date.now());
      // 增量扫描只扫对应来源
      const beforeTs = Date.now();
      let result: SourceScanResult | undefined;
      if (key === 'claude') {
        result = this.scanClaude();
      } else if (key === 'codex') {
        result = this.scanCodex();
      } else {
        // pi 系（pi / omp / gsd-pi）：走 registry 通用管线
        result = this.scanViaRegistrySync(key) ?? undefined;
      }
      // 新文件检测：扫描到内容且确实新增了 session 时，输出单行 stderr 日志
      if (result && result.scanned > 0 && result.inserted > 0) {
        const sessionId = this.findFirstRecentlyCreatedSession(key, beforeTs);
        if (sessionId) {
          process.stderr.write(
            `[yondermesh] 新 session 检测到: ${key} ${sessionId}\n`,
          );
          // 层 3：session 创建 hook——新 session 入库后自动挂载，
          // 确保 CLI 下次启动新 session 时 yondermesh 扩展已就位
          if (this.config.autoMount) this.autoMount(`session-hook:${key}`);
        }
      }
    }, this.config.debounceMs + extraDelayMs);

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

  // ─── 自动挂载 ─────────────────────────────────────────────────────────

  /**
   * 调用 mountAll 将扩展挂载到所有已安装的 CLI。
   * 幂等：mountAll 内部策略会先 remove 再 add，已挂载的不会重复堆积。
   * 失败只记录到 watchErrors，不抛出，不影响 daemon 主流程。
   */
  private autoMount(reason: string): void {
    try {
      const results = mountAll();
      // unsupported（CLI 不支持该扩展类型）不计入分母，
      // 与 cmdInstall / cmdMount 的统计口径保持一致
      const attempted = results.filter((r) => r.strategy !== 'unsupported');
      const ok = attempted.filter((r) => r.success).length;
      process.stderr.write(
        `[yondermesh] auto-mount: ${ok}/${attempted.length} mounts OK (${reason})\n`,
      );
    } catch (err) {
      this.watchErrors.push(`auto-mount error (${reason}): ${String(err)}`);
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

/** 让出事件循环一拍：setImmediate 比 setTimeout(0) 更靠前，且不引入额外延迟。 */
function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
