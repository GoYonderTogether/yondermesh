/**
 * yondermesh Adapter SDK —— BaseImporter 抽象基类
 *
 * 把 ClaudeCodeImporter / HermesImporter 共有的导入流程提炼为通用模板：
 *   resolveRootPath → 校验 → 注册 source instance → 开始 scan_run →
 *   遍历 scan() → parse() → ingestSession → 建拓扑关系 → 结束 scan_run
 *
 * 子类只需实现 5 个抽象成员（source / coverage / resolveRootPath / scan / parse），
 * 即可得到完整的、幂等的、只读的 importer。
 *
 * 设计取舍：scan() 为同步 Iterable（非 AsyncIterable），与现有 codebase 一致——
 * node:sqlite DatabaseSync 与 fs.readFileSync 均为同步 API，cmdScan dispatcher
 * 也按同步调用。新 SDK importer 因此可直接接入现有同步 cmdScan。
 *
 * 参考实现：src/claude/importer.ts、src/hermes/importer.ts。
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { Coverage, SessionTopology } from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';
import type {
  BaseImporterOptions,
  Importer,
  ImporterStats,
  ParsedSession,
} from './types.js';

// node:sqlite 是实验性内置，vitest/vite 静态解析会误判为裸包 sqlite。
// 用 createRequire 在运行时加载，绕过 vite 预优化（同 store / cass / hermes）。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/**
 * BaseImporter —— 通用 importer 抽象基类。
 *
 * 用法：
 *   class MyImporter extends BaseImporter<unknown> {
 *     readonly source = 'mycli';
 *     readonly coverage = 'A' as const;
 *     resolveRootPath() { return path.join(os.homedir(), '.mycli', 'sessions'); }
 *     *scan(root) { for (const f of collectJsonlFiles(root)) yield { file: f, data: undefined }; }
 *     parse(file, _data) { /* 解析 JSONL → ParsedSession | null *\/ }
 *   }
 *
 *   const stats = new MyImporter(store, { deviceId }).import();
 */
export abstract class BaseImporter<T = unknown> implements Importer {
  constructor(
    protected readonly store: SessionStore,
    protected readonly opts: BaseImporterOptions,
  ) {}

  /** canonical source 名（如 'claude'、'codex'），写入 sessions.source */
  abstract readonly source: string;
  /** 覆盖等级：'A' 原生 adapter / 'B' 兼容 importer / 'C' 仅发现 */
  abstract readonly coverage: Coverage;
  /** 解析扫描根目录路径（如 ~/.claude/projects） */
  abstract resolveRootPath(): string;
  /** 扫描并 yield 候选文件（含子类自定义 data 上下文） */
  abstract scan(rootPath: string): Iterable<{ file: string; data: T }>;
  /** 解析单个文件为 ParsedSession；无有效消息返回 null（跳过） */
  abstract parse(filePath: string, data: T): ParsedSession | null;

