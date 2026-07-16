/**
 * Qwen Code wrapper — 通过 CLI / HTTP API 启动、注入、流式消费、提取 session
 *
 * Qwen Code（v0.19.8）提供两种接入路径：
 *   1. CLI 非交互：`qwen -p <prompt> -o stream-json`（stream-json 输出 NDJSON 事件流）
 *   2. HTTP daemon：`qwen serve`（默认 127.0.0.1:4170，可 --token 鉴权，SSE 事件流）
 *
 * 本 wrapper 优先用 CLI（无额外依赖），inject/getStream 用 serve HTTP API（需 serve 运行）。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Qwen 默认 serve 端口（与 `qwen serve --help` 一致） */
const DEFAULT_SERVE_PORT = 4170;
/** Qwen 默认 serve 主机（loopback，免鉴权） */
const DEFAULT_SERVE_HOST = '127.0.0.1';
/** 默认 qwen CLI 名 */
const QWEN_BIN = 'qwen';

/** launch 选项 */
export interface QwenLaunchOptions {
  /** 工作目录，默认 process.cwd() */
  cwd?: string;
  /** 模型，对应 -m */
  model?: string;
  /** 恢复指定 session（-r <id>） */
  resumeSessionId?: string;
  /** 恢复最近 session（-c） */
  continueLast?: boolean;
  /** 额外 CLI 参数 */
  extraArgs?: string[];
  /** 环境变量覆盖 */
  env?: Record<string, string>;
}

/** launch 返回的流式句柄 */
export interface QwenLaunchHandle {
  /** 子进程句柄 */
  process: ChildProcess;
  /** 异步迭代 stream-json 事件（每行一个 JSON 对象） */
  events: AsyncIterable<Record<string, unknown>>;
  /** 等待进程结束，返回退出码 */
  done: Promise<number>;
}

/** serve 配置 */
export interface QwenServeConfig {
  host?: string;
  port?: number;
  /** Bearer token（--token 或 QWEN_SERVER_TOKEN） */
  token?: string;
}

/** 提取的 session 上下文（用于 handoff） */
export interface QwenSessionContext {
  sessionId: string;
  cwd?: string;
  model?: string;
  cliVersion?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: number }>;
}

/** 查找 qwen CLI 路径（直接用名，依赖 PATH） */
function qwenBin(): string {
  return QWEN_BIN;
}

/** 构建 serve base URL */
function serveBaseUrl(config: QwenServeConfig): string {
  const host = config.host ?? DEFAULT_SERVE_HOST;
  const port = config.port ?? DEFAULT_SERVE_PORT;
  return `http://${host}:${port}`;
}

/** 构建 serve 请求的 headers（含 token 鉴权） */
function serveHeaders(config: QwenServeConfig): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = config.token ?? process.env.QWEN_SERVER_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * 启动一个非交互式 Qwen Code 会话，返回 stream-json 事件流。
 *
 * 内部用 `qwen -p <prompt> -o stream-json`，stdout 按行产出 NDJSON 事件。
 * 进程退出码非 0 时 done Promise 仍 resolve（调用方自行判断）。
 */
export function launch(prompt: string, options: QwenLaunchOptions = {}): QwenLaunchHandle {
  const args: string[] = [];
  if (options.resumeSessionId) {
    args.push('-r', options.resumeSessionId);
  } else if (options.continueLast) {
    args.push('-c');
  }
  if (options.model) {
    args.push('-m', options.model);
  }
  args.push('-p', prompt);
  args.push('-o', 'stream-json');
  if (options.extraArgs) args.push(...options.extraArgs);

  const child = spawn(qwenBin(), args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
  });

  const events = (async function* (): AsyncIterable<Record<string, unknown>> {
    if (!child.stdout) return;
    const rl = createInterface({ input: child.stdout });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // 非 JSON 行跳过（如调试输出）
      }
    }
  })();

  const done = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 0));
  });

  return { process: child, events, done };
}

/**
 * 同步启动（非流式），等待 qwen 结束并返回完整 stdout。
 * 适合一次性短任务，不需要消费流。
 */
