/**
 * Pi Agent 家族 RPC 协议客户端（Pi / oh-my-pi / gsd-pi 通用）
 *
 * 三个 CLI 共享同一 RPC 协议（实测自 pi @earendil-works/pi-coding-agent
 * dist/modes/rpc/rpc-mode.js + rpc-types.d.ts，omp/gsd 为同源 fork）：
 *   - 传输：stdin/stdout 上的换行分隔 JSON（JSONL）
 *   - 命令：每行一个 JSON 对象 { id?, type, ...params } 发往 stdin
 *   - 响应：{ id?, type:"response", command, success:true, data? }
 *           | { id?, type:"response", command, success:false, error }
 *   - 事件：AgentSessionEvent（type !== "response"），由 session.subscribe 流式输出
 *   - 一个 RPC 进程绑定一个活动 session；switch_session { sessionPath } 切换活动 session
 *
 * 支持的中途介入命令（任务核心）：
 *   - steer     { message, images? }   —— 运行中注入（打断当前轮次，立即生效）
 *   - follow_up { message, images? }   —— 排队等当前轮次结束后处理
 *   - abort                            —— 中断当前操作
 *
 * 协议权威来源（pi rpc-mode.js handleCommand）：
 *   case "steer":     await session.steer(command.message, command.images); return success(id,"steer");
 *   case "follow_up": await session.followUp(command.message, command.images); return success(id,"follow_up");
 *   case "abort":     await session.abort(); return success(id,"abort");
 *   case "switch_session": runtimeHost.switchSession(command.sessionPath) → rebindSession
 *
 * 启动方式：`<cli> --mode rpc`（三 CLI 一致：pi/omp/gsd 均支持 --mode rpc）。
 * 本客户端零依赖（仅 node:child_process / node:crypto），不耦合 pi 内部包路径，
 * 因此对 pi/omp/gsd 三个 fork 通用。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** Pi flavor CLI 名 */
export type PiCli = 'pi' | 'omp' | 'gsd';

/** RPC 命令的松散结构 */
export interface RpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

/** RPC 响应（成功） */
export interface RpcResponseOk {
  id?: string;
  type: 'response';
  command: string;
  success: true;
  data?: unknown;
}

/** RPC 响应（失败） */
export interface RpcResponseErr {
  id?: string;
  type: 'response';
  command: string;
  success: false;
  error: string;
}

/** RPC 响应联合 */
export type RpcResponse = RpcResponseOk | RpcResponseErr;

/** RPC 事件（非 response 的任意 AgentSessionEvent） */
export type RpcEvent = Record<string, unknown> & { type: string };

/** 图片内容（与 pi ImageContent 对齐） */
export interface RpcImage {
  type: 'base64' | 'url';
  mediaType?: string;
  data?: string;
  url?: string;
}

/** RpcClient 启动选项 */
export interface RpcClientOptions {
  /** CLI 二进制名：pi / omp / gsd（默认 pi） */
  cli?: PiCli;
  /** agent 工作目录（影响 session 写入位置 / AGENTS.md 加载） */
  cwd?: string;
  /** 额外 CLI 参数（如 --model glm/glm-5.2） */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 启动超时（毫秒），默认 30s */
  startTimeoutMs?: number;
}