  /**
   * 执行一次完整扫描：注册 source instance → 开始 scan_run → 遍历 scan/parse →
   * 入库 → 建拓扑关系 → 结束 scan_run → 返回统计。
   *
   * 幂等：依赖 SessionStore.ingestSession 的 content_hash 判定。
   * 错误处理：scan_run 失败时先 finishScanRun({status:'failed'}) 再抛原始错误。
   */
  import(): ImporterStats {
    const rootPath = this.opts.rootPath ?? this.resolveRootPath();
    const deviceId = this.opts.deviceId;

    // 1. rootPath 必须可读目录
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootPath);
    } catch (e) {
      throw new Error(`${this.source} 扫描目录不可读: ${rootPath} (${errorMessage(e)})`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${this.source} 扫描路径不是目录: ${rootPath}`);
    }

    // 2. 注册 source instance
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: this.source,
      rootPath,
      coverage: this.coverage,
    });

    // 3. 开始 scan_run
    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.scanAndIngest(rootPath, instance.id, deviceId);
      // 4. 正常完成
      this.store.finishScanRun(runId, {
        status: 'completed',
        sessionsSeen: counts.scanned,
        sessionsNew: counts.inserted,
        sessionsUpdated: counts.updated,
      });
      return { scanRunId: runId, sourceInstanceId: instance.id, ...counts };
    } catch (err) {
      // 失败：记录错误后抛原始错误（记录写入失败不掩盖原始错误）
      try {
        this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
      } catch {
        /* scan_run 记录写入失败不应掩盖导致扫描失败的原始错误 */
      }
      throw err;
    }
  }

  // ─── 子类可复用的受保护助手 ──────────────────────────────────────────

  /**
   * 递归收集 rootPath 下所有 .jsonl 文件。
   * excludeSegments 中列出的目录段会被整体跳过（如 'tool-results'）。
   * 返回相对 rootPath 的 posix 路径（跨平台稳定）。
   */
  protected collectJsonlFiles(
    rootPath: string,
    excludeSegments: readonly string[] = [],
  ): Array<{ absPath: string; relPath: string }> {
    const out: Array<{ absPath: string; relPath: string }> = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // 单个目录不可读 → 跳过，不中断整棵树
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (excludeSegments.includes(e.name)) continue;
          walk(abs);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          out.push({ absPath: abs, relPath: toPosix(path.relative(rootPath, abs)) });
        }
      }
    };
    walk(rootPath);
    return out;
  }

  /**
   * 以只读模式打开 SQLite 数据库（绝不写入 CLI 私有 DB）。
   * 调用方负责在 finally 中 db.close()。
   */
  protected openSqliteReadOnly(dbPath: string): DatabaseSyncType {
    return new DatabaseSync(dbPath, { readOnly: true });
  }

  /** 把未知错误归一化为消息字符串 */
  protected errorMessage(e: unknown): string {
    return errorMessage(e);
  }

  /** 获取文件 mtime（ms），失败回退到 Date.now() */
  protected getFileMtime(filePath: string): number {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return Date.now();
    }
  }

  /** 路径转 posix 风格（相对 native id 跨平台稳定） */
  protected toPosix(p: string): string {
    return toPosix(p);
  }

  // ─── 内部实现 ────────────────────────────────────────────────────────

  /** 遍历 scan() → parse() → ingestSession，并建拓扑关系 */
  private scanAndIngest(
    rootPath: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<ImporterStats, 'scanRunId' | 'sourceInstanceId'> {
    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    /** nativeId → 内部 session id，供子 agent 建关系查父 */
    const idByNative = new Map<string, string>();
    /** 已入库 session：{internalId, parentRootNativeId?, sidechain?, topology} */
    const ingested: Array<{
      internalId: string;
      nativeId: string;
      parentRootNativeId?: string;
      sidechain: boolean;
      topology: SessionTopology;
    }> = [];

    for (const item of this.scan(rootPath)) {
      scanned++;
      const parsed = this.parse(item.file, item.data);
      if (!parsed) {
        skipped++; // 无有效消息 → 跳过该文件
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.nativeId,
        source: this.source,
        cwd: parsed.cwd,
        projectPath: parsed.projectPath ?? parsed.cwd,
        startedAt: parsed.startedAt,
        topology: parsed.topology,
        sourceKind: this.coverage,
        messages: parsed.messages,
        model: parsed.model,
        cliVersion: parsed.cliVersion,
        originator: parsed.originator,
        entrySource: parsed.entrySource,
      threadSource: parsed.threadSource ?? (parsed.sidechain ? 'sidechain' : 'user'),
      estimatedCostUsd: parsed.estimatedCostUsd,
      totalInputTokens: parsed.totalInputTokens,
      totalOutputTokens: parsed.totalOutputTokens,
      toolCallCount: parsed.toolCallCount,
      fileModifiedAt: this.getFileMtime(item.file),
    });
      idByNative.set(parsed.nativeId, result.sessionId);
      ingested.push({
        internalId: result.sessionId,
        nativeId: parsed.nativeId,
        parentRootNativeId: parsed.parentRootNativeId,
        sidechain: parsed.sidechain ?? false,
        topology: parsed.topology,
      });
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    // 关系：subagent → parent 的 spawned_by（+ sidechain_of）
    for (const s of ingested) {
      if (s.topology === 'root' || !s.parentRootNativeId) continue;
      const parentId = idByNative.get(s.parentRootNativeId);
      if (!parentId) continue; // 父未入库 → 不猜测关系（§3.4）
      this.store.addRelationship({
        fromSessionId: s.internalId,
        toSessionId: parentId,
        relationType: 'spawned_by',
        evidence: `${this.source} importer: parent_root_native_id`,
      });
      if (s.sidechain) {
        this.store.addRelationship({
          fromSessionId: s.internalId,
          toSessionId: parentId,
          relationType: 'sidechain_of',
          evidence: `${this.source} importer: sidechain=true`,
        });
      }
    }

    return { scanned, inserted, updated, unchanged, skipped };
  }
}

// ─── 模块级私有助手（避免实例方法重复定义） ─────────────────────────────

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