export function launchSync(prompt: string, options: QwenLaunchOptions = {}): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const args: string[] = [];
  if (options.resumeSessionId) {
    args.push('-r', options.resumeSessionId);
  } else if (options.continueLast) {
    args.push('-c');
  }
  if (options.model) args.push('-m', options.model);
  args.push('-p', prompt);
  args.push('-o', 'text');
  if (options.extraArgs) args.push(...options.extraArgs);

  const result = spawnSync(qwenBin(), args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

/**
 * 探测 `qwen serve` 是否在运行。
 * 返回 serve 是否可达。
 */
export async function detectServe(config: QwenServeConfig = {}): Promise<boolean> {
  try {
    const resp = await fetch(`${serveBaseUrl(config)}/health`, {
      headers: serveHeaders(config),
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * 向运行中的 `qwen serve` 注入一条消息（中途介入）。
 *
 * 通过 POST /v1/sessions/:id/messages 发送消息，返回 SSE 流。
 * 需要先 `qwen serve` 启动且有对应 session。
 *
 * 返回 SSE 事件的异步迭代器；serve 不可达时抛错。
 */
export async function inject(
  sessionId: string,
  message: string,
  config: QwenServeConfig = {},
): Promise<AsyncIterable<Record<string, unknown>>> {
  const url = `${serveBaseUrl(config)}/v1/sessions/${encodeURIComponent(sessionId)}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: serveHeaders(config),
    body: JSON.stringify({ message }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`qwen serve inject 失败 (${resp.status}): ${body}`);
  }
  if (!resp.body) {
    throw new Error('qwen serve inject 返回空 body');
  }
  return parseSseStream(resp.body);
}

/**
 * 获取运行中 session 的 SSE 事件流。
 * 连接 GET /v1/sessions/:id/stream，持续接收事件直到连接关闭。
 */
export async function getStream(
  sessionId: string,
  config: QwenServeConfig = {},
): Promise<AsyncIterable<Record<string, unknown>>> {
  const url = `${serveBaseUrl(config)}/v1/sessions/${encodeURIComponent(sessionId)}/stream`;
  const resp = await fetch(url, {
    headers: serveHeaders(config),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`qwen serve getStream 失败 (${resp.status}): ${body}`);
  }
  if (!resp.body) {
    throw new Error('qwen serve getStream 返回空 body');
  }
  return parseSseStream(resp.body);
}

/**
 * 解析 SSE 流（fetch ReadableStream）为异步事件迭代器。
 * SSE 格式：`data: <json>\n\n`；多行 data 用 \n 拼接。
 */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6));
        } else if (line.trim() === '' && dataLines.length > 0) {
          const joined = dataLines.join('\n');
          dataLines = [];
          if (joined === '[DONE]') return;
          try {
            yield JSON.parse(joined) as Record<string, unknown>;
          } catch {
            // 非 JSON data 跳过
          }
        }
      }
    }
    // flush 残留
    if (dataLines.length > 0) {
      const joined = dataLines.join('\n');
      try {
        yield JSON.parse(joined) as Record<string, unknown>;
      } catch {
        // 残留非 JSON，忽略
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 从本地 JSONL 文件提取一个 session 的上下文（消息历史），用于 handoff / transfer。
 *
 * 扫描 ~/.qwen/projects/<project>/chats/<sessionId>.jsonl，解析 user/assistant 可显示消息。
 * 找不到文件返回 null。
 */
export function extractSession(
  sessionId: string,
  options: { rootPath?: string } = {},
): QwenSessionContext | null {
  const rootPath = options.rootPath ?? path.join(os.homedir(), '.qwen', 'projects');
  const target = findSessionFile(rootPath, sessionId);
  if (!target) return null;
  return parseSessionFile(target);
}

/** 在 rootPath 下查找 chats/<sessionId>.jsonl 文件 */
function findSessionFile(rootPath: string, sessionId: string): string | null {
  let result: string | null = null;
  const walk = (dir: string): void => {
    if (result) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (result) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile() && e.name === `${sessionId}.jsonl`) {
        result = abs;
      }
    }
  };
  walk(rootPath);
  return result;
}

/** 解析 Qwen JSONL session 文件为上下文（复用 importer 的解析逻辑，精简版） */
function parseSessionFile(absPath: string): QwenSessionContext | null {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }

  const ctx: QwenSessionContext = { sessionId: '', messages: [] };
  let earliest: number | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (ctx.sessionId === '' && typeof obj.sessionId === 'string') {
      ctx.sessionId = obj.sessionId;
    }
    if (ctx.cwd === undefined && typeof obj.cwd === 'string') ctx.cwd = obj.cwd;
    if (ctx.cliVersion === undefined && typeof obj.version === 'string') ctx.cliVersion = obj.version;
    if (ctx.model === undefined && typeof obj.model === 'string') ctx.model = obj.model;

    const ts =
      typeof obj.timestamp === 'string' && obj.timestamp.length > 0
        ? Date.parse(obj.timestamp)
        : NaN;
    const timestamp = Number.isNaN(ts) ? undefined : ts;
    if (timestamp !== undefined && (earliest === undefined || timestamp < earliest)) {
      earliest = timestamp;
    }

    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const message = obj.message as { parts?: unknown } | undefined;
    if (!message || !Array.isArray(message.parts)) continue;
    const parts = message.parts as Array<{ text?: string; thought?: boolean }>;
    const texts: string[] = [];
    for (const p of parts) {
      if (p && p.thought !== true && typeof p.text === 'string') texts.push(p.text);
    }
    if (texts.length === 0) continue;
    const content = texts.join('\n');
    if (content.trim().length === 0) continue;
    ctx.messages.push({
      role: obj.type === 'assistant' ? 'assistant' : 'user',
      content,
      timestamp,
    });
  }

  if (ctx.sessionId === '') ctx.sessionId = path.basename(absPath, '.jsonl');
  return ctx;
}

/**
 * 构造一个 handoff 消息包，用于把 Qwen session 上下文转移到另一个 agent。
 *
 * 返回一段文本，包含 session 元数据和压缩的消息历史，
 * 可作为另一个 agent 的 prompt 前缀注入。
 */
export function transferSession(
  sessionId: string,
  options: { rootPath?: string; maxMessages?: number } = {},
): string {
  const ctx = extractSession(sessionId, options);
  if (!ctx) {
    return `[Qwen session ${sessionId} not found locally]`;
  }
  const max = options.maxMessages ?? 50;
  const messages = ctx.messages.slice(-max);
  const lines: string[] = [
    `# Qwen Code session handoff`,
    ``,
    `- sessionId: ${ctx.sessionId}`,
  ];
  if (ctx.cwd) lines.push(`- cwd: ${ctx.cwd}`);
  if (ctx.model) lines.push(`- model: ${ctx.model}`);
  if (ctx.cliVersion) lines.push(`- cliVersion: ${ctx.cliVersion}`);
  lines.push(`- messages: ${ctx.messages.length} (last ${messages.length} shown)`);
  lines.push(``);
  for (const m of messages) {
    lines.push(`## ${m.role}`);
    if (m.timestamp) lines.push(`_timestamp: ${new Date(m.timestamp).toISOString()}_`);
    lines.push(m.content);
    lines.push(``);
  }
  return lines.join('\n');
}
