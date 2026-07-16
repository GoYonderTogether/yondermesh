/**
 * Copilot CLI / SDK wrapper —— 程序化控制 Copilot 启动、介入、流式获取
 *
 * 提供五个核心能力（D1-D10 中 D6 介入 / D7 接管 / D8 流式）：
 *   - launch(prompt)         : 通过 `copilot -p <prompt> --output-format json` 启动非交互 session
 *   - inject(sessionId, msg) : 通过 `copilot --connect=<sessionId>` 中途介入正在运行的 session
 *   - getStream(sessionId)   : 实时 tail events.jsonl（SDK 流式事件来源）
 *   - listSessions()         : 扫描 ~/.copilot/session-state/<uuid>/ 列出所有 session
 *   - extractSession / transferSession : 提取并跨设备转交一个 session 的完整状态
 *
 * 设计取舍：
 *   - 默认走 CLI（`copilot` 二进制必须在本机 PATH），SDK 是可选增强路径
 *     （@github/copilot-sdk@1.0.6 捆绑 v1.0.70，仅在显式 enableSdk=true 时尝试加载）
 *   - 不阻塞：launch/inject/getStream 全部异步，返回事件流或子进程句柄
 *   - 不写入 Copilot 私有 session 文件：所有读取只读，转交时仅复制原始文件
 *   - native session id = ~/.copilot/session-state/<uuid>/ 的目录名（与
 *     events.jsonl 中 session.start.data.sessionId 一致）
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  resolveCopilotHomePath,
  resolveCopilotSessionStatePath,
} from './importer.js';

/** wrapper 选项 */
export interface CopilotWrapperOptions {
  /** Copilot home 目录，默认 ~/.copilot */
  homePath?: string;
  /** copilot 二进制名（默认 'copilot'，需在 PATH） */
  copilotBin?: string;
  /** 默认 cwd，默认 process.cwd() */
  cwd?: string;
  /** 是否优先使用 @github/copilot-sdk（默认 false，CLI 路径优先；SDK 路径需手动启用） */
  enableSdk?: boolean;
  /** 额外环境变量（如 GLM-5.2 BYOK：COPILOT_PROVIDER_TYPE / COPILOT_PROVIDER_BASE_URL） */
  env?: Record<string, string>;
}

/** session 列表项 */
export interface CopilotSessionListItem {
  /** native session id（= 目录名 uuid） */
  sessionId: string;
  /** session 目录绝对路径 */
  sessionDir: string;
  /** events.jsonl 绝对路径（可能不存在） */
  eventsPath: string;
  /** workspace.yaml 绝对路径（可能不存在） */
  workspacePath: string;
  /** events.jsonl 最后修改时间（epoch ms），缺失时为目录 mtime */
  lastModified: number;
  /** events.jsonl 文件大小（字节），不存在为 0 */
  eventsSize: number;
  /** workspace.yaml 中解析出的 cwd */
  cwd?: string;
  /** workspace.yaml 中解析出的 git_root */
  gitRoot?: string;
  /** workspace.yaml 中解析出的 branch */
  branch?: string;
  /** workspace.yaml 中 client_name === 'sdk' → true */
  isSdk: boolean;
  /** workspace.yaml 中 name 字段（如有） */
  name?: string;
}

/** launch 返回结果 */
export interface CopilotLaunchResult {
  /** 启动的子进程（用于 stdin 注入后续消息 / kill） */
  child: ChildProcessWithoutNullStreams;
  /** 启动后立即返回的 native session id（如能从早期事件解析）；否则需调用方监听 stdout */
  sessionId?: string;
  /** 已发出的 prompt */
  prompt: string;
}

