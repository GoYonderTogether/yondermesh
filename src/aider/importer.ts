/**
 * Aider session 导入器（覆盖等级 B）
 *
 * Aider 无 MCP / Skills / Hooks，session 以 per-project markdown 形式落盘：
 *   <cwd>/.aider.chat.history.md
 *
 * 一个 .aider.chat.history.md 文件可包含多次 aider 调用（每次以
 * `# aider chat started at <ts>` 开头，Aider 采取追加而非覆盖策略）。
 * 无结构化 JSON，需解析 markdown：
 *   - `# aider chat started at YYYY-MM-DD HH:MM:SS` → 一次 session 边界
 *   - `> ...`                    → aider 控制台输出（git / tokens / 警告 / 命令回显），
 *                                  非 user / assistant；其中可抽取元数据：
 *                                    `> Aider v(\S+)`            → cliVersion
 *                                    `> Model: (.+?)( with|$)`    → model
 *                                    `> Tokens: (\d+) sent, (\d+) received` → token 统计
 *   - `#### <text>`              → 一条 user 消息（heading 文本即用户输入；
 *                                  多行时连续非空行均属该 user 消息直到空行）
 *   - user 块空行后的非标记文本（直到下一个 `####` / `# aider` / `> Tokens:` / EOF）
 *                                  → assistant 回复
 *
 * native id：同文件内按 session 出现序 `<relPath>#s<N>`（稳定，跨扫描幂等）。
 * cwd / projectPath：取 .aider.chat.history.md 所在目录（即项目根）。
 *
 * 关键限制（D1-D10）：markdown 格式非结构化，无 tool_calls / 精确 timestamp；
 *   仅 user / assistant 可显示文本可提取，assistant 文本可能含 code fence。
 *   无 MCP / Skills / Hooks —— 上下文注入由 wrapper.ts + inject.ts 负责。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

/** Aider 默认 chat history 文件名（per-project，落盘在 cwd） */
export const AIDER_HISTORY_FILENAME = '.aider.chat.history.md';

/** 扫描 searchPaths 时的默认最大深度（避免遍历巨大目录树） */
const DEFAULT_MAX_DEPTH = 6;

