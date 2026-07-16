/**
 * Pi Agent 家族统一控制器（Pi / oh-my-pi / gsd-pi 通用）
 *
 * 三个 CLI 共享 JSONL v3 session 格式与 RPC 协议，PiController 通过目录路径区分 flavor，
 * 对外提供统一的 launch / inject(steer) / abort / getStream / listSessions /
 * extractSession / transferSession 能力。
 *
 * launch / inject / abort 底层走 RPC 协议（src/pi/rpc.ts），不依赖各 CLI 内部包路径；
 * listSessions / extractSession / transferSession 走文件系统（JSONL v3 只读解析 + 迁移写）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PiImporter,
  resolvePiFlavors,
  resolveFlavorSessionsDir,
  type PiFlavorConfig,
  type PiNeutralSession,
  type PiEntry,
} from './importer.js';
import { PiRpcClient, type PiCli, type RpcEvent, type RpcImage } from './rpc.js';

/** flavor 标识（source 名） */
export type PiSource = 'pi' | 'omp' | 'gsd-pi';

/** session 列表项 */
export interface PiSessionSummary {
  /** native session id（session 行的 UUID） */
  sessionId: string;
  /** flavor source */
  source: string;
  /** CLI 名 */
  cli: string;
  /** session 文件绝对路径 */
  filePath: string;
  /** cwd */
  cwd?: string;
  /** 开始时间（epoch ms） */
  startedAt?: number;
  /** 模型 */
  model?: string;
  /** 文件大小（字节） */
  size: number;
}

/** launch 返回的活 session 句柄（client 保持存活，可中途 steer） */
export interface PiSessionHandle {
  /** native session id */
  sessionId: string;
  /** session 文件绝对路径（RPC get_state 返回） */
  sessionFile?: string;
  /** flavor source */
  source: string;
  /** CLI 名 */
  cli: string;
  /** 活的 RPC 客户端（可直调 client.steer / client.abort / client.onEvent） */
  client: PiRpcClient;
  /** 中途注入（steer）：运行中打断当前轮次 */
  inject(message: string, images?: RpcImage[]): Promise<void>;
  /** 中断当前操作 */
  abort(): Promise<void>;
  /** 订阅事件流（token / 工具调用 / agent_settled 等） */
  getStream(listener: (e: RpcEvent) => void): () => void;
  /** 等待 agent 空闲（agent_settled） */
  waitForIdle(timeoutMs?: number): Promise<RpcEvent>;
  /** 停止 RPC 进程 */
  stop(): Promise<void>;
}

/** launch 选项 */
export interface PiLaunchOptions {
  /** 工作目录（影响 session 写入位置 / AGENTS.md） */
  cwd?: string;
  /** 模型参数（默认用 flavor.glmModelArg → GLM-5.2） */
  modelArgs?: string[];
  /** 是否在 prompt 后等待 idle 再返回（默认 false：立即返回句柄供中途 steer） */
  waitIdle?: boolean;
  /** 环境变量 */
  env?: Record<string, string>;
}

/** transferSession 结果 */
export interface PiTransferResult {
  /** 目标 flavor source */
  targetSource: string;
  /** 目标 CLI 名 */
  targetCli: string;
  /** 写入的目标 session 文件绝对路径 */
  targetFilePath: string;
  /** 新的 native session id（保持原 id） */
  sessionId: string;
  /** 迁移的 entry 数 */
  entryCount: number;
}

/** PiController 选项 */
export interface PiControllerOptions {
  /** flavor 配置覆盖（默认本机探测） */
  flavors?: PiFlavorConfig[];
}

/**
 * Pi Agent 家族统一控制器。
 *
 *   const ctl = new PiController();
 *   const handle = await ctl.launch('长任务...', 'pi', { cwd: proj });
 *   await handle.inject('改成用 TypeScript');   // 中途 steer
 *   await handle.waitForIdle();
 *   await handle.stop();
 */
export class PiController {
  private readonly flavors: PiFlavorConfig[];

  constructor(options: PiControllerOptions = {}) {
    this.flavors = (options.flavors ?? resolvePiFlavors()).map((f) => ({
      ...f,
      sessionsDir: resolveFlavorSessionsDir(f),
    }));
  }

  /** 暴露 flavor 配置（含已解析 sessionsDir） */
  getFlavors(): PiFlavorConfig[] {
    return this.flavors;
  }

