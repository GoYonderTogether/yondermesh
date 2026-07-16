/**
 * yondermesh Adapter SDK —— CLI 脚手架
 *
 * scaffoldAdapter() 生成新 adapter 的文件结构，供 `ymesh scaffold <agent-name>`
 * 命令调用。开发者复制生成的内容到 src/<name>/ 即可开始实现。
 *
 * 生成的文件：
 *   src/<name>/importer.ts  —— 采集器（继承 BaseImporter）
 *   src/<name>/wrapper.ts   —— 控制器（继承 BaseWrapper）
 *   src/<name>/inject.ts    —— 挂载器（继承 BaseInjector）
 *   src/<name>/index.ts     —— 模块入口
 */

/** 脚手架选项 */
export interface ScaffoldOptions {
  /** 配置目录名，默认 '.<name>'（如 '.mycli'） */
  configDir?: string;
  /** CLI 二进制名，默认 <name> */
  cliBinary?: string;
  /** session 文件格式，决定 importer 模板的 scan/parse 默认实现 */
  sessionFormat?: 'jsonl' | 'sqlite' | 'json' | 'markdown';
}

/** 生成的文件 */
export interface ScaffoldFile {
  /** 相对项目根的路径（如 'src/mycli/importer.ts'） */
  path: string;
  /** 文件内容 */
  content: string;
}

/**
 * 生成新 adapter 的文件结构。
 *
 * @param name agent 名称（如 'mycli'），小写化后作为目录名与 canonical id
 * @param options 脚手架选项
 * @returns { files: ScaffoldFile[] } 生成的文件列表
 *
 * @example
 *   const { files } = scaffoldAdapter('mycli', { cliBinary: 'mycli', sessionFormat: 'jsonl' });
 *   files.forEach(f => fs.writeFileSync(f.path, f.content));
 */
export function scaffoldAdapter(
  name: string,
  options: ScaffoldOptions = {},
): { files: ScaffoldFile[] } {
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const configDir = options.configDir ?? `.${id}`;
  const cliBinary = options.cliBinary ?? id;
  const sessionFormat = options.sessionFormat ?? 'jsonl';

  const files: ScaffoldFile[] = [
    {
      path: `src/${id}/importer.ts`,
      content: renderImporter(id, configDir, sessionFormat),
    },
    {
      path: `src/${id}/wrapper.ts`,
      content: renderWrapper(id, cliBinary),
    },
    {
      path: `src/${id}/inject.ts`,
      content: renderInjector(id, configDir),
    },
    {
      path: `src/${id}/index.ts`,
      content: renderIndex(id),
    },
  ];

  return { files };
}

// ─── 文件内容生成 ──────────────────────────────────────────────────────

function renderImporter(id: string, configDir: string, sessionFormat: string): string {
  const rootPath = `${configDir}/sessions`;
  const scanBody =
    sessionFormat === 'sqlite'
      ? `  // TODO: 以只读模式打开 ${configDir}/state.db，遍历 sessions 表\n  // const db = this.openSqliteReadOnly(path.join(rootPath, 'state.db'));\n  // for (const row of db.prepare('SELECT id FROM sessions').all()) {\n  //   yield { file: row.id, data: undefined };\n  // }\n  // db.close();\n  return [];`
      : sessionFormat === 'json'
        ? `  // TODO: 遍历 ${configDir}/sessions/*.json 文件\n  return [];`
        : sessionFormat === 'markdown'
          ? `  // TODO: 遍历 ${configDir}/*.md 文件（如 .aider.chat.history.md）\n  return [];`
          : `  for (const f of this.collectJsonlFiles(rootPath)) {\n    yield { file: f.absPath, data: undefined };\n  }`;

  return `/**
 * ${id} 原生 adapter（覆盖等级 A）
 *
 * 只读扫描本机 ${rootPath} 下的 session 文件，解析并入库。
 * 由 \`ymesh scaffold ${id}\` 生成，按 TODO 注释实现。规范见 specs/adapter-spec.md。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { BaseImporter } from '../sdk/base-importer.js';
import type { Coverage, ParsedSession } from '../sdk/types.js';

export interface ${pascal(id)}ImportOptions {
  /** 直接指定扫描根目录，默认 ~/${rootPath} */
  rootPath?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
}

export class ${pascal(id)}Importer extends BaseImporter<undefined> {
  readonly source = '${id}';
  readonly coverage: Coverage = 'A';

  resolveRootPath(): string {
    return path.join(os.homedir(), '${rootPath}');
  }

  *scan(rootPath: string): Iterable<{ file: string; data: undefined }> {
${scanBody}
  }

  parse(_filePath: string, _data: undefined): ParsedSession | null {
    // TODO: 解析单个文件 → ParsedSession
    // - 只取 user/assistant 可显示文本，排除 thinking/tool_use/tool_result
    // - nativeSessionId 取 UUID（便于跨源 matchKey 匹配 cass）
    // - 脏行跳过不抛；无有效消息返回 null
    return null;
  }
}
`;
}

