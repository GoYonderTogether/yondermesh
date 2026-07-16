/**
 * Cline headless wrapper —— `cline --json` 子进程封装
 *
 * Cline 是多形态（CLI + VS Code + SDK），CLI 提供 `--json` headless 模式，
 * 输出 NDJSON 流，含 `parentAgentId`（subagent 拓扑）。本 wrapper 负责：
 *   - launch：spawn `cline --json <prompt>` 子进程
 *   - inject：解析 NDJSON 流，通过 stdin 注入后续 prompt
 *   - getStream：NDJSON 流实时读取（async iterator）
 *   - extractSession：把流聚合为 session 快照（消息 + 拓扑）
 *   - transferSession：构造跨 CLI 接力 handoff 包
 *
 * 设计约束：
 *   - 不直接读 Cline 私有文件；只通过子进程 stdout 拿数据（架构 §2）。
 *   - NDJSON 每行一个 JSON 事件；脏行跳过，不中断流。
 *   - 子进程异常退出时把 stderr 收集到错误消息，便于排查。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessageRole, SessionMessageInput, SessionTopology } from '../store/types.js';

/** Cline 二进制名（PATH 查找） */
const CLINE_BIN = 'cline';

/** thinking 等级 */
export type ClineThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/** launch 选项 */
export interface ClineLaunchOptions {
  /** 初始 prompt（必填） */
  prompt: string;
  /** 工作目录，默认 process.cwd() */
  cwd?: string;
  /** 模型 id（-m） */
  model?: string;
  /** provider id（-P），默认 cline */
  provider?: string;
  /** 恢复已有 session（--id） */
  sessionId?: string;
  /** 覆盖默认 system prompt（-s） */
  systemPrompt?: string;
  /** 自动批准工具调用，默认 true（headless 必须开启） */
  autoApprove?: boolean;
  /** reasoning effort 等级（--thinking） */
  thinking?: ClineThinkingLevel;
  /** 超时毫秒，0 表示不超时 */
  timeoutMs?: number;
  /** 额外 CLI 参数透传 */
  extraArgs?: string[];
  /** 自定义 cline 可执行路径（默认 PATH 中的 cline） */
  bin?: string;
  /** 额外环境变量 */
  env?: Record<string, string>;
}

/** 一条 NDJSON 事件（松散结构，按需读字段） */
export interface ClineNdjsonEvent {
  type?: string;
  sessionId?: string;
  session_id?: string;
  parentAgentId?: string;
  parent_agent_id?: string;
  agentId?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  isMeta?: boolean;
  [k: string]: unknown;
}

/** launch 返回：子进程句柄 + NDJSON 流迭代器 */
export interface ClineLaunchResult {
  /** 子进程句柄 */
  process: ChildProcess;
  /** NDJSON 事件流（async iterator） */
  stream: AsyncIterable<ClineNdjsonEvent>;
  /** 注入一条 prompt 到 stdin */
  inject: (text: string) => void;
  /** 关闭 stdin（表示不再注入） */
  endInput: () => void;
  /** 等待子进程退出，返回退出码 */
  waitForExit: () => Promise<number>;
}

/** 提取出的 session 快照 */
export interface ExtractedClineSession {
  /** cline session id（从事件流首条带 sessionId 的事件提取） */
  sessionId?: string;
  /** 拓扑：有 parentAgentId → subagent；否则 root */
  topology: SessionTopology;
  /** 父 agent id（subagent 拓扑时有值） */
  parentAgentId?: string;
  /** user/assistant 可显示消息 */
  messages: SessionMessageInput[];
  /** 子 agent 拓扑：parentAgentId → 子 session 列表（parentAgentId 出现的子 agent） */
  subagents: Array<{ agentId?: string; sessionId?: string }>;
  /** 事件总数 */
  eventCount: number;
}

