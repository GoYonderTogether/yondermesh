/**
 * Amp CLI 命令构造器（wrapper）
 *
 * Amp 是 Sourcegraph 的 SaaS agent（ampcode.com）。GLM-5.2 是内置模型
 * （Low 模式默认 amp/glm-5.2），不支持 BYOK，因此 wrapper 不涉及 API key/base url，
 * 仅构造 `amp` 子命令 argv。
 *
 * 可用子命令（amp v0.0.1784031823 实测）：
 *   - threads list [--json] [--include-archived] [--limit N] [--offset N]
 *   - threads export <threadIDOrURL>          （输出完整 thread JSON）
 *   - threads markdown <threadIDOrURL>        （输出可读 markdown）
 *   - threads new [--message "..."]           （新建 thread）
 *   - threads continue <threadIDOrURL>        （继续 thread）
 *   - top / last                               （查看活跃 / 继续最近 thread）
 *
 * 全局选项（对所有子命令有效）：
 *   --mcp-config <value>      JSON 配置或文件路径，合并 MCP servers
 *   --settings-file <value>   自定义 settings.json 路径
 *   --visibility <visibility> private/unlisted/workspace/group
 */

import { spawnSync } from 'node:child_process';

/** 全局 amp 选项（透传到任意子命令） */
export interface AmpGlobalOptions {
  /** MCP 配置 JSON 或文件路径（注入 MCP servers） */
  mcpConfig?: string;
  /** 自定义 settings.json 路径 */
  settingsFile?: string;
  /** thread 可见性 */
  visibility?: 'private' | 'unlisted' | 'workspace' | 'group';
  /** 自定义 amp 可执行路径；默认 'amp' */
  ampBin?: string;
}

/** 把全局选项展开为 argv 片段 */
function globalArgs(g: AmpGlobalOptions = {}): string[] {
  const args: string[] = [];
  if (g.mcpConfig) args.push('--mcp-config', g.mcpConfig);
  if (g.settingsFile) args.push('--settings-file', g.settingsFile);
  if (g.visibility) args.push('--visibility', g.visibility);
  return args;
}

/** 构造 `amp threads list` 命令 */
export function buildAmpListCommand(opts: {
  json?: boolean;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
  global?: AmpGlobalOptions;
} = {}): { bin: string; args: string[] } {
  const args = ['threads', 'list'];
  if (opts.json) args.push('--json');
  if (opts.includeArchived) args.push('--include-archived');
  if (opts.limit !== undefined) args.push('--limit', String(opts.limit));
  if (opts.offset !== undefined) args.push('--offset', String(opts.offset));
  args.push(...globalArgs(opts.global));
  return { bin: opts.global?.ampBin ?? 'amp', args };
}

/** 构造 `amp threads export <id>` 命令（取回完整 thread JSON） */
export function buildAmpExportCommand(
  threadId: string,
  global: AmpGlobalOptions = {},
): { bin: string; args: string[] } {
  return { bin: global.ampBin ?? 'amp', args: ['threads', 'export', threadId, ...globalArgs(global)] };
}

/** 构造 `amp threads markdown <id>` 命令（取回可读 markdown） */
export function buildAmpMarkdownCommand(
  threadId: string,
  global: AmpGlobalOptions = {},
): { bin: string; args: string[] } {
  return { bin: global.ampBin ?? 'amp', args: ['threads', 'markdown', threadId, ...globalArgs(global)] };
}

/** 构造 `amp threads new` 命令（新建一个 thread 并可选附首条消息） */
export function buildAmpNewThreadCommand(opts: {
  message?: string;
  workingDir?: string;
  global?: AmpGlobalOptions;
} = {}): { bin: string; args: string[]; cwd?: string } {
  const args = ['threads', 'new'];
  if (opts.message) args.push('--message', opts.message);
  args.push(...globalArgs(opts.global));
  return { bin: opts.global?.ampBin ?? 'amp', args, cwd: opts.workingDir };
}

/** 构造 `amp threads continue <id>` 命令（继续已有 thread，常用于转交） */
export function buildAmpContinueCommand(
  threadId: string,
  opts: { message?: string; global?: AmpGlobalOptions } = {},
): { bin: string; args: string[] } {
  const args = ['threads', 'continue', threadId];
  if (opts.message) args.push('--message', opts.message);
  args.push(...globalArgs(opts.global));
  return { bin: opts.global?.ampBin ?? 'amp', args };
}

/** inject 调用结果：response 是 agent 回复文本，exitCode 是进程退出码（0=成功） */
export interface AmpInjectResult {
  response: string;
  exitCode: number;
}

/**
 * 向已有 amp thread 注入消息并同步取回回复。
 *
 * 实现方式：调用 buildAmpContinueCommand(sessionId, { message }) 构造
 * `amp threads continue <sessionId> --message <message>` 命令，spawnSync 执行。
 * 返回 stdout 作为 response；若 spawnSync 抛错或 exitCode != 0，response 包含 stderr。
 */
export function inject(sessionId: string, message: string): AmpInjectResult {
  const cmd = buildAmpContinueCommand(sessionId, { message });
  try {
    const result = spawnSync(cmd.bin, cmd.args, {
      encoding: 'utf-8',
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    const exitCode = result.status ?? -1;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    if (exitCode !== 0) {
      // 失败时 response 包含 stderr 帮助排查
      return { response: stderr || stdout || '', exitCode };
    }
    return { response: stdout, exitCode };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { response: msg, exitCode: -1 };
  }
}
