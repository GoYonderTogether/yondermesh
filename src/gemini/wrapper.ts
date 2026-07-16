/**
 * Gemini CLI wrapper — 通过 CLI 启动、注入、流式消费、提取 session
 *
 * Gemini CLI（v0.50.0）无 HTTP daemon，全部通过 CLI 接入：
 *   - 非交互流式：`gemini -p <prompt> -o stream-json`（stdout NDJSON 事件流）
 *   - 恢复 session：`gemini --resume <id|latest>` 或 `gemini --session-id <uuid>`
 *   - 加载 session 文件：`gemini --session-file <path>`
 *
 * inject（中途介入）通过启动新的 gemini 进程并 --resume 目标 session 实现。
 * getStream 复用 launch 的 stream-json stdout。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 默认 gemini CLI 名 */
const GEMINI_BIN = 'gemini';

/** launch 选项 */
export interface GeminiLaunchOptions {
  /** 工作目录，默认 process.cwd() */
  cwd?: string;
  /** 模型，对应 -m */
  model?: string;
  /** 恢复指定 session（--resume <id|latest>） */
  resumeSessionId?: string;
  /** 使用指定 UUID 新建 session（--session-id <uuid>） */
  sessionId?: string;
  /** 从 JSON 文件加载 session（--session-file <path>） */
  sessionFile?: string;
  /** 额外 CLI 参数 */
  extraArgs?: string[];
  /** 环境变量覆盖 */
  env?: Record<string, string>;
  /** YOLO 模式（自动接受所有操作） */
  yolo?: boolean;
}

/** launch 返回的流式句柄 */
export interface GeminiLaunchHandle {
  /** 子进程句柄 */
  process: ChildProcess;
  /** 异步迭代 stream-json 事件（每行一个 JSON 对象） */
  events: AsyncIterable<Record<string, unknown>>;
  /** 等待进程结束，返回退出码 */
  done: Promise<number>;
}

/** 提取的 session 上下文（用于 handoff） */
export interface GeminiSessionContext {
  sessionId: string;
  projectHash?: string;
  startTime?: number;
  model?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp?: number }>;
}

/** 查找 gemini CLI 路径（直接用名，依赖 PATH） */
function geminiBin(): string {
  return GEMINI_BIN;
}

/**
 * 启动一个非交互式 Gemini CLI 会话，返回 stream-json 事件流。
 *
 * 内部用 `gemini -p <prompt> -o stream-json`，stdout 按行产出 NDJSON 事件。
 */
export function launch(prompt: string, options: GeminiLaunchOptions = {}): GeminiLaunchHandle {
  const args: string[] = [];
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  } else if (options.sessionId) {
    args.push('--session-id', options.sessionId);
  }
  if (options.sessionFile) {
    args.push('--session-file', options.sessionFile);
  }
  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.yolo) {
    args.push('--yolo');
  }
  args.push('-p', prompt);
  args.push('-o', 'stream-json');
  if (options.extraArgs) args.push(...options.extraArgs);

  const child = spawn(geminiBin(), args, {
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
        // 非 JSON 行跳过
      }
    }
  })();

  const done = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 0));
  });

  return { process: child, events, done };
}

/**
 * 同步启动（非流式），等待 gemini 结束并返回完整 stdout。
 */
export function launchSync(prompt: string, options: GeminiLaunchOptions = {}): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const args: string[] = [];
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  } else if (options.sessionId) {
    args.push('--session-id', options.sessionId);
  }
  if (options.sessionFile) {
    args.push('--session-file', options.sessionFile);
  }
  if (options.model) args.push('-m', options.model);
  if (options.yolo) args.push('--yolo');
  args.push('-p', prompt);
  args.push('-o', 'text');
  if (options.extraArgs) args.push(...options.extraArgs);

  const result = spawnSync(geminiBin(), args, {
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
 * 向已存在的 Gemini session 注入一条消息（中途介入）。
 *
 * Gemini CLI 无 HTTP daemon，inject 通过启动新 `gemini --resume <sessionId> -p <message>`
 * 进程实现：恢复目标 session 并发送消息，返回 stream-json 事件流。
 *
 * 注意：Gemini 的 --resume 接受 "latest" 或索引数字或 session id；
 * 传入 UUID 时需确保该 session 属于当前 cwd 对应的项目。
 */
export function inject(
  sessionId: string,
  message: string,
  options: { cwd?: string; model?: string; yolo?: boolean } = {},
): GeminiLaunchHandle {
  return launch(message, {
    resumeSessionId: sessionId,
    cwd: options.cwd,
    model: options.model,
    yolo: options.yolo,
  });
}

/**
 * 获取一个 session 的流式事件。
 *
 * Gemini CLI 无持久 SSE 流，getStream 通过 `gemini --resume <id> -p "" -o stream-json`
 * 触发一次空 prompt（恢复上下文），消费其 stream-json 输出。
 * 适合在已有 session 上观察模型行为。
 */
export function getStream(
  sessionId: string,
  options: { cwd?: string; model?: string } = {},
): GeminiLaunchHandle {
  // 空 prompt 触发 session 恢复 + 模型自述
  return launch('', {
    resumeSessionId: sessionId,
    cwd: options.cwd,
    model: options.model,
    extraArgs: ['--skip-trust'],
  });
}

/**
 * 从本地 JSON 文件提取一个 session 的上下文（消息历史），用于 handoff / transfer。
 *
 * 扫描 ~/.gemini/tmp/<project>/chats/session-*.json，匹配 sessionId 字段。
 * 找不到文件返回 null。
 */
export function extractSession(
  sessionId: string,
  options: { rootPath?: string } = {},
): GeminiSessionContext | null {
  const rootPath = options.rootPath ?? path.join(os.homedir(), '.gemini', 'tmp');
  const target = findSessionFile(rootPath, sessionId);
  if (!target) return null;
  return parseSessionFile(target);
}

/** 在 rootPath 下查找包含目标 sessionId 的 session JSON 文件 */
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
      } else if (e.isFile() && e.name.startsWith('session-') && e.name.endsWith('.json')) {
        // 快速路径：文件名可能含 sessionId 前缀；否则需读 JSON 匹配
        if (e.name.includes(sessionId)) {
          result = abs;
          return;
        }
        // 读 JSON 校验 sessionId 字段
        try {
          const raw = fs.readFileSync(abs, 'utf8');
          const doc = JSON.parse(raw) as { sessionId?: string };
          if (doc.sessionId === sessionId) {
            result = abs;
            return;
          }
        } catch {
          // 脏文件跳过
        }
      }
    }
  };
  walk(rootPath);
  return result;
}