/** 导入器选项 */
export interface AiderImportOptions {
  /** 显式指定一批 .aider.chat.history.md 文件路径（最精确，优先级最高） */
  historyFiles?: string[];
  /** 待扫描的项目根目录列表（递归查找 .aider.chat.history.md，受 maxDepth 限制） */
  searchPaths?: string[];
  /** 递归扫描最大深度，默认 6 */
  maxDepth?: number;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

/** 导入统计 */
export interface AiderImportStats {
  /** 本次 scan_run id */
  scanRunId: number;
  /** 扫描到的 history 文件总数（每个文件注册一个 source instance） */
  filesScanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 session 数（无有效消息 / 文件不可读） */
  skipped: number;
}

/** 单个 session 块的解析结果 */
export interface ParsedAiderSession {
  /** session 在文件内的序号（1-based） */
  index: number;
  /** `# aider chat started at` 后的时间戳（epoch ms，解析失败为 undefined） */
  startedAt?: number;
  /** 原始时间戳字符串 */
  startedAtRaw?: string;
  /** 抽取的元数据 */
  cliVersion?: string;
  model?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  messages: SessionMessageInput[];
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 解析 `# aider chat started at YYYY-MM-DD HH:MM:SS` 为 epoch 毫秒 */
function parseStartedAt(raw: string): number | undefined {
  // Aider 用本地时区写出 "YYYY-MM-DD HH:MM:SS"；T 替换空格后按本地时区解析。
  // 注意：不能盲目追加 ':00'——那会把 "22:48:56" 变成非法的 "22:48:56:00"。
  const ms = Date.parse(raw.replace(' ', 'T'));
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * 解析一整个 .aider.chat.history.md 文件，返回所有 session 块。
 *
 * 文件以 `# aider chat started at <ts>` 切分为多个 session；每个 session 内按行：
 *   - `#### <text>` 开启一条 user 消息（heading 文本为首行，后续非空连续行并入）
 *   - user 消息后的空行之后、直到下一个标记（`####` / `# aider` / `> Tokens:` / EOF）
 *     的非 `>` 行 → assistant 回复
 *   - `> ...` → 控制台（跳过消息提取，但解析元数据）
 *
 * 导出此函数以便单元测试直接覆盖解析逻辑。
 */
export function parseAiderMarkdown(raw: string): ParsedAiderSession[] {
  const sessions: ParsedAiderSession[] = [];
  const lines = raw.split('\n');

  let cur: ParsedAiderSession | null = null;
  /** 当前消息缓冲与角色：null=未在消息块中 */
  let role: 'user' | 'assistant' | null = null;
  let buf: string[] = [];
  /** user 消息是否已结束（遇到空行），结束后内容归 assistant */
  let userClosed = false;

  const flush = (): void => {
    if (!cur) return;
    if (role !== null && buf.length > 0) {
      const content = buf.join('\n').trim();
      if (content.length > 0) {
        cur.messages.push({ role: role as MessageRole, content });
      }
    }
    role = null;
    buf = [];
    userClosed = false;
  };

  const startSession = (startedAtRaw: string | undefined, index: number): void => {
    flush();
    cur = {
      index,
      startedAtRaw,
      startedAt: startedAtRaw ? parseStartedAt(startedAtRaw) : undefined,
      messages: [],
    };
    sessions.push(cur);
    role = null;
    buf = [];
    userClosed = false;
  };

  for (const line of lines) {
    // session 边界
    const headerMatch = line.match(/^#\s+aider chat started at\s+(.+?)\s*$/);
    if (headerMatch) {
      flush();
      startSession(headerMatch[1], sessions.length + 1);
      continue;
    }
    // 文件首行若不是 header（理论上不该发生），仍兜底开一个 session。
    // 直接内联赋值（不调用 startSession）—— TS 不追踪闭包内对 cur 的修改，
    // 若走 startSession 则后续 `if (cur)` 会被错误收窄为 never。
    if (!cur) {
      cur = {
        index: 1,
        startedAtRaw: undefined,
        startedAt: undefined,
        messages: [],
      };
      sessions.push(cur);
      role = null;
      buf = [];
      userClosed = false;
    }

    // user 消息：`#### <text>`
    const userMatch = line.match(/^####\s+(.*)$/);
    if (userMatch) {
      flush();
      role = 'user';
      buf = [userMatch[1]!];
      userClosed = false;
      continue;
    }
    // 裸 `####`（无文本）也视为一次 user 转换，但内容为空 → 跳过
    if (/^####\s*$/.test(line)) {
      flush();
      role = 'user';
      buf = [];
      userClosed = false;
      continue;
    }

    // 控制台行 `> ...`：解析元数据，并结束当前消息块
    if (/^>\s?/.test(line)) {
      flush();
      if (cur) {
        const ver = line.match(/^>\s*Aider v(\S+)/);
        if (ver && !cur.cliVersion) cur.cliVersion = ver[1];
        const mdl = line.match(/^>\s*Model:\s+(.+?)(?:\s+with\b|$)/);
        if (mdl && !cur.model) cur.model = mdl[1]!.trim();
        const tok = line.match(/^>\s*Tokens:\s+(\d+)\s+sent,\s+(\d+)\s+received/);
        if (tok) {
          if (cur.totalInputTokens === undefined) cur.totalInputTokens = Number(tok[1]);
          if (cur.totalOutputTokens === undefined) cur.totalOutputTokens = Number(tok[2]);
        }
      }
      continue;
    }

    // 空行
    if (line.trim() === '') {
      if (role === 'user' && !userClosed) {
        // user 消息结束，后续非标记内容归 assistant
        userClosed = true;
        // 把已累积的 user 内容落盘（保持角色不变，等待 assistant 开始）
        // 这里不 flush：保留 user 角色，仅标记 userClosed，下一条内容将切到 assistant
        const content = buf.join('\n').trim();
        if (cur && content.length > 0) {
          cur.messages.push({ role: 'user', content });
        }
        buf = [];
        role = null;
      } else if (role === 'assistant') {
        // assistant 段内的空行保留为段落分隔
        buf.push('');
      }
      continue;
    }

    // 普通内容行
    if (userClosed || role === null) {
      // 进入 / 继续 assistant 回复
      role = 'assistant';
      buf.push(line);
    } else if (role === 'user') {
      // user 消息的多行续接
      buf.push(line);
    } else if (role === 'assistant') {
      buf.push(line);
    }
  }
  flush();

  return sessions;
}

/** 递归收集 rootPath 下所有 .aider.chat.history.md 文件（受 maxDepth 限制） */
function collectHistoryFiles(rootPath: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 单个目录不可读 → 跳过
    }
    for (const e of entries) {
      // 跳过常见的大目录 / 隐藏目录噪音（node_modules / .git 等）
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && e.name === AIDER_HISTORY_FILENAME) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(rootPath, 0);
  return out;
}

/**
 * Aider markdown chat history 导入器（覆盖等级 B）。
 *
 * 用法：
 *   const importer = new AiderImporter(store, { searchPaths: ['/Users/zoran/Documents/projects'] });
 *   const stats = importer.import();
 *
 * 也支持显式 historyFiles（最精确，不递归扫描）。
 */
export class AiderImporter {
  constructor(
    private readonly store: SessionStore,
    private readonly options: AiderImportOptions = {},
  ) {}

  /** 执行一次扫描，返回统计并写 scan_runs */
  import(): AiderImportStats {
    const deviceId = this.options.deviceId ?? os.hostname();
    const files = this.resolveHistoryFiles();

    if (files.length === 0) {
      throw new Error(
        'AiderImporter: 未找到任何 .aider.chat.history.md。' +
          '请通过 historyFiles 指定文件，或通过 searchPaths 指定待扫描的项目根目录。',
      );
    }

    // 单一汇总 scan_run（覆盖本次所有文件）
    const runId = this.store.startScanRun({ deviceId });

    let filesScanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    try {
      for (const file of files) {
        const perFile = this.importFile(file, deviceId);
        filesScanned += 1;
        inserted += perFile.inserted;
        updated += perFile.updated;
        unchanged += perFile.unchanged;
        skipped += perFile.skipped;
      }

      this.store.finishScanRun(runId, {
        status: 'completed',
        sessionsSeen: inserted + updated + unchanged + skipped,
        sessionsNew: inserted,
        sessionsUpdated: updated,
      });

      return { scanRunId: runId, filesScanned, inserted, updated, unchanged, skipped };
    } catch (err) {
      try {
        this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
      } catch {
        /* scan_run 写入失败不应掩盖原始错误 */
      }
      throw err;
    }
  }

  /** 解析 historyFiles / searchPaths → 实际待导入文件列表 */
  private resolveHistoryFiles(): string[] {
    if (this.options.historyFiles && this.options.historyFiles.length > 0) {
      return this.options.historyFiles.filter((f) => {
        try {
          return fs.statSync(f).isFile();
        } catch {
          return false;
        }
      });
    }
    if (this.options.searchPaths && this.options.searchPaths.length > 0) {
      const maxDepth = this.options.maxDepth ?? DEFAULT_MAX_DEPTH;
      const out: string[] = [];
      for (const root of this.options.searchPaths) {
        try {
          if (fs.statSync(root).isDirectory()) {
            out.push(...collectHistoryFiles(root, maxDepth));
          }
        } catch {
          /* 该 searchPath 不可读 → 跳过 */
        }
      }
      return out;
    }
    return [];
  }

  /** 导入单个 .aider.chat.history.md 文件 */
  private importFile(
    file: string,
    deviceId: string,
  ): { inserted: number; updated: number; unchanged: number; skipped: number } {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
    }

    const projectDir = path.dirname(file);
    const sessions = parseAiderMarkdown(raw);
    if (sessions.length === 0) {
      return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
    }

    // 每个文件注册一个 coverage=B 的 source instance（rootPath=项目目录）
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'aider',
      rootPath: projectDir,
      coverage: 'B' as Coverage,
    });

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const s of sessions) {
      if (s.messages.length === 0) {
        skipped++;
        continue;
      }
      // native id：文件相对自身目录的稳定标识 + session 序号
      const nativeId = `${AIDER_HISTORY_FILENAME}#s${s.index}`;
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId: instance.id,
        nativeSessionId: nativeId,
        source: 'aider',
        cwd: projectDir,
        projectPath: projectDir,
        startedAt: s.startedAt,
        topology: 'root',
        sourceKind: 'B',
        messages: s.messages,
        model: s.model,
        cliVersion: s.cliVersion,
        totalInputTokens: s.totalInputTokens,
        totalOutputTokens: s.totalOutputTokens,
      });
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    return { inserted, updated, unchanged, skipped };
  }
}