/** 跨 CLI 接力 handoff 包 */
export interface ClineHandoffPayload {
  /** 来源标识 */
  source: 'cline';
  /** 提取出的 session */
  session: ExtractedClineSession;
  /** 拼接好的纯文本上下文（user/assistant 消息按序） */
  contextText: string;
  /** 构造时间戳 */
  builtAt: number;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 解析 ISO 时间戳为 epoch 毫秒；非法/缺失返回 undefined */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** content 块的松散结构 */
interface ContentBlock {
  type?: string;
  text?: string;
}

/**
 * 从一条 NDJSON 事件提取可显示文本。
 *   - isMeta 跳过
 *   - role 非 user/assistant 跳过
 *   - content 字符串 / content 数组只取 text 块
 */
function extractDisplayText(event: ClineNdjsonEvent): { role: MessageRole; content: string } | null {
  if (event.isMeta === true) return null;
  const message = event.message;
  if (!message) return null;
  const role = typeof message.role === 'string' ? message.role : undefined;
  if (role !== 'user' && role !== 'assistant') return null;

  const content = message.content;
  let text: string | null = null;
  if (typeof content === 'string') {
    text = content.trim().length > 0 ? content : null;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as ContentBlock[]) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) {
      const joined = parts.join('\n');
      text = joined.trim().length > 0 ? joined : null;
    }
  }
  if (text === null) return null;
  return { role, content: text };
}

/**
 * 把 child.stdout 的字节流切分成 NDJSON 行，逐行 JSON.parse，
 * yield 出合法事件；脏行跳过。流结束时迭代器结束。
 */
async function* ndjsonStream(child: ChildProcess): AsyncIterable<ClineNdjsonEvent> {
  const stdout = child.stdout;
  if (!stdout) return;
  let buffer = '';
  for await (const chunk of stdout) {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as ClineNdjsonEvent;
      } catch {
        // 脏行跳过，不中断流
      }
    }
  }
  // 处理尾部残余
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as ClineNdjsonEvent;
    } catch {
      /* 尾部脏行忽略 */
    }
  }
}

/**
 * Cline headless wrapper。
 *
 * 用法：
 *   const wrapper = new ClineWrapper();
 *   const { process, stream, inject, waitForExit } = wrapper.launch({ prompt: 'hi' });
 *   for await (const ev of stream) { ... }
 *   const code = await waitForExit();
 */
export class ClineWrapper {
  /** 默认工作目录 */
  readonly cwd: string;

  constructor(opts: { cwd?: string } = {}) {
    this.cwd = opts.cwd ?? process.cwd();
  }

  /**
   * spawn `cline --json <prompt>` 子进程，返回流 + 注入 + 等待退出的句柄。
   * 子进程 stdout 输出 NDJSON，stderr 收集便于错误排查。
   */
  launch(options: ClineLaunchOptions): ClineLaunchResult {
    const args: string[] = ['--json'];
    if (options.autoApprove !== undefined) {
      args.push('--auto-approve', options.autoApprove ? 'true' : 'false');
    } else {
      args.push('--auto-approve', 'true'); // headless 默认开启
    }
    if (options.sessionId) {
      args.push('--id', options.sessionId);
    }
    if (options.provider) {
      args.push('-P', options.provider);
    }
    if (options.model) {
      args.push('-m', options.model);
    }
    if (options.systemPrompt) {
      args.push('-s', options.systemPrompt);
    }
    if (options.thinking) {
      args.push('--thinking', options.thinking);
    }
    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }
    args.push(options.prompt);