  /** 按 source 或 cli 名查 flavor */
  flavorOf(sourceOrCli: string): PiFlavorConfig | undefined {
    return this.flavors.find(
      (f) => f.source === sourceOrCli || f.cli === sourceOrCli,
    );
  }

  // ─── launch ────────────────────────────────────────────────────────────

  /**
   * 发起一个新 session：用 RPC 模式启动 CLI，发送 prompt，返回活句柄。
   * 句柄的 client 保持存活，可立即 inject(steer) 中途介入。
   * 默认使用 GLM-5.2（flavor.glmModelArg）。
   */
  async launch(
    prompt: string,
    cli: PiCli | string = 'pi',
    options: PiLaunchOptions = {},
  ): Promise<PiSessionHandle> {
    const flavor = this.flavorOf(cli);
    if (!flavor) throw new Error(`未知 Pi flavor / cli: ${cli}`);
    const modelArgs = options.modelArgs ?? flavor.glmModelArg.split(/\s+/).filter(Boolean);
    const cwd = options.cwd ?? process.cwd();

    const client = new PiRpcClient({
      cli: flavor.cli as PiCli,
      cwd,
      args: [...modelArgs],
      env: options.env,
    });
    await client.start();

    // 发送 prompt（立即返回，事件流到 getStream）
    await client.prompt(prompt);

    // 取 session 元数据（sessionId / sessionFile）
    let sessionId = '';
    let sessionFile: string | undefined;
    try {
      const state = (await client.getState()) as {
        sessionId?: string;
        sessionFile?: string;
      } | undefined;
      sessionId = state?.sessionId ?? '';
      sessionFile = state?.sessionFile;
    } catch {
      /* get_state 失败不阻塞；sessionId 可由后续 listSessions 补 */
    }

    if (options.waitIdle) {
      await client.waitForIdle();
    }

    return {
      sessionId,
      sessionFile,
      source: flavor.source,
      cli: flavor.cli,
      client,
      inject: (msg, imgs) => client.steer(msg, imgs),
      abort: () => client.abort(),
      getStream: (listener) => client.onEvent(listener),
      waitForIdle: (timeoutMs) => client.waitForIdle(timeoutMs),
      stop: () => client.stop(),
    };
  }

  // ─── inject（attach 到已有 session 后 steer） ──────────────────────────

  /**
   * 绑定到已有 session 并 steer 注入消息。
   * 实现：启动 RPC → switchSession(filePath) → steer(message) → 可选 waitForIdle → stop。
   * 用于对已存在（可能已 settle）的 session 追加中途指令；运行中 session 由同进程
   * 的 launch 句柄 inject 更可靠（避免双进程写同一文件）。
   */
  async inject(
    sessionId: string,
    message: string,
    cli: PiCli | string = 'pi',
    options: { waitIdle?: boolean; images?: RpcImage[] } = {},
  ): Promise<{ ok: true }> {
    const flavor = this.flavorOf(cli);
    if (!flavor) throw new Error(`未知 Pi flavor / cli: ${cli}`);
    const summary = await this.findSession(sessionId, flavor.source);
    if (!summary) throw new Error(`未找到 session: ${sessionId} (source=${flavor.source})`);

    const client = new PiRpcClient({
      cli: flavor.cli as PiCli,
      cwd: summary.cwd ?? process.cwd(),
    });
    await client.start();
    try {
      await client.switchSession(summary.filePath);
      await client.steer(message, options.images);
      if (options.waitIdle) await client.waitForIdle();
    } finally {
      await client.stop();
    }
    return { ok: true };
  }

  // ─── abort ─────────────────────────────────────────────────────────────

  /** 绑定到已有 session 并中断当前操作 */
  async abort(
    sessionId: string,
    cli: PiCli | string = 'pi',
  ): Promise<{ ok: true }> {
    const flavor = this.flavorOf(cli);
    if (!flavor) throw new Error(`未知 Pi flavor / cli: ${cli}`);
    const summary = await this.findSession(sessionId, flavor.source);
    if (!summary) throw new Error(`未找到 session: ${sessionId} (source=${flavor.source})`);

    const client = new PiRpcClient({
      cli: flavor.cli as PiCli,
      cwd: summary.cwd ?? process.cwd(),
    });
    await client.start();
    try {
      await client.switchSession(summary.filePath);
      await client.abort();
    } finally {
      await client.stop();
    }
    return { ok: true };
  }

  // ─── getStream ─────────────────────────────────────────────────────────

