/**
 * Amp 上下文注入（MCP + Skills + Plugin hooks + Always-on）
 *
 * Amp 是四个「能力有限」agent 中能力最齐全的（D1✅ D3✅ D4✅ D7✅ D9✅ D10✅），
 * 支持全部四种注入机制：
 *   - MCP：amp settings.json 的 `amp.mcpServers`，或 CLI `--mcp-config <json|file>`
 *   - Skills：多目录链（AGENTS.md），amp 会从多个目录聚合约定
 *   - Plugin hooks：TypeScript + Bun，5 事件（plugin API）
 *   - Always-on：`~/.config/amp/AGENTS.md`（全局）+ 项目级 AGENTS.md
 *
 * 本模块生成各机制的配置/模板内容，由安装器或转交器写出。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** macOS 默认 amp 配置目录 */
const DEFAULT_AMP_CONFIG_DIR = path.join(os.homedir(), '.config', 'amp');

/** 一个 MCP server 描述（amp settings.json 中的 amp.mcpServers 条目） */
export interface AmpMcpServer {
  /** MCP server 启动命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
}

/** MCP 配置生成选项 */
export interface AmpMcpConfigOptions {
  /** MCP server 表（key=server 名） */
  servers?: Record<string, AmpMcpServer>;
}

/**
 * 生成 amp settings.json 片段（含 amp.mcpServers）的 JSON 字符串。
 * 可写入 ~/.config/amp/settings.json 或通过 `--mcp-config <file>` 传入。
 *
 * amp 的 settings.json 结构（实测）：顶层对象，MCP servers 在 `amp.mcpServers`。
 */
export function generateAmpMcpConfig(opts: AmpMcpConfigOptions = {}): string {
  const obj = {
    amp: {
      mcpServers: opts.servers ?? {},
    },
  };
  return JSON.stringify(obj, null, 2) + '\n';
}

/** 直接生成可被 `--mcp-config '<inline-json>'` 接受的内联 JSON */
export function generateAmpMcpInline(opts: AmpMcpConfigOptions = {}): string {
  return JSON.stringify({ mcpServers: opts.servers ?? {} });
}

/** AGENTS.md（Skills / Always-on 约定）生成选项 */
export interface AmpAgentsMdOptions {
  /** 项目名（用于标题） */
  projectName?: string;
  /** 额外的约定条目（每条一行） */
  conventions?: string[];
  /** 是否为全局（~/.config/amp/AGENTS.md）；全局文案略不同 */
  global?: boolean;
}

/**
 * 生成 AGENTS.md 内容（Skills / Always-on 注入）。
 * amp 会从 ~/.config/amp/AGENTS.md（全局）与项目根 AGENTS.md（项目级）多目录链聚合。
 */
export function generateAmpAgentsMd(opts: AmpAgentsMdOptions = {}): string {
  const lines: string[] = [];
  const title = opts.projectName ?? (opts.global ? 'Global' : 'Project');
  lines.push(`# ${title} Agent Conventions`);
  lines.push('');
  if (opts.global) {
    lines.push('<!-- Global amp AGENTS.md (~/.config/amp/AGENTS.md) — Always-on，对所有 thread 生效 -->');
    lines.push('');
  }
  lines.push('## Role');
  lines.push('You are a careful software engineering agent operating inside this repository.');
  lines.push('');
  lines.push('## Conventions');
  const conv = opts.conventions ?? [
    'Read existing code before editing; mimic surrounding style.',
    'Never commit unless explicitly asked.',
    'Do not expose or log secrets.',
  ];
  for (const c of conv) lines.push(`- ${c}`);
  lines.push('');
  return lines.join('\n');
}

/** amp Plugin hook 事件名（5 个，TypeScript + Bun） */
export const AMP_HOOK_EVENTS = [
  'thread.beforeMessage',
  'thread.afterMessage',
  'thread.onStart',
  'thread.onEnd',
  'thread.onError',
] as const;

export type AmpHookEvent = (typeof AMP_HOOK_EVENTS)[number];

/** Plugin hook 模板生成选项 */
export interface AmpPluginHookOptions {
  /** 需要挂钩的事件，默认全部 5 个 */
  events?: AmpHookEvent[];
  /** hook 要执行的动作（返回字符串或 void） */
  body?: string;
}

/**
 * 生成一个 amp Plugin hook TypeScript 文件内容（Bun 运行时）。
 * amp 的 plugin API 允许在 thread 生命周期的 5 个事件上挂钩 TypeScript 回调。
 */
export function generateAmpPluginHook(opts: AmpPluginHookOptions = {}): string {
  const events = opts.events ?? [...AMP_HOOK_EVENTS];
  const body = opts.body ?? '// hook 逻辑：例如记录 session 摘要、转发到 yondermesh';
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * amp Plugin hook（TypeScript + Bun 运行时）');
  lines.push(' * 由 amp 在 thread 生命周期事件上调用。');
  lines.push(' */');
  lines.push('');
  lines.push('export const config = {');
  lines.push('  events: ' + JSON.stringify(events) + ',');
  lines.push('};');
  lines.push('');
  lines.push('export default async function hook(ctx) {');
  lines.push(`  const event = ctx.event;`);
  lines.push(`  const threadId = ctx.threadId;`);
  lines.push(`  ${body}`);
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/**
 * 探测 amp 配置目录是否存在 Always-on AGENTS.md。
 * 返回全局 AGENTS.md 路径（若存在），否则 undefined。
 */
export function detectGlobalAgentsMd(configDir: string = DEFAULT_AMP_CONFIG_DIR): string | undefined {
  const p = path.join(configDir, 'AGENTS.md');
  try {
    if (fs.statSync(p).isFile()) return p;
  } catch {
    /* 不存在 */
  }
  return undefined;
}
