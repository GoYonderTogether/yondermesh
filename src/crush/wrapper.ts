/**
 * Crush headless wrapper —— `crush run` 子进程封装
 *
 * Crush（Charm）是项目级 SQLite 存储，CLI 提供 `crush run "<prompt>"` 非交互模式：
 *   - stdout 输出 assistant 响应文本（非 NDJSON，纯文本流）
 *   - 支持 stdin 管道输入（`crush run "..."` 接受 piped prompt）
 *   - 会话写入 <cwd>/.crush/crush.db，含 parent_session_id 拓扑
 *
 * 本 wrapper 负责：
 *   - launch：spawn `crush run <prompt> --quiet` 子进程
 *   - inject：通过 stdin 注入后续输入（管道形态）
 *   - getStream：stdout 文本流实时读取（async iterator）
 *   - extractSession：运行结束后读 crush.db 提取最新 session（消息 + 拓扑）
 *   - transferSession：构造跨 CLI 接力 handoff 包
 *
 * 设计约束：
 *   - 不直接读 Crush 私有文件做实时流（stdout 已是响应）；extractSession 只读 crush.db。
 *   - 子进程异常退出时把 stderr 收集到错误消息，便于排查。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { MessageRole, SessionMessageInput, SessionTopology } from '../store/types.js';

// node:sqlite 实验性内置，用 createRequire 运行时加载（同 store / cass 的做法）
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** Crush 二进制名（PATH 查找） */
const CRUSH_BIN = 'crush';
/** crush.db 相对项目 cwd 的路径 */
const CRUSH_DB_REL = path.join('.crush', 'crush.db');

/** launch 选项 */
export interface CrushLaunchOptions {
  /** 初始 prompt（必填） */
  prompt: string;
  /** 工作目录，默认 process.cwd() */
  cwd?: string;
  /** 模型 id（-m，接受 'model' 或 'provider/model'） */
  model?: string;
  /** 恢复已有 session（-s） */
  sessionId?: string;
  /** 继续最近 session（-C） */
  continueLast?: boolean;
  /** 静默模式（隐藏 spinner，headless 推荐 true） */
  quiet?: boolean;
  /** 超时毫秒，0 表示不超时 */
  timeoutMs?: number;
  /** 额外 CLI 参数透传 */
  extraArgs?: string[];
  /** 自定义 crush 可执行路径（默认 PATH 中的 crush） */
  bin?: string;
  /** 额外环境变量 */
  env?: Record<string, string>;
}

/** launch 返回：子进程句柄 + stdout 文本流 */
export interface CrushLaunchResult {
  /** 子进程句柄 */
  process: ChildProcess;
  /** stdout 文本流（async iterator，按 chunk yield 字符串） */
  stream: AsyncIterable<string>;
  /** 通过 stdin 注入文本（管道形态） */
  inject: (text: string) => void;
  /** 关闭 stdin（表示不再注入） */
  endInput: () => void;
  /** 等待子进程退出，返回退出码 */
  waitForExit: () => Promise<number>;
}

/** 提取出的 session 快照（从 crush.db 读取） */
export interface ExtractedCrushSession {
  /** crush session id */
  sessionId?: string;
  /** 拓扑：parent_session_id 非空 → subagent */
  topology: SessionTopology;
  /** 父 session id（subagent 拓扑时有值） */
  parentSessionId?: string;
  /** user/assistant 可显示消息 */
  messages: SessionMessageInput[];
  /** session 标题 */
  title?: string;
}

/** 跨 CLI 接力 handoff 包 */
export interface CrushHandoffPayload {
  /** 来源标识 */
  source: 'crush';
  /** 提取出的 session */
  session: ExtractedCrushSession;
  /** 拼接好的纯文本上下文（user/assistant 消息按序） */
  contextText: string;
  /** 运行期间 stdout 捕获的响应文本 */
  stdoutText: string;
  /** 构造时间戳 */
  builtAt: number;
}

/** parts 块的松散结构 */
interface PartBlock {
  type?: string;
  text?: string;
  content?: string;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 从 parts JSON 数组提取可显示文本。
 * parts 形如 [{"type":"text","text":"..."}]；兼容 {"type":"text","content":"..."}。
 */
function extractPartsText(partsJson: string): string | null {
  if (!partsJson) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(partsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const parts: string[] = [];
  for (const block of arr as PartBlock[]) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      const t = block.text ?? block.content;
      if (typeof t === 'string' && t.length > 0) parts.push(t);
    }
  }
  if (parts.length === 0) return null;
  const joined = parts.join('\n');
  return joined.trim().length > 0 ? joined : null;
}