  /**
   * 绑定到已有 session 并返回事件流订阅。
   * 返回 { unsubscribe, client }；调用方负责 client.stop()。
   */
  async getStream(
    sessionId: string,
    cli: PiCli | string = 'pi',
    listener: (e: RpcEvent) => void,
  ): Promise<{ unsubscribe: () => void; client: PiRpcClient }> {
    const flavor = this.flavorOf(cli);
    if (!flavor) throw new Error(`未知 Pi flavor / cli: ${cli}`);
    const summary = await this.findSession(sessionId, flavor.source);
    if (!summary) throw new Error(`未找到 session: ${sessionId} (source=${flavor.source})`);

    const client = new PiRpcClient({
      cli: flavor.cli as PiCli,
      cwd: summary.cwd ?? process.cwd(),
    });
    await client.start();
    await client.switchSession(summary.filePath);
    const unsubscribe = client.onEvent(listener);
    return { unsubscribe, client };
  }

  // ─── listSessions ──────────────────────────────────────────────────────

  /** 列出 session；cli 指定时只列该 flavor，否则列全部三个 */
  async listSessions(cli?: PiCli | string): Promise<PiSessionSummary[]> {
    const flavors = cli ? [this.flavorOf(cli)].filter(Boolean) as PiFlavorConfig[] : this.flavors;
    const out: PiSessionSummary[] = [];
    for (const flavor of flavors) {
      if (!flavor.sessionsDir) continue;
      for (const s of this.scanFlavorSessions(flavor)) {
        out.push(s);
      }
    }
    return out;
  }

  // ─── extractSession ────────────────────────────────────────────────────

  /** 读取并解析 JSONL v3 session（含完整 entry 树），返回中性 session */
  async extractSession(
    sessionId: string,
    cli?: PiCli | string,
  ): Promise<PiNeutralSession | null> {
    const flavors = cli ? [this.flavorOf(cli)].filter(Boolean) as PiFlavorConfig[] : this.flavors;
    for (const flavor of flavors) {
      if (!flavor.sessionsDir) continue;
      const file = this.findSessionFile(flavor, sessionId);
      if (file) {
        return PiImporter.extractSession(file, flavor.source);
      }
    }
    return null;
  }

  // ─── transferSession ───────────────────────────────────────────────────

  /**
   * 在三个 CLI 间互转 session：提取中性 session（含完整 entry 树），按目标 CLI 的
   * 目录约定重写为 JSONL v3 文件（格式三 CLI 共享，原样复用 entry），可在目标 CLI
   * 中以 --continue（同 cwd）或 switch_session 恢复。
   *
   * 注意：此操作会向目标 CLI 的私有 session 目录写入新文件（迁移语义，非扫描）。
   */
  async transferSession(
    sessionId: string,
    targetCli: PiCli | string,
    options: { sourceCli?: PiCli | string } = {},
  ): Promise<PiTransferResult> {
    const target = this.flavorOf(targetCli);
    if (!target) throw new Error(`未知目标 Pi flavor / cli: ${targetCli}`);
    if (!target.sessionsDir) {
      throw new Error(`目标 flavor ${target.source} 的 sessions 目录不存在: ${target.configDir}`);
    }

    const neutral = await this.extractSession(sessionId, options.sourceCli);
    if (!neutral) throw new Error(`未找到源 session: ${sessionId}`);

    const targetFile = this.writeNeutralSession(neutral, target);
    return {
      targetSource: target.source,
      targetCli: target.cli,
      targetFilePath: targetFile,
      sessionId: neutral.nativeId,
      entryCount: neutral.entries.length,
    };
  }

  // ─── 内部：文件系统扫描 ─────────────────────────────────────────────────