/** 解析 Gemini session JSON 文件为上下文（复用 importer 解析逻辑，精简版） */
function parseSessionFile(absPath: string): GeminiSessionContext | null {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }

  let doc: {
    sessionId?: string;
    projectHash?: string;
    startTime?: string;
    messages?: Array<{
      timestamp?: string;
      type?: string;
      content?: unknown;
      model?: string;
    }>;
  };
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }

  const ctx: GeminiSessionContext = {
    sessionId: doc.sessionId ?? path.basename(absPath, '.json'),
    messages: [],
  };
  if (doc.projectHash) ctx.projectHash = doc.projectHash;
  if (doc.startTime) {
    const ms = Date.parse(doc.startTime);
    if (!Number.isNaN(ms)) ctx.startTime = ms;
  }

  for (const m of doc.messages ?? []) {
    if (!m || typeof m.type !== 'string') continue;
    const role = m.type === 'user' ? 'user' : m.type === 'gemini' ? 'assistant' : null;
    if (!role) continue;

    let content: string | null = null;
    if (typeof m.content === 'string') {
      content = m.content.trim().length > 0 ? m.content : null;
    } else if (Array.isArray(m.content)) {
      const parts = (m.content as Array<{ text?: string }>)
        .filter((b) => b && typeof b.text === 'string')
        .map((b) => b.text as string);
      if (parts.length > 0) content = parts.join('\n');
    }
    if (!content || content.trim().length === 0) continue;

    const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
    const timestamp = Number.isNaN(ts) ? undefined : ts;

    if (ctx.model === undefined && m.type === 'gemini' && typeof m.model === 'string') {
      ctx.model = m.model;
    }

    ctx.messages.push({ role, content, timestamp });
  }

  return ctx;
}

/**
 * 构造一个 handoff 消息包，用于把 Gemini session 上下文转移到另一个 agent。
 *
 * 返回一段文本，包含 session 元数据和压缩的消息历史。
 */
export function transferSession(
  sessionId: string,
  options: { rootPath?: string; maxMessages?: number } = {},
): string {
  const ctx = extractSession(sessionId, options);
  if (!ctx) {
    return `[Gemini session ${sessionId} not found locally]`;
  }
  const max = options.maxMessages ?? 50;
  const messages = ctx.messages.slice(-max);
  const lines: string[] = [
    `# Gemini CLI session handoff`,
    ``,
    `- sessionId: ${ctx.sessionId}`,
  ];
  if (ctx.projectHash) lines.push(`- projectHash: ${ctx.projectHash}`);
  if (ctx.model) lines.push(`- model: ${ctx.model}`);
  if (ctx.startTime) lines.push(`- startTime: ${new Date(ctx.startTime).toISOString()}`);
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

/**
 * 列出本地所有 Gemini session 文件（路径 + sessionId + startTime）。
 * 用于 session picker / 转移目标选择。
 */
export function listLocalSessions(
  options: { rootPath?: string } = {},
): Array<{ path: string; sessionId: string; startTime?: number }> {
  const rootPath = options.rootPath ?? path.join(os.homedir(), '.gemini', 'tmp');
  const out: Array<{ path: string; sessionId: string; startTime?: number }> = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile() && e.name.startsWith('session-') && e.name.endsWith('.json')) {
        try {
          const raw = fs.readFileSync(abs, 'utf8');
          const doc = JSON.parse(raw) as { sessionId?: string; startTime?: string };
          const startTime = doc.startTime ? Date.parse(doc.startTime) : NaN;
          out.push({
            path: abs,
            sessionId: doc.sessionId ?? path.basename(abs, '.json'),
            startTime: Number.isNaN(startTime) ? undefined : startTime,
          });
        } catch {
          // 脏文件跳过
        }
      }
    }
  };
  walk(rootPath);
  out.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
  return out;
}
