/**
 * Aider 上下文注入（替代 MCP / Skills / Hooks）
 *
 * Aider 没有任何 MCP / Skills / Hooks 机制（D3/D4/D5/D6/D8 全部 ❌），
 * 只能用「只读文件 + 配置文件」把规范与上下文喂进会话：
 *   - `--read <file>`：把文件以只读方式加入 chat（CONVENTIONS.md / 架构文档等）
 *   - `.aider.conf.yml`：项目级 aider 配置（默认模型 / 开关 / read 列表）
 *   - `CONVENTIONS.md`：per-project 约定（D10 ⚠️，需用户显式 --read）
 *
 * 本模块提供：
 *   - buildReadArgs：把一组只读文件展开为 `--read f1 --read f2 ...`
 *   - generateAiderConfYml：生成 .aider.conf.yml 内容（可由转交器/安装器写出）
 *   - buildConventionsReadArgs：便捷地把项目根下的 CONVENTIONS.md / 约定文件加入
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Aider 推荐的 per-project 约定文件名（D10：需显式 --read） */
export const CONVENTIONS_FILENAME = 'CONVENTIONS.md';

/** 其它常见约定文件名（按优先级降序尝试） */
export const CONVENTIONS_CANDIDATES = [
  'CONVENTIONS.md',
  'AGENTS.md',
  '.cursorrules',
  '.aider.rules',
];

/**
 * 把一组只读文件展开为 aider `--read` 参数序列。
 * 不校验文件存在性（由调用方决定是否提前 stat）；空数组返回空。
 */
export function buildReadArgs(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    out.push('--read', f);
  }
  return out;
}

/**
 * 探测项目根下存在的约定文件，返回应作为 --read 注入的路径列表。
 * 找不到任何候选时返回空数组（调用方可决定是否回退到默认 CONVENTIONS.md）。
 */
export function detectConventionFiles(projectDir: string): string[] {
  const found: string[] = [];
  for (const name of CONVENTIONS_CANDIDATES) {
    const p = path.join(projectDir, name);
    try {
      if (fs.statSync(p).isFile()) found.push(p);
    } catch {
      /* 不存在 → 跳过 */
    }
  }
  return found;
}

/**
 * 便捷：返回把项目约定加入 aider 所需的 `--read` 参数。
 * 若 projectDir 下有 CONVENTIONS.md（或候选），则注入；否则注入默认名（aider 会报缺失）。
 * includeDefault=true 时即便文件不存在也加入 CONVENTIONS.md（用于首次创建场景）。
 */
export function buildConventionsReadArgs(
  projectDir: string,
  opts: { includeDefaultIfMissing?: boolean } = {},
): string[] {
  const detected = detectConventionFiles(projectDir);
  if (detected.length > 0) {
    return buildReadArgs(detected);
  }
  if (opts.includeDefaultIfMissing) {
    return buildReadArgs([path.join(projectDir, CONVENTIONS_FILENAME)]);
  }
  return [];
}

/** .aider.conf.yml 生成选项 */
export interface AiderConfYmlOptions {
  /** 默认模型 litellm 名，默认 openai/glm-5.2 */
  model?: string;
  /** 默认只读注入文件（read 列表） */
  readFiles?: string[];
  /** 是否关闭自动 commit，默认 true */
  noAutoCommits?: boolean;
  /** 是否关闭 pretty 输出，默认 true */
  noPretty?: boolean;
  /** 是否 always yes，默认 true */
  yesAlways?: boolean;
}

/**
 * 生成 .aider.conf.yml 内容（项目级 aider 配置）。
 * 写入 <cwd>/.aider.conf.yml 后，aider 启动会自动读取，等效于「Always-on 注入」。
 */
export function generateAiderConfYml(opts: AiderConfYmlOptions = {}): string {
  const lines: string[] = [];
  lines.push(`model: ${opts.model ?? 'openai/glm-5.2'}`);
  if (opts.readFiles && opts.readFiles.length > 0) {
    lines.push('read:');
    for (const f of opts.readFiles) {
      lines.push(`  - ${f}`);
    }
  }
  if (opts.noAutoCommits ?? true) lines.push('auto-commits: false');
  if (opts.noPretty ?? true) lines.push('pretty: false');
  if (opts.yesAlways ?? true) lines.push('yes-always: true');
  return lines.join('\n') + '\n';
}