function renderWrapper(id: string, cliBinary: string): string {
  return `/**
 * ${id} CLI 链式 wrapper（可选）
 *
 * 封装 ${cliBinary} CLI 的 launch/inject/interrupt/stream/extract/transfer。
 * 仅当该 CLI 支持 D6（介入）/ D7（接管）/ D8（流式）时实现。
 * 由 \`ymesh scaffold ${id}\` 生成。规范见 specs/adapter-spec.md。
 */

import { BaseWrapper } from '../sdk/base-wrapper.js';
import type {
  InjectResult,
  LaunchOptions,
  LaunchResult,
  NeutralSession,
  SessionSummary,
  StreamEvent,
} from '../sdk/types.js';

export class ${pascal(id)}Wrapper extends BaseWrapper {
  readonly sourceCli = '${id}';
  readonly cliBinary = '${cliBinary}';

  async launch(prompt: string, opts?: LaunchOptions): Promise<LaunchResult> {
    // TODO: 用 this.spawnCliSync / this.spawnCliAsync 启动 ${cliBinary}
    void opts;
    throw new Error(\`TODO: implement launch (prompt \${prompt.length} chars)\`);
  }

  async inject(sessionId: string, message: string): Promise<InjectResult> {
    // TODO: 中途注入消息到运行中的 session
    return { success: false, sessionId, message: \`TODO: inject: \${message.slice(0, 20)}\` };
  }

  async interrupt(sessionId: string): Promise<void> {
    // TODO: 中断运行中的 session
    this.killRunningProcess(sessionId);
  }

  async *getStream(_sessionId: string): AsyncIterable<StreamEvent> {
    // TODO: 实时读取 session 消息流
    yield { type: 'error', message: 'TODO: implement getStream' };
  }

  listSessions(): SessionSummary[] {
    // TODO: 列出所有 session
    return [];
  }

  extractSession(_sessionId: string): NeutralSession {
    // TODO: 提取 session 为中性格式
    throw new Error('TODO: implement extractSession');
  }
}
`;
}

function renderInjector(id: string, configDir: string): string {
  return `/**
 * ${id} 提示词/扩展注入（可选）
 *
 * 把 ymesh 的 MCP / skill / always-on 指令幂等挂到 ${configDir}/。
 * 仅当该 CLI 支持 D3（MCP）/ D4（Skills）/ D10（Always-on）时实现。
 * 由 \`ymesh scaffold ${id}\` 生成。规范见 specs/adapter-spec.md。
 */

import { BaseInjector } from '../sdk/base-injector.js';

export class ${pascal(id)}Injector extends BaseInjector {
  readonly cliId = '${id}';
  readonly configDir = '${configDir}';

  async injectAll(): Promise<void> {
    // always-on：写入全局指令文件（如该 CLI 读取）
    const instructionFile = this.resolveInstructionFile('AGENTS.md');
    this.injectMarkedBlock(instructionFile);

    // mcp-json：注入 MCP server（如该 CLI 用 JSON mcpServers）
    // this.injectMcpJson(this.resolveConfigFile('mcp.json'), 'yondermesh', {
    //   command: 'ymesh', args: ['mcp', 'serve'],
    // });
  }

  async uninjectAll(): Promise<void> {
    const instructionFile = this.resolveInstructionFile('AGENTS.md');
    this.removeMarkedBlock(instructionFile);
    // this.removeMcpJson(this.resolveConfigFile('mcp.json'), 'yondermesh');
  }
}
`;
}

function renderIndex(id: string): string {
  return `/**
 * ${id} 原生 adapter 模块入口
 *
 * 导出 importer / wrapper / injector。由 \`ymesh scaffold ${id}\` 生成。
 */

export { ${pascal(id)}Importer } from './importer.js';
export type { ${pascal(id)}ImportOptions } from './importer.js';
export { ${pascal(id)}Wrapper } from './wrapper.js';
export { ${pascal(id)}Injector } from './inject.js';
`;
}

/** kebab-case → PascalCase（如 'my-cli' → 'MyCli'） */
function pascal(kebab: string): string {
  return kebab
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}