/** 归一化 crush role；非可显示角色返回 null */
function normalizeRole(role: string): MessageRole | null {
  switch (role) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'tool':
      return role;
    default:
      return null;
  }
}

/**
 * 从 crush.db 读取最新 session（按 created_at 倒序首条）及其消息。
 * 只读打开；DB 不存在或无 session 返回 undefined。
 */
function readLatestSessionFromDb(dbPath: string): ExtractedCrushSession | undefined {
  let db: DatabaseSyncType;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    const sRow = db.prepare(
      `SELECT id, parent_session_id, title, created_at
       FROM sessions ORDER BY created_at DESC LIMIT 1`,
    ).get() as { id?: string; parent_session_id?: string | null; title?: string | null } | undefined;
    if (!sRow || !sRow.id) return undefined;

    const sessionId = sRow.id;
    const parentSessionId = sRow.parent_session_id && sRow.parent_session_id.length > 0
      ? sRow.parent_session_id
      : undefined;
    const topology: SessionTopology = parentSessionId ? 'subagent' : 'root';

    const msgRows = db.prepare(
      `SELECT role, parts, created_at, is_summary_message
       FROM messages WHERE session_id = ? ORDER BY created_at`,
    ).all(sessionId) as Array<{ role: string; parts: string; created_at: number | null; is_summary_message: number | null }>;

    const messages: SessionMessageInput[] = [];
    for (const m of msgRows) {
      if (m.is_summary_message === 1) continue; // 排除 compaction 摘要
      const role = normalizeRole(m.role);
      if (!role || (role !== 'user' && role !== 'assistant')) continue;
      const text = extractPartsText(m.parts);
      if (text === null) continue;
      messages.push({ role, content: text, timestamp: m.created_at ?? undefined });
    }

    return {
      sessionId,
      topology,
      parentSessionId,
      messages,
      title: sRow.title ?? undefined,
    };
  } finally {
    db.close();
  }
}

/**
 * Crush headless wrapper。
 *
 * 用法：
 *   const wrapper = new CrushWrapper({ cwd: '/repo' });
 *   const { stream, waitForExit } = wrapper.launch({ prompt: 'hi' });
 *   for await (const chunk of stream) { process.stdout.write(chunk); }
 *   await waitForExit();
 *   const session = await wrapper.extractSession({ cwd: '/repo' });
 */
export class CrushWrapper {
  /** 默认工作目录 */
  readonly cwd: string;

  constructor(opts: { cwd?: string } = {}) {
    this.cwd = opts.cwd ?? process.cwd();
  }

  /**
   * spawn `crush run <prompt> --quiet` 子进程，返回流 + 注入 + 等待退出的句柄。
   * stdout 输出 assistant 响应文本；stderr 收集便于错误排查。
   */
  launch(options: CrushLaunchOptions): CrushLaunchResult {
    const args: string[] = ['run'];
    if (options.quiet !== false) args.push('--quiet'); // headless 默认静默
    if (options.continueLast) args.push('--continue');
    if (options.sessionId) args.push('--session', options.sessionId);
    if (options.model) args.push('--model', options.model);
    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }
    args.push(options.prompt);

    const bin = options.bin ?? CRUSH_BIN;
    const child = spawn(bin, args, {
      cwd: options.cwd ?? this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    });