  /** 扫描单个 flavor 的所有 session 文件，轻量解析元数据 */
  private scanFlavorSessions(flavor: PiFlavorConfig): PiSessionSummary[] {
    const root = flavor.sessionsDir!;
    const out: PiSessionSummary[] = [];
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
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          const meta = this.lightParseSession(abs);
          if (meta) {
            out.push({
              sessionId: meta.sessionId,
              source: flavor.source,
              cli: flavor.cli,
              filePath: abs,
              cwd: meta.cwd,
              startedAt: meta.startedAt,
              model: meta.model,
              size: meta.size,
            });
          }
        }
      }
    };
    walk(root);
    out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return out;
  }

  /** 轻量解析：只读前若干行取 session 行 + model_change，避免读超大文件全量 */
  private lightParseSession(
    absPath: string,
  ): {
    sessionId: string;
    cwd?: string;
    startedAt?: number;
    model?: string;
    size: number;
  } | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return null;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let startedAt: number | undefined;
    let model: string | undefined;
    const lines = raw.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      const type = typeof obj.type === 'string' ? obj.type : '';
      if (type === 'session') {
        if (typeof obj.id === 'string') sessionId = obj.id;
        if (typeof obj.cwd === 'string') cwd = obj.cwd;
        if (typeof obj.timestamp === 'string') {
          const ms = Date.parse(obj.timestamp);
          if (!Number.isNaN(ms)) startedAt = ms;
        }
      } else if (type === 'model_change' && !model) {
        if (typeof obj.model === 'string') model = obj.model;
        else if (typeof obj.modelId === 'string') {
          model = typeof obj.provider === 'string' ? `${obj.provider}/${obj.modelId}` : obj.modelId;
        }
      }
      if (sessionId && model) break;
    }
    if (!sessionId) return null;
    return { sessionId, cwd, startedAt, model, size: stat.size };
  }

  /** 在 flavor 的 session 树中查找 sessionId 对应的文件 */
  private findSessionFile(flavor: PiFlavorConfig, sessionId: string): string | null {
    for (const s of this.scanFlavorSessions(flavor)) {
      if (s.sessionId === sessionId) return s.filePath;
    }
    return null;
  }

  /** 跨 flavor 查找 session */
  private async findSession(
    sessionId: string,
    source?: string,
  ): Promise<PiSessionSummary | null> {
    const flavors = source ? [this.flavorOf(source)].filter(Boolean) as PiFlavorConfig[] : this.flavors;
    for (const flavor of flavors) {
      if (!flavor.sessionsDir) continue;
      const file = this.findSessionFile(flavor, sessionId);
      if (file) {
        const meta = this.lightParseSession(file);
        if (meta) {
          return {
            sessionId: meta.sessionId,
            source: flavor.source,
            cli: flavor.cli,
            filePath: file,
            cwd: meta.cwd,
            startedAt: meta.startedAt,
            model: meta.model,
            size: meta.size,
          };
        }
      }
    }
    return null;
  }

  /**
   * 把中性 session 写入目标 flavor 的 session 目录。
   * 文件名仿真实格式：<ISO-ts>_<uuid>.jsonl；目录为 <sessionsDir>/<encoded-cwd>/。
   * entry 原样复用（三 CLI 共享 JSONL v3 格式），保留完整树拓扑。
   */
  private writeNeutralSession(
    neutral: PiNeutralSession,
    target: PiFlavorConfig,
  ): string {
    const cwd = neutral.cwd ?? process.cwd();
    const encodedCwd = encodeCwd(cwd);
    const dir = path.join(target.sessionsDir!, encodedCwd);
    fs.mkdirSync(dir, { recursive: true });

    const ts = new Date(neutral.startedAt ?? Date.now())
      .toISOString()
      .replace(/[:.]/g, '-');
    const filename = `${ts}_${neutral.nativeId}.jsonl`;
    const filePath = path.join(dir, filename);

    // 原样复用 entry（保留 id/parentId 树拓扑）；按行序写入
    const lines = neutral.entries.map((e) => JSON.stringify(e.raw)).join('\n') + '\n';
    fs.writeFileSync(filePath, lines, 'utf8');
    return filePath;
  }
}

/**
 * 编码 cwd 为 Pi 家族 session 子目录名。
 * 实测规则（本机 ~/.pi/agent/sessions/ 真实目录名校验）：
 *   /private/tmp                            → --private-tmp--
 *   /Users/zoran/Documents/projects/zenith  → --Users-zoran-Documents-projects-zenith--
 *   /private/tmp/omp-test                   → --private-tmp-omp-test--
 * 规律：去掉前导 '/'，剩余每个 '/' 替换为 '-'，首尾各加 '--'。
 */
export function encodeCwd(cwd: string): string {
  const stripped = cwd.replace(/^\//, '');
  const replaced = stripped.replace(/\//g, '-');
  return `--${replaced}--`;
}

/** 把未知错误归一化为消息字符串（导出供其他模块复用） */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 重新导出常用类型与 importer 静态能力，便于 `import { ... } from './wrapper.js'`
export { PiImporter, type PiEntry, type PiNeutralSession };
export type { PiCli } from './rpc.js';