/** 流式事件回调（getStream） */
export interface CopilotStreamCallbacks {
  /** 收到一行 JSON 事件时触发 */
  onEvent: (event: unknown) => void;
  /** 进程 stderr 输出（日志/错误） */
  onError?: (chunk: string) => void;
  /** 进程退出时触发，code 为退出码 */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** extractSession 返回的 session 完整快照 */
export interface CopilotSessionExtract {
  /** native session id */
  sessionId: string;
  /** 原始 events.jsonl 文本（完整） */
  eventsRaw: string;
  /** 原始 workspace.yaml 文本（缺失为空串） */
  workspaceRaw: string;
  /** 解析出的事件总数 */
  eventCount: number;
  /** 解析出的消息数（user + assistant） */
  messageCount: number;
  /** 提取时间戳（epoch ms） */
  extractedAt: number;
  /** 来源目录绝对路径 */
  sourceDir: string;
}

/** SDK 句柄（动态加载 @github/copilot-sdk，可选） */
interface SdkHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  start: (opts: any) => Promise<{ messages: AsyncIterable<unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stop?: () => Promise<any>;
}

const SESSION_STATE_SEGMENT = 'session-state';
const EVENTS_FILENAME = 'events.jsonl';
const WORKSPACE_FILENAME = 'workspace.yaml';

const nodeRequire = createRequire(import.meta.url);

/** 极简 YAML 解析（与 importer.ts 同源，避免循环依赖） */
function parseWorkspaceYamlLight(content: string): {
  cwd?: string;
  gitRoot?: string;
  branch?: string;
  clientName?: string;
  name?: string;
} {
  const out: { cwd?: string; gitRoot?: string; branch?: string; clientName?: string; name?: string } = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length === 0 || value === 'null' || value === '~') continue;
    if (key === 'cwd') out.cwd = value;
    else if (key === 'git_root') out.gitRoot = value;
    else if (key === 'branch') out.branch = value;
    else if (key === 'client_name') out.clientName = value;
    else if (key === 'name') out.name = value;
  }
  return out;
}

/**
 * Copilot wrapper。
 *
 * 用法：
 *   const w = new CopilotWrapper({ enableSdk: false });
 *   const { child } = await w.launch('hello');
 *   await w.inject(sessionId, 'follow-up question');
 *   for await (const ev of w.streamSession(sessionId)) { ... }
 */
export class CopilotWrapper {
  readonly options: Required<Omit<CopilotWrapperOptions, 'env' | 'enableSdk'>> & {
    env: Record<string, string>;
    enableSdk: boolean;
  };

  constructor(options: CopilotWrapperOptions = {}) {
    this.options = {
      homePath: options.homePath ?? resolveCopilotHomePath(),
      copilotBin: options.copilotBin ?? 'copilot',
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? {},
      enableSdk: options.enableSdk ?? false,
    };
  }

  /** session-state 根目录（~/.copilot/session-state/） */
  get sessionStatePath(): string {
    return path.join(this.options.homePath, SESSION_STATE_SEGMENT);
  }

  // ─── launch ──────────────────────────────────────────────────────────

  /**
   * 启动一个新的非交互 Copilot session。
   *
   * 实现：spawn `copilot -p <prompt> --allow-all-tools --output-format json`
   *   - `--allow-all-tools` 非交互模式必需（无人在场确认）
   *   - `--output-format json` 输出 JSONL 流（每行一个事件，便于 stream parsing）
   *   - `--stream on` 默认开（Copilot 默认即流式输出，显式更稳）
   *
   * 返回子进程句柄；调用方可：
   *   - 监听 child.stdout 逐行解析 JSON 事件
   *   - 通过 child.stdin 写入后续消息（仅 --connect 模式生效；非交互模式不读 stdin）
   *   - child.kill() 终止
   *
   * sessionId 字段：如能从早期 stdout 行解析到 session.start.data.sessionId，回填。
   * 否则为 undefined；调用方可改用 listSessions() + 最新 startedAt 反查。
   */
  async launch(prompt: string, opts: { cwd?: string; model?: string } = {}): Promise<CopilotLaunchResult> {
    const args = [
      '-p', prompt,
      '--allow-all-tools',
      '--output-format', 'json',
      '--stream', 'on',
    ];
    if (opts.model) {
      args.push('--model', opts.model);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    const child = spawn(this.options.copilotBin, args, {
      cwd: opts.cwd ?? this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 异步解析 session.start.data.sessionId（不阻塞返回）
    let sessionId: string | undefined;
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as { type?: string; data?: { sessionId?: unknown } };
          if (obj.type === 'session.start' && obj.data && typeof obj.data.sessionId === 'string') {
            sessionId = obj.data.sessionId;
          }
        } catch {
          // 单行非 JSON → 忽略
        }
      }
    });

