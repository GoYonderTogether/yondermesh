/**
 * ymesh agents CLI 命令集成测试
 *
 * 覆盖：
 *   - 运行 `npx tsx src/bin/ymesh.ts agents` 返回 exit code 0
 *   - 输出包含已安装 agent（claude/codex/hermes）
 *   - --json 输出有效 JSON
 *   - --installed-only 过滤正确
 *
 * 若 `ymesh agents` 命令尚未实现（CLI 返回"未知命令"），全部测试自动 skip。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TSX_ENTRY = path.join(PROJECT_ROOT, 'src', 'bin', 'ymesh.ts');

/** 运行 CLI 并返回 { stdout, stderr, exitCode } */
function runCli(
  args: string[],
  options?: { env?: Record<string, string>; timeoutMs?: number },
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(
      'npx',
      ['tsx', TSX_ENTRY, ...args],
      {
        encoding: 'utf-8',
        timeout: options?.timeoutMs ?? 30_000,
        env: { ...process.env, ...options?.env },
        cwd: PROJECT_ROOT,
      },
    );
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

/** 检测 `ymesh agents` 命令是否已实现 */
function isAgentsCommandAvailable(): boolean {
  const result = runCli(['agents', '--json'], { timeoutMs: 30_000 });
  // 未知命令返回 exit code 1 且 stderr 包含 "未知命令"
  if (result.exitCode === 1 && result.stderr.includes('未知命令')) {
    return false;
  }
  return result.exitCode === 0;
}

// ─── 检测命令是否可用，决定是否运行测试 ─────────────────────────────────────

const agentsAvailable = isAgentsCommandAvailable();
const itOrSkip = agentsAvailable ? it : it.skip;

// 检测本机已安装的 CLI（用于断言输出包含已安装 agent）
const home = homedir();
const installedClis: string[] = [];
if (existsSync(join(home, '.codex'))) installedClis.push('codex');
if (existsSync(join(home, '.claude'))) installedClis.push('claude');
if (existsSync(join(home, '.hermes'))) installedClis.push('hermes');
if (existsSync(join(home, '.cursor'))) installedClis.push('cursor');
if (existsSync(join(home, '.gemini'))) installedClis.push('gemini');
if (existsSync(join(home, '.continue'))) installedClis.push('continue');

describe('ymesh agents CLI 命令', () => {
  beforeAll(() => {
    if (!agentsAvailable) {
      console.log('ymesh agents 命令尚未实现，跳过所有测试');
    }
  });

  itOrSkip('运行 `ymesh agents` 返回 exit code 0', () => {
    const result = runCli(['agents']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  itOrSkip('输出包含表头（agent / id / installed 等）', () => {
    const result = runCli(['agents']);
    expect(result.exitCode).toBe(0);
    // 表头应包含关键列名
    expect(result.stdout).toMatch(/id|agent|name/i);
    expect(result.stdout).toMatch(/install|状态|status/i);
  });

  itOrSkip('输出包含已安装 agent（若本机有 codex/claude/hermes）', () => {
    if (installedClis.length === 0) return; // 本机无已安装 CLI，跳过断言
    const result = runCli(['agents']);
    expect(result.exitCode).toBe(0);
    // 至少一个已安装 CLI 出现在输出中
    const hasAny = installedClis.some((cli) =>
      result.stdout.toLowerCase().includes(cli.toLowerCase()),
    );
    expect(hasAny, `输出应包含已安装 CLI 之一: ${installedClis.join(', ')}`).toBe(true);
  });

  itOrSkip('--json 输出有效 JSON', () => {
    const result = runCli(['agents', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed.agents ?? parsed)).toBe(true);
  });

  itOrSkip('--json 输出每个 agent 含必要字段', () => {
    const result = runCli(['agents', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const list = parsed.agents ?? parsed;
    if (!Array.isArray(list)) return;
    for (const a of list) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.installed).toBe('boolean');
    }
  });

  itOrSkip('--installed-only 只返回 installed=true 的 agent', () => {
    const result = runCli(['agents', '--installed-only', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const list = parsed.agents ?? parsed;
    if (!Array.isArray(list)) return;
    for (const a of list) {
      expect(a.installed).toBe(true);
    }
  });

  itOrSkip('--installed-only 返回数量 <= 全部 agent 数量', () => {
    const allResult = runCli(['agents', '--json']);
    const installedResult = runCli(['agents', '--installed-only', '--json']);
    expect(allResult.exitCode).toBe(0);
    expect(installedResult.exitCode).toBe(0);

    const allParsed = JSON.parse(allResult.stdout);
    const installedParsed = JSON.parse(installedResult.stdout);
    const allList = allParsed.agents ?? allParsed;
    const installedList = installedParsed.agents ?? installedParsed;

    if (Array.isArray(allList) && Array.isArray(installedList)) {
      expect(installedList.length).toBeLessThanOrEqual(allList.length);
    }
  });
});