    const bin = options.bin ?? CLINE_BIN;
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
        // 防止 stderr 无限增长（截断到 64KB）
        if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-65536);
      });
    }

    const stream = ndjsonStream(child);

    const inject = (text: string): void => {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(text + '\n');
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
      // spawn 失败（如 cline 不在 PATH）
      stderrBuf += `\n[yondermesh] spawn error: ${errorMessage(err)}`;
      exited = true;
      for (const w of exitWaiters) w(-1);
    });

    const waitForExit = (): Promise<number> => {
      if (exited) return Promise.resolve(exitCode ?? -1);
      return new Promise<number>((resolve) => exitWaiters.push(resolve));
    };

    // 超时强制结束
    if (options.timeoutMs && options.timeoutMs > 0) {
      setTimeout(() => {
        if (!exited) {
          try { child.kill('SIGTERM'); } catch { /* */ }
        }
      }, options.timeoutMs);
    }

    // 把 stderr 暴露到 child 上便于调用方排查（闭包内累加，getter 读取）
    Object.defineProperty(child, 'stderrText', {
      get: () => stderrBuf,
    });

    return { process: child, stream, inject, endInput, waitForExit };
  }

  /**
   * 通过 `cline --json --id <sessionId> --auto-approve true <message>` 介入指定 session，
   * 同步等待子进程退出，解析 NDJSON 提取 assistant 消息文本作为 response。
   *
   * 实现：spawnSync('cline', ['--json', '--id', sessionId, '--auto-approve', 'true', message])
   *   - 默认 30s 超时（spawnSync timeout）
   *   - 解析 stdout 每行 NDJSON，用 extractDisplayText 提取 assistant 文本
   *   - response = 所有 assistant 消息文本拼接（多条用 \n 连接）
   *   - exitCode = 子进程退出码
   */
  inject(sessionId: string, message: string): { response: string; exitCode: number } {
    const args = ['--json', '--id', sessionId, '--auto-approve', 'true', message];
    try {
      const res = spawnSync(CLINE_BIN, args, {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const stdout = (res.stdout as string) ?? '';
      const exitCode = res.status ?? -1;

      // 解析 NDJSON，提取 assistant 消息文本作为 response
      const parts: string[] = [];
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed) as ClineNdjsonEvent;
          const msg = extractDisplayText(ev);
          if (msg !== null && msg.role === 'assistant') {
            parts.push(msg.content);
          }
        } catch {
          // 脏行跳过，不中断解析
        }
      }
      const response = parts.join('\n');

      // spawn 失败（如 cline 不在 PATH）时把错误信息写入 response 便于排查
      if (res.error) {
        return {
          response: response || `[yondermesh] cline inject spawn 失败: ${res.error.message}`,
          exitCode,
        };
      }
      return { response, exitCode };
    } catch (err) {
      return {
        response: `[yondermesh] cline inject 失败: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: -1,
      };
    }
  }

  /** 返回 NDJSON 流（async iterator），供调用方实时消费 */
  getStream(handle: ClineLaunchResult): AsyncIterable<ClineNdjsonEvent> {
    return handle.stream;
  }

  /**
   * 把 NDJSON 事件流聚合为 session 快照。
   *   - sessionId 取首条带 sessionId 的事件
   *   - topology：出现 parentAgentId → subagent
   *   - 消息：user/assistant 可显示文本按序
   *   - subagents：记录所有出现的 parentAgentId 关系（subagent 拓扑发现）
   *
   * 该方法会消费整个流直到结束。
   */
  async extractSession(handle: ClineLaunchResult): Promise<ExtractedClineSession> {
    const messages: SessionMessageInput[] = [];
    const subagents: Array<{ agentId?: string; sessionId?: string }> = [];
    let sessionId: string | undefined;
    let topology: SessionTopology = 'root';
    let parentAgentId: string | undefined;
    let eventCount = 0;

    for await (const ev of handle.stream) {
      eventCount++;
      if (sessionId === undefined) {
        sessionId = ev.sessionId ?? ev.session_id;
      }
      if (ev.parentAgentId || ev.parent_agent_id) {
        parentAgentId = ev.parentAgentId ?? ev.parent_agent_id;
        topology = 'subagent';
      }
      if (ev.agentId && topology === 'subagent') {
        subagents.push({ agentId: ev.agentId, sessionId: ev.sessionId ?? ev.session_id });
      }
      const msg = extractDisplayText(ev);
      if (msg !== null) {
        messages.push({ role: msg.role, content: msg.content, timestamp: parseTimestamp(ev.timestamp) });
      }
    }

    return { sessionId, topology, parentAgentId, messages, subagents, eventCount };
  }

  /**
   * 构造跨 CLI 接力 handoff 包：把当前 session 的消息拼接为纯文本上下文，
   * 供另一个 CLI（如 codex/claude）作为 system/initial prompt 接力。
   */
  transferSession(session: ExtractedClineSession): ClineHandoffPayload {
    const lines: string[] = [];
    lines.push(`# Cline session handoff (source: cline)`);
    if (session.sessionId) lines.push(`session_id: ${session.sessionId}`);
    if (session.topology === 'subagent' && session.parentAgentId) {
      lines.push(`topology: subagent (parent_agent: ${session.parentAgentId})`);
    } else {
      lines.push(`topology: root`);
    }
    lines.push('');
    for (const m of session.messages) {
      lines.push(`## ${m.role}`);
      lines.push(m.content);
      lines.push('');
    }
    return {
      source: 'cline',
      session,
      contextText: lines.join('\n'),
      builtAt: Date.now(),
    };
  }
}

/** Cline 默认数据目录（与 importer 一致，便于 wrapper 复用） */
export const DEFAULT_CLINE_DATA_DIR = path.join(os.homedir(), '.cline');
