/**
 * yondermesh Adapter 模板
 *
 * 这是一个完整的 adapter 模板文件，复制此文件并重命名为你的 agent 名称
 * （如 src/mycli/index.ts），然后按 TODO 注释实现各方法。规范见
 * `specs/adapter-spec.md`。
 *
 * 三部分可独立使用：
 *   - TemplateImporter：采集（必选）
 *   - TemplateWrapper：控制（可选，仅 D6/D7/D8 CLI 需要）
 *   - TemplateInjector：挂载（可选，仅 D3/D4/D10 CLI 需要）
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionStore } from '../store/session-store.js';
import { BaseImporter } from './base-importer.js';
import { BaseWrapper } from './base-wrapper.js';
import { BaseInjector } from './base-injector.js';
import type {
  Coverage,
  InjectResult,
  LaunchOptions,
  LaunchResult,
  NeutralSession,
  ParsedSession,
  SessionSummary,
  StreamEvent,
} from './types.js';

// ─── Importer（采集） ──────────────────────────────────────────────────

/**
 * TemplateImporter —— 采集器模板。
 *
 * 把 <T> 设为你的 scan 上下文类型；无需上下文用 `undefined`。
 */
export class TemplateImporter extends BaseImporter<undefined> {
  /** canonical source 名（与 source-aliases.ts 注册一致） */
  readonly source = 'template';
  /** 覆盖等级：A 原生 adapter / B 兼容 importer / C 仅发现 */
  readonly coverage: Coverage = 'A';

  /** 扫描根目录（如 ~/.template/sessions） */
  resolveRootPath(): string {
    return path.join(os.homedir(), '.template', 'sessions');
  }

  /**
   * 扫描并 yield 候选文件。
   * 可复用 this.collectJsonlFiles(rootPath) 收集 .jsonl 文件；
   * SQLite 类 adapter 在此打开 DB 并 yield 每行。
   */
  *scan(rootPath: string): Iterable<{ file: string; data: undefined }> {
    for (const f of this.collectJsonlFiles(rootPath)) {
      yield { file: f.absPath, data: undefined };
    }
  }

  /**
   * 解析单个文件 → ParsedSession。
   * - 只取 user/assistant 可显示文本，排除 thinking/tool_use/tool_result。
   * - 无有效消息返回 null（跳过该文件）。
   * - nativeSessionId 取 UUID（便于跨源 matchKey 匹配 cass）。
   * - 脏行跳过不抛。
   */
  parse(_filePath: string, _data: undefined): ParsedSession | null {
    // TODO: 读取 _filePath，解析为 ParsedSession
    return null;
  }
}

// ─── Wrapper（控制，可选） ─────────────────────────────────────────────

/**
 * TemplateWrapper —— CLI 链式 wrapper 模板。
 * 仅当该 CLI 支持 D6（介入）/ D7（接管）/ D8（流式）时实现。
 */
export class TemplateWrapper extends BaseWrapper {
  readonly sourceCli = 'template';
  readonly cliBinary = 'template';

  /** 启动新 session：用 this.spawnCliSync / this.spawnCliAsync 调用 CLI */
  async launch(prompt: string, opts?: LaunchOptions): Promise<LaunchResult> {
    throw new Error(
      `TODO: implement launch for ${this.sourceCli} (model=${opts?.model ?? 'default'}, prompt ${prompt.length} chars)`,
    );
  }

  /** 中途注入消息到运行中的 session */
  async inject(sessionId: string, message: string): Promise<InjectResult> {
    return {
      success: false,
      sessionId,
      message: `TODO: inject into ${sessionId}: ${message.slice(0, 20)}`,
    };
  }

  /** 中断运行中的 session（参考 this.killRunningProcess） */
  async interrupt(sessionId: string): Promise<void> {
    this.killRunningProcess(sessionId);
  }

  /** 实时读取 session 消息流 */
  async *getStream(_sessionId: string): AsyncIterable<StreamEvent> {
    // TODO: 轮询 CLI 的 session 文件 / DB，yield StreamEvent
    yield { type: 'error', message: 'TODO: implement getStream' };
  }

  /** 列出所有 session */
  listSessions(): SessionSummary[] {
    // TODO: 读 CLI 的 session 列表
    return [];
  }

  /** 提取 session 为中性格式（transferSession 由基类提供） */
  extractSession(_sessionId: string): NeutralSession {
    // TODO: 读 CLI 的 session 元数据 + 消息，构造 NeutralSession
    throw new Error('TODO: implement extractSession');
  }
}

// ─── Injector（挂载，可选） ────────────────────────────────────────────

/**
 * TemplateInjector —— 挂载器模板。
 * 仅当该 CLI 支持 D3（MCP）/ D4（Skills）/ D10（Always-on）时实现。
 */
export class TemplateInjector extends BaseInjector {
  /** CLI id（与 mount/registry.ts 的 CliTarget.id 一致） */
  readonly cliId = 'template';
  /** 配置目录名（如 '.template'） */
  readonly configDir = '.template';

  /** 挂载 ymesh 扩展（幂等） */
  async injectAll(): Promise<void> {
    // always-on：写入 AGENTS.md（如该 CLI 读取全局指令文件）
    const instructionFile = this.resolveInstructionFile('AGENTS.md');
    this.injectMarkedBlock(instructionFile);

    // mcp-json：注入 MCP server（如该 CLI 用 JSON mcpServers）
    // const configPath = this.resolveConfigFile('mcp.json');
    // this.injectMcpJson(configPath, 'yondermesh', { command: 'ymesh', args: ['mcp', 'serve'] });

    // skill-symlink：创建 skill 目录 symlink（如该 CLI 读取 ~/.<cli>/skills/）
    // const skillsDir = this.resolveConfigFile('skills');
    // this.ensureConfigDir(); fs.symlinkSync(ymeshSkillsRoot, path.join(skillsDir, 'yondermesh'));
  }

  /** 卸载 ymesh 扩展（幂等，干净恢复） */
  async uninjectAll(): Promise<void> {
    const instructionFile = this.resolveInstructionFile('AGENTS.md');
    this.removeMarkedBlock(instructionFile);
    // this.removeMcpJson(configPath, 'yondermesh');
  }
}

// ─── 模块入口工厂（可选，便于 cmdScan 调用） ────────────────────────────

export interface TemplateAdapter {
  importer: TemplateImporter;
  wrapper: TemplateWrapper;
  injector: TemplateInjector;
}

/** 创建完整 adapter 三件套 */
export function createTemplateAdapter(
  store: SessionStore,
  deviceId: string,
): TemplateAdapter {
  return {
    importer: new TemplateImporter(store, { deviceId }),
    wrapper: new TemplateWrapper(),
    injector: new TemplateInjector(),
  };
}