    return { child, sessionId, prompt };
  }

  // ─── inject ─────────────────────────────────────────────────────────

  /**
   * 通过 `copilot --connect=<sessionId>` 介入正在运行的 Copilot session，
   * 注入一条消息并等待子进程退出，返回 assistant 响应文本与退出码。
   *
   * 实现：
   *   - spawn `copilot --connect=<sessionId>`
   *   - 通过 child.stdin.write(message + '\n') 注入消息，随后 end stdin
   *   - 累积 child.stdout 数据为 response 字符串
   *   - 等 child close 事件拿 exitCode
   *   - 默认 30s 超时保护，超时 kill 子进程并返回已累积的 response
   *
   * 注意：
   *   - sessionId 必须已存在（即 ~/.copilot/session-state/<uuid>/ 中已有 events.jsonl）
   *   - 介入模式默认交互模式（terminal），stdin 结束后 copilot 处理完消息即退出
   */
  async inject(
    sessionId: string,
    message: string,
  ): Promise<{ response: string; exitCode: number }> {
    const args = [`--connect=${sessionId}`];
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    const child = spawn(this.options.copilotBin, args, {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 累积 stdout 作为 response
    let response = '';
    child.stdout.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
    });

    // 注入消息并结束 stdin（让 copilot 处理完消息后退出）
    if (message && message.length > 0) {
      child.stdin.write(message + '\n');
    }
    child.stdin.end();

    // 超时保护（默认 30s）
    const timeoutMs = 30_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs);

    let spawnError = '';
    const exitCode: number = await new Promise<number>((resolve) => {
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 0);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        spawnError = err.message;
        resolve(-1);
      });
    });

    // spawn 失败时把错误信息写入 response 便于排查
    if (spawnError) {
      return {
        response: response || `[yondermesh] copilot inject spawn 失败: ${spawnError}`,
        exitCode,
      };
    }
    if (timedOut) {
      return {
        response: response + `\n[yondermesh] copilot inject 超时 (${timeoutMs}ms)，已 kill 子进程`,
        exitCode,
      };
    }
    return { response, exitCode };
  }

  // ─── getStream / streamSession ───────────────────────────────────────

  /**
   * 实时 tail 一个 session 的 events.jsonl，按行回调事件。
   *
   * 实现：fs.watch + 顺序读取（offset 累积），不依赖 copilot CLI 进程。
   * 即使原 Copilot 进程已退出，仍可继续读取历史事件。
   *
   * 配合 SDK 时，可改为调用 `@github/copilot-sdk` 的 streaming API（onUserPromptSubmitted
   * 等 3 个 hook 回调），但 CLI 的 events.jsonl 文件流是更稳定的来源。
   */
  async getStream(
    sessionId: string,
    callbacks: CopilotStreamCallbacks,
    opts: { fromByte?: number; maxEvents?: number } = {},
  ): Promise<{ stop: () => void; promise: Promise<void> }> {
    const eventsPath = path.join(this.sessionStatePath, sessionId, EVENTS_FILENAME);
    let offset = opts.fromByte ?? 0;
    let stopped = false;
    let eventCount = 0;

    const processChunk = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const lines = text.split('\n');
      // 末尾可能是不完整行 → 留待下次拼接（简化处理：要求每次 read 后按行分割）
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          callbacks.onEvent(obj);
          eventCount++;
          if (opts.maxEvents && eventCount >= opts.maxEvents) {
            stopped = true;
            watcher.close();
            return;
          }
        } catch {
          // 脏行 / 不完整 JSON → 跳过
        }
      }
    };

    // 初始读
    const fd = fs.openSync(eventsPath, 'r');
    const initialBuf = Buffer.alloc(64 * 1024);
    try {
      while (true) {
        if (stopped) break;
        const bytesRead = fs.readSync(fd, initialBuf, 0, initialBuf.length, offset);
        if (bytesRead === 0) break;
        processChunk(initialBuf.slice(0, bytesRead));
        offset += bytesRead;
      }
    } finally {
      fs.closeSync(fd);
    }

    if (stopped) {
      return { stop: () => {}, promise: Promise.resolve() };
    }

    const watcher = fs.watch(eventsPath, (eventType) => {
      if (stopped) return;
      if (eventType !== 'change') return;
      try {
        const fd2 = fs.openSync(eventsPath, 'r');
        try {
          const buf = Buffer.alloc(64 * 1024);
          while (true) {
            if (stopped) break;
            const bytesRead = fs.readSync(fd2, buf, 0, buf.length, offset);
            if (bytesRead === 0) break;
            processChunk(buf.slice(0, bytesRead));
            offset += bytesRead;
          }
        } finally {
          fs.closeSync(fd2);
        }
      } catch {
        // 读取失败 → 等待下次 watch 事件
      }
    });

    const stop = (): void => {
      stopped = true;
      try {
        watcher.close();
      } catch {
        // ignore
      }
    };

    const promise = new Promise<void>((resolve) => {
      watcher.on('close', () => resolve());
    });

    return { stop, promise };
  }

  /**
   * 异步迭代器形式：逐个 yield events.jsonl 中的事件。
   * 配合 for-await-of 使用更自然；返回的对象需调用 .stop() 终止。
   */
  async *streamSession(
    sessionId: string,
    opts: { fromByte?: number; maxEvents?: number } = {},
  ): AsyncGenerator<unknown, void, unknown> {
    const queue: unknown[] = [];
    let done = false;
    let resolveWait: (() => void) | null = null;

    const { stop } = await this.getStream(
      sessionId,
      {
        onEvent: (ev) => {
          queue.push(ev);
          resolveWait?.();
          resolveWait = null;
        },
      },
      opts,
    );

    try {
      while (!done) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            resolveWait = r;
          });
        }
        while (queue.length > 0) {
          const ev = queue.shift();
          if (ev !== undefined) yield ev;
        }
      }
    } finally {
      done = true;
      stop();
    }
  }

  // ─── listSessions ────────────────────────────────────────────────────

  /**
   * 扫描 ~/.copilot/session-state/<uuid>/ 列出所有本地 session。
   * 不读 events.jsonl 内容，仅按目录 / 文件 mtime + workspace.yaml 元数据。
   * 排序：按 lastModified 倒序（最新在前）。
   */
  listSessions(): CopilotSessionListItem[] {
    const root = this.sessionStatePath;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: CopilotSessionListItem[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sessionDir = path.join(root, e.name);
      const eventsPath = path.join(sessionDir, EVENTS_FILENAME);
      const workspacePath = path.join(sessionDir, WORKSPACE_FILENAME);

      let eventsStat: fs.Stats | undefined;
      try {
        eventsStat = fs.statSync(eventsPath);
      } catch {
        eventsStat = undefined;
      }
      const dirStat = fs.statSync(sessionDir);

      let workspaceRaw = '';
      try {
        workspaceRaw = fs.readFileSync(workspacePath, 'utf8');
      } catch {
        // workspace.yaml 缺失
      }
      const ws = parseWorkspaceYamlLight(workspaceRaw);

      out.push({
        sessionId: e.name,
        sessionDir,
        eventsPath,
        workspacePath,
        lastModified: (eventsStat?.mtimeMs ?? dirStat.mtimeMs) ?? 0,
        eventsSize: eventsStat?.size ?? 0,
        cwd: ws.cwd,
        gitRoot: ws.gitRoot,
        branch: ws.branch,
        isSdk: ws.clientName === 'sdk',
        name: ws.name,
      });
    }

    // 最新在前
    out.sort((a, b) => b.lastModified - a.lastModified);
    return out;
  }

  // ─── extractSession / transferSession ───────────────────────────────

  /**
   * 提取一个 session 的完整快照（events.jsonl + workspace.yaml 文本 + 解析计数）。
   * 不修改原文件；用于跨设备转交前的快照构造。
   */
  extractSession(sessionId: string): CopilotSessionExtract {
    const sessionDir = path.join(this.sessionStatePath, sessionId);
    const eventsPath = path.join(sessionDir, EVENTS_FILENAME);
    const workspacePath = path.join(sessionDir, WORKSPACE_FILENAME);

    let eventsRaw = '';
    try {
      eventsRaw = fs.readFileSync(eventsPath, 'utf8');
    } catch {
      throw new Error(`Copilot session 不存在或无 events.jsonl: ${eventsPath}`);
    }
    let workspaceRaw = '';
    try {
      workspaceRaw = fs.readFileSync(workspacePath, 'utf8');
    } catch {
      // workspace.yaml 缺失
    }

    let eventCount = 0;
    let messageCount = 0;
    for (const line of eventsRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { type?: string };
        eventCount++;
        if (obj.type === 'user.message' || obj.type === 'assistant.message') {
          messageCount++;
        }
      } catch {
        // 脏行
      }
    }

    return {
      sessionId,
      eventsRaw,
      workspaceRaw,
      eventCount,
      messageCount,
      extractedAt: Date.now(),
      sourceDir: sessionDir,
    };
  }

  /**
   * 把一个 session 的完整状态（events.jsonl + workspace.yaml）复制到目标目录，
   * 用于跨设备转交。targetPath 必须存在（或 recursive:true 创建）。
   *
   * 写入文件：
   *   <targetPath>/<sessionId>/events.jsonl
   *   <targetPath>/<sessionId>/workspace.yaml
   *   <targetPath>/<sessionId>/transfer.json   (元数据：extractedAt / sourceDeviceId / counts)
   *
   * 返回写入的文件路径列表。
   */
  transferSession(
    sessionId: string,
    targetPath: string,
    opts: { sourceDeviceId?: string } = {},
  ): string[] {
    const extract = this.extractSession(sessionId);
    const outDir = path.join(targetPath, sessionId);
    fs.mkdirSync(outDir, { recursive: true });

    const eventsOut = path.join(outDir, EVENTS_FILENAME);
    const workspaceOut = path.join(outDir, WORKSPACE_FILENAME);
    const transferMetaOut = path.join(outDir, 'transfer.json');

    fs.writeFileSync(eventsOut, extract.eventsRaw, 'utf8');
    fs.writeFileSync(workspaceOut, extract.workspaceRaw, 'utf8');
    fs.writeFileSync(
      transferMetaOut,
      JSON.stringify(
        {
          sessionId: extract.sessionId,
          extractedAt: extract.extractedAt,
          sourceDeviceId: opts.sourceDeviceId ?? os.hostname(),
          eventCount: extract.eventCount,
          messageCount: extract.messageCount,
          sourceDir: extract.sourceDir,
        },
        null,
        2,
      ),
      'utf8',
    );

    return [eventsOut, workspaceOut, transferMetaOut];
  }

  // ─── SDK 可选路径 ────────────────────────────────────────────────────

  /**
   * 动态加载 @github/copilot-sdk（如已 npm install）。
   * 仅在 options.enableSdk=true 时尝试；加载失败抛出友好错误。
   *
   * SDK 提供的 3 个 hook 回调（onUserPromptSubmitted / onSessionStart / onSessionEnd）
   * 可用于在 yondermesh daemon 中订阅实时事件，但 CLI 的 events.jsonl 文件流
   * 已能覆盖完整 17 种事件类型，故 SDK 是可选增强而非必需。
   */
  async loadSdk(): Promise<SdkHandle> {
    if (!this.options.enableSdk) {
      throw new Error('SDK 路径未启用：构造 CopilotWrapper 时设置 enableSdk: true');
    }
    let mod: unknown;
    try {
      mod = nodeRequire('@github/copilot-sdk');
    } catch (e) {
      throw new Error(
        `@github/copilot-sdk 未安装或不可加载：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // SDK 入口形状：{ start(opts) -> Promise<{ messages }> }
    const handle = (mod as { start?: unknown }).start;
    if (typeof handle !== 'function') {
      throw new Error('@github/copilot-sdk 模块缺少 start() 导出');
    }
    return mod as SdkHandle;
  }
}

/** 兼容函数式调用入口（与现有 wrapper 风格保持一致） */
export function createCopilotWrapper(options: CopilotWrapperOptions = {}): CopilotWrapper {
  return new CopilotWrapper(options);
}

/** 模块级单例（lazy） */
let defaultWrapper: CopilotWrapper | null = null;
export function getDefaultCopilotWrapper(): CopilotWrapper {
  if (!defaultWrapper) defaultWrapper = new CopilotWrapper();
  return defaultWrapper;
}

/** 显式置空默认 wrapper（测试用） */
export function resetDefaultCopilotWrapper(): void {
  defaultWrapper = null;
}

/** 兼容旧 API：导出 session-state 路径解析函数（与 importer.ts 同源） */
export { resolveCopilotHomePath, resolveCopilotSessionStatePath };