    // 收集 stderr 便于退出时报错
    let stderrBuf = '';
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        stderrBuf += d.toString('utf8');
        if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-65536);
      });
    }

    // stdout 文本流（按 chunk yield 字符串）
    const stream = (async function* (c: ChildProcess): AsyncIterable<string> {
      const stdout = c.stdout;
      if (!stdout) return;
      for await (const chunk of stdout) {
        yield chunk.toString('utf8');
      }
    })(child);

    const inject = (text: string): void => {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(text);
      }
    };
    const endInput = (): void => {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
    };

    let exitCode: number | null = null;
    let exited = false;
    const exitWaiters: Array<(code: number) => void> = [];
    child.on('exit', (code) => {
      exitCode = code ?? 0;
      exited = true;
      for (const w of exitWaiters) w(exitCode);
    });
    child.on('error', (err) => {
      stderrBuf += `\n[yondermesh] spawn error: ${errorMessage(err)}`;
      exited = true;
      for (const w of exitWaiters) w(-1);
    });

    const waitForExit = (): Promise<number> => {
      if (exited) return Promise.resolve(exitCode ?? -1);
      return new Promise<number>((resolve) => exitWaiters.push(resolve));
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      setTimeout(() => {
        if (!exited) {
          try { child.kill('SIGTERM'); } catch { /* */ }
        }
      }, options.timeoutMs);
    }

    // stderr 暴露到 child 上便于排查（闭包内累加，getter 读取）
    Object.defineProperty(child, 'stderrText', {
      get: () => stderrBuf,
    });

    return { process: child, stream, inject, endInput, waitForExit };
  }

  /**
   * 通过 `crush run --session <sessionId> --quiet <message>` 介入指定 session，
   * 同步等待子进程退出，返回 assistant 响应文本与退出码。
   *
   * 实现：spawnSync('crush', ['run', '--session', sessionId, '--quiet', message])
   *   - 默认 30s 超时（spawnSync timeout）
   *   - response = stdout
   *   - exitCode = 子进程退出码
   *
   * 注意：crush 的 stdout 是纯文本响应（非 NDJSON），直接作为 response 返回。
   */
  inject(sessionId: string, message: string): { response: string; exitCode: number } {
    const args = ['run', '--session', sessionId, '--quiet', message];
    try {
      const res = spawnSync(CRUSH_BIN, args, {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const response = (res.stdout as string) ?? '';
      const exitCode = res.status ?? -1;

      // spawn 失败（如 crush 不在 PATH）时把错误信息写入 response 便于排查
      if (res.error) {
        return {
          response: response || `[yondermesh] crush inject spawn 失败: ${res.error.message}`,
          exitCode,
        };
      }
      return { response, exitCode };
    } catch (err) {
      return {
        response: `[yondermesh] crush inject 失败: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: -1,
      };
    }
  }

  /** 返回 stdout 文本流（async iterator），供调用方实时消费 */
  getStream(handle: CrushLaunchResult): AsyncIterable<string> {
    return handle.stream;
  }

  /**
   * 运行结束后从 <cwd>/.crush/crush.db 读取最新 session（消息 + 拓扑）。
   * crush 的 stdout 是纯文本响应，结构化 session 数据在 crush.db；
   * 本方法只读打开 crush.db 提取最新 session。
   *
   * 调用时机：应在 waitForExit() 完成后调用，确保 crush 已写入 DB。
   */
  async extractSession(options: { cwd?: string; dbPath?: string } = {}): Promise<ExtractedCrushSession | undefined> {
    const dbPath = options.dbPath ?? path.join(options.cwd ?? this.cwd, CRUSH_DB_REL);
    return readLatestSessionFromDb(dbPath);
  }

  /**
   * 构造跨 CLI 接力 handoff 包：把当前 session 的消息拼接为纯文本上下文，
   * 供另一个 CLI（如 codex/claude/cline）作为 system/initial prompt 接力。
   * stdoutText 为运行期间捕获的 assistant 响应原文。
   */
  transferSession(session: ExtractedCrushSession | undefined, stdoutText: string): CrushHandoffPayload {
    const lines: string[] = [];
    lines.push(`# Crush session handoff (source: crush)`);
    if (session?.sessionId) lines.push(`session_id: ${session.sessionId}`);
    if (session?.topology === 'subagent' && session.parentSessionId) {
      lines.push(`topology: subagent (parent_session: ${session.parentSessionId})`);
    } else {
      lines.push(`topology: root`);
    }
    if (session?.title) lines.push(`title: ${session.title}`);
    lines.push('');
    const msgs = session?.messages ?? [];
    for (const m of msgs) {
      lines.push(`## ${m.role}`);
      lines.push(m.content);
      lines.push('');
    }
    return {
      source: 'crush',
      session: session ?? { topology: 'root', messages: [] },
      contextText: lines.join('\n'),
      stdoutText,
      builtAt: Date.now(),
    };
  }
}

/** Crush 默认配置目录 */
export const DEFAULT_CRUSH_CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? ''}/.config`,
  'crush',
);