/** RPC 错误 */
export class RpcError extends Error {
  constructor(
    message: string,
    /** 响应中的 command 字段 */
    readonly command?: string,
    /** 关联的 command id */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * Pi Agent 家族 RPC 客户端。
 *
 * 用法（steer 中途介入）：
 *   const client = new PiRpcClient({ cli: 'pi', cwd: projectDir });
 *   await client.start();
 *   await client.prompt('长任务...');            // 立即返回，事件流到 onEvent
 *   await client.steer('改成用 TypeScript');     // 运行中注入
 *   await client.waitForIdle();                  // 等待 agent_settled
 *   await client.stop();
 *
 * 用法（绑定已有 session 后 steer）：
 *   await client.start();
 *   await client.switchSession(sessionFilePath); // 切到目标 session
 *   await client.steer('补充指令');
 */
export class PiRpcClient {
  private proc: ChildProcess | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (r: RpcResponseOk) => void; reject: (e: Error) => void; command: string }
  >();
  private readonly events = new EventEmitter();
  private stderrBuf = '';
  private buf = '';
  private seq = 0;

  constructor(private readonly options: RpcClientOptions = {}) {}

  /** 启动 RPC 子进程 */
  async start(): Promise<void> {
    const cli = this.options.cli ?? 'pi';
    const args = ['--mode', 'rpc', ...(this.options.args ?? [])];
    this.proc = spawn(cli, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.setEncoding('utf8');
    this.proc.stderr?.setEncoding('utf8');

    this.proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr?.on('data', (chunk: string) => {
      this.stderrBuf += chunk;
    });
    this.proc.on('error', (err) => {
      this.failAll(err);
    });
    this.proc.on('exit', (code, signal) => {
      const msg = `RPC 进程退出 (code=${code} signal=${signal})`;
      this.failAll(new Error(msg));
    });

    // 等待进程就绪：首个非 response 行（事件）或 200ms 无错误即视为就绪。
    // RPC 模式启动后会绑定默认 session 并开始读取 stdin；无需等待特定 ready 标记。
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => resolve(),
        Math.min(this.options.startTimeoutMs ?? 30_000, 2_000),
      );
      const onErr = (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      };
      this.events.once('__start_error', onErr);
      // 进程若立即退出则报错
      this.proc!.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error(`RPC 进程立即退出；stderr: ${this.stderrBuf.slice(-500)}`));
      });
      // 任何输出表明进程已活
      this.proc!.stdout?.once('data', () => {
        clearTimeout(timeout);
        this.events.off('__start_error', onErr);
        resolve();
      });
    });
  }

  /** 停止 RPC 子进程 */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try {
      proc.stdin?.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      proc.once('exit', done);
      setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          resolve();
        }, 2_000);
      }, 1_000);
    });
  }

  /** 订阅事件流；返回取消订阅函数 */
  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  /** 等待满足 predicate 的事件；超时抛错 */
  waitForEvent(
    predicate: (e: RpcEvent) => boolean,
    timeoutMs = 120_000,
  ): Promise<RpcEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.events.off('event', handler);
        reject(new Error(`等待事件超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      const handler = (e: RpcEvent) => {
        if (predicate(e)) {
          clearTimeout(timer);
          this.events.off('event', handler);
          resolve(e);
        }
      };
      this.events.on('event', handler);
    });
  }

  /**
   * 等待 agent 空闲：监听 agent_settled 事件（pi 在每轮结束时发出）。
   * 配合 prompt/steer 使用：发送命令后调用以阻塞至本轮结束。
   */
  waitForIdle(timeoutMs = 300_000): Promise<RpcEvent> {
    return this.waitForEvent(
      (e) => e.type === 'agent_settled' || e.type === 'agent-settled',
      timeoutMs,
    );
  }

  /** 收集的 stderr（调试用） */
  getStderr(): string {
    return this.stderrBuf;
  }

  // ─── 中途介入命令（任务核心） ───────────────────────────────────────────

  /** 发送 prompt（立即返回，事件流到 onEvent；用 waitForIdle 等完成） */
  prompt(message: string, images?: RpcImage[]): Promise<void> {
    return this.send('prompt', { message, images }).then(() => undefined);
  }

  /** steer：运行中注入消息（打断当前轮次） */
  steer(message: string, images?: RpcImage[]): Promise<void> {
    return this.send('steer', { message, images }).then(() => undefined);
  }

  /** follow_up：排队等当前轮次结束后处理 */
  followUp(message: string, images?: RpcImage[]): Promise<void> {
    return this.send('follow_up', { message, images }).then(() => undefined);
  }

  /** abort：中断当前操作 */
  abort(): Promise<void> {
    return this.send('abort', {}).then(() => undefined);
  }

  // ─── session / 状态命令 ────────────────────────────────────────────────

  /** 切换当前 RPC 进程绑定的 session（用 session 文件路径） */
  switchSession(sessionPath: string): Promise<unknown> {
    return this.send('switch_session', { sessionPath }).then((r) => r.data);
  }

  /** 获取当前 session 状态 */
  getState(): Promise<unknown> {
    return this.send('get_state', {}).then((r) => r.data);
  }

  /** 获取 entry 树（保留拓扑） */
  getTree(): Promise<unknown> {
    return this.send('get_tree', {}).then((r) => r.data);
  }

  /** 获取 entries（可增量：since 某 entry id 之后） */
  getEntries(since?: string): Promise<unknown> {
    return this.send('get_entries', since ? { since } : {}).then((r) => r.data);
  }

  /** 获取当前 session 消息 */
  getMessages(): Promise<unknown> {
    return this.send('get_messages', {}).then((r) => r.data);
  }

  // ─── 内部 ──────────────────────────────────────────────────────────────

  /**
   * 发送一条命令，返回匹配 id 的响应 promise。
   * 命令类型为已知枚举（steer/follow_up/abort/...）或自定义 type。
   */
  send(command: string, params: Record<string, unknown>): Promise<RpcResponseOk> {
    const proc = this.proc;
    if (!proc || !proc.stdin || proc.killed) {
      return Promise.reject(new RpcError('RPC 客户端未启动或已停止', command));
    }
    const stdin = proc.stdin;
    const id = `${++this.seq}-${randomUUID()}`;
    const payload: RpcCommand = { id, type: command, ...params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        command,
      });
      try {
        stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(new RpcError(`写入 stdin 失败: ${errorMessage(err)}`, command, id));
      }
    });
  }

  /** 处理 stdout chunk：按行切分，分派响应/事件 */
  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // 脏行跳过
      }
      this.dispatch(obj);
    }
  }

  /** 分派一条 JSON 对象：response 匹配 pending，否则当事件广播 */
  private dispatch(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;
    const o = obj as { type?: unknown; id?: unknown };
    if (o.type === 'response') {
      const resp = obj as RpcResponse;
      const id = typeof resp.id === 'string' ? resp.id : undefined;
      if (!id) return; // 无 id，无法匹配 pending
      const pending = this.pending.get(id);
      if (!pending) return; // 无匹配 pending（可能已超时），丢弃
      this.pending.delete(id);
      if (resp.success) {
        pending.resolve(resp);
      } else {
        pending.reject(
          new RpcError(resp.error ?? `${pending.command} 失败`, pending.command, id),
        );
      }
      return;
    }
    // 事件
    this.events.emit('event', obj as RpcEvent);
  }

  /** 失败所有 pending 请求 */
  private failAll(err: Error): void {
    this.events.emit('__start_error', err);
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
