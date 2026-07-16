/**
 * trae-cli 上下文注入（MCP via config.yaml；无 Skills/Always-on）
 *
 * trae-cli 无 Skills / Hooks / Always-on（D4❌ D5❌ D6❌ D7⚠️ D8❌ D10❌），
 * 上下文注入仅两条路：
 *   1. MCP：config.yaml 的 `mcp_servers` 字段（trae-agent 原生支持）
 *   2. 系统指令：trae-cli 无独立 --system 参数，通过 config.yaml 的 system_prompt
 *      字段或 -f task 文件中嵌入约定来替代 Always-on。
 *
 * config.yaml 默认位置 ~/.trae-cli/config.yaml（--config-file 可覆盖）。
 *
 * GLM-5.2 接入：provider=openai + base_url=http://127.0.0.1:15721/v1
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** 默认配置目录 */
const DEFAULT_TRAE_CLI_CONFIG_DIR = path.join(os.homedir(), '.trae-cli');
/** 默认 config.yaml 路径 */
export const DEFAULT_CONFIG_FILE = path.join(DEFAULT_TRAE_CLI_CONFIG_DIR, 'config.yaml');

/** 一个 MCP server 描述（config.yaml mcp_servers 条目） */
export interface TraeMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** config.yaml 生成选项 */
export interface TraeCliConfigOptions {
  /** LLM provider，默认 openai */
  provider?: string;
  /** 模型名，默认 glm-5.2 */
  model?: string;
  /** 模型 API base url */
  modelBaseUrl?: string;
  /** 工作目录 */
  workingDir?: string;
  /** 最大步数 */
  maxSteps?: number;
  /** MCP server 表（key=server 名） */
  mcpServers?: Record<string, TraeMcpServer>;
  /** 系统指令（替代 Always-on / Skills；注入到 config.yaml system_prompt） */
  systemPrompt?: string;
}

/**
 * 生成 trae-cli config.yaml 内容。
 *
 * 既有 MCP 注入（mcp_servers）又有系统指令（system_prompt，替代 Always-on）。
 * 写入 ~/.trae-cli/config.yaml 后，trae-cli 启动自动读取。
 *
 * 注意：trae-agent 的 config.yaml 字段名以官方为准；本生成器按 trae-agent
 * v0.1.0 已知字段（provider/model/model_base_url/max_steps/mcp_servers）写出，
 * system_prompt 为最佳实践字段（若版本不支持会被忽略，不致报错）。
 */
export function generateTraeCliConfig(opts: TraeCliConfigOptions = {}): string {
  const lines: string[] = [];
  lines.push('# trae-cli config (~/.trae-cli/config.yaml)');
  lines.push(`provider: ${opts.provider ?? 'openai'}`);
  lines.push(`model: ${opts.model ?? 'glm-5.2'}`);
  lines.push(`model_base_url: ${opts.modelBaseUrl ?? 'http://127.0.0.1:15721/v1'}`);
  if (opts.workingDir) lines.push(`working_dir: ${opts.workingDir}`);
  if (opts.maxSteps !== undefined) lines.push(`max_steps: ${opts.maxSteps}`);

  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    lines.push('mcp_servers:');
    for (const [name, srv] of Object.entries(opts.mcpServers)) {
      lines.push(`  - name: ${name}`);
      lines.push(`    command: ${srv.command}`);
      if (srv.args && srv.args.length > 0) {
        lines.push('    args:');
        for (const a of srv.args) lines.push(`      - ${a}`);
      }
      if (srv.env && Object.keys(srv.env).length > 0) {
        lines.push('    env:');
        for (const [k, v] of Object.entries(srv.env)) lines.push(`      ${k}: ${v}`);
      }
    }
  }

  if (opts.systemPrompt) {
    lines.push('system_prompt: |');
    for (const l of opts.systemPrompt.split('\n')) {
      lines.push(`  ${l}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * 便捷：生成注入了 yondermesh MCP server 的 config.yaml。
 * 让 trae-cli 能调用 yondermesh 的 session 查询 / 转交工具。
 */
export function generateTraeCliConfigWithYondermesh(
  yondermeshMcpCommand: string,
  opts: Omit<TraeCliConfigOptions, 'mcpServers'> = {},
): string {
  return generateTraeCliConfig({
    ...opts,
    mcpServers: {
      yondermesh: { command: yondermeshMcpCommand },
    },
  });
}

/** 系统指令生成选项（替代 Always-on / Skills） */
export interface TraeSystemPromptOptions {
  /** 项目名 */
  projectName?: string;
  /** 额外约定条目 */
  conventions?: string[];
}

/**
 * 生成 trae-cli 的系统指令文本（替代 Always-on AGENTS.md / Skills）。
 * 写入 config.yaml 的 system_prompt 字段，或嵌入到 -f task 文件头部。
 */
export function generateTraeSystemPrompt(opts: TraeSystemPromptOptions = {}): string {
  const lines: string[] = [];
  lines.push(`# ${opts.projectName ?? 'Project'} Agent Conventions`);
  lines.push('');
  lines.push('You are a careful software engineering agent.');
  lines.push('');
  lines.push('## Conventions');
  const conv = opts.conventions ?? [
    'Read existing code before editing; mimic surrounding style.',
    'Never commit unless explicitly asked.',
    'Do not expose or log secrets.',
  ];
  for (const c of conv) lines.push(`- ${c}`);
  return lines.join('\n');
}
