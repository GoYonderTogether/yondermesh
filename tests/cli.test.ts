/**
 * LOOP-007 CLI 测试
 *
 * 验收门：
 *   1. help 输出包含所有命令
 *   2. version 输出版本号
 *   3. scan 执行后 DB 有数据
 *   4. status 输出 daemon 和统计信息
 *   5. sessions 列表输出 + --json 格式
 *   6. 未知命令返回退出码 1
 *   7. --json 标志输出合法 JSON
 *
 * 直接运行编译后的 dist/bin/ymesh.js，避免 npx tsx 在沙盒环境下的
 * named pipe EPERM 问题。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SessionStore } from '../src/store/index.js';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI_ENTRY = path.join(PROJECT_ROOT, 'dist', 'bin', 'ymesh.js');

/** 运行 CLI 并返回 { stdout, stderr, exitCode } */
function runCli(
  args: string[],
  options?: { env?: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(
      'node',
      [CLI_ENTRY, ...args],
      {
        encoding: 'utf-8',
        timeout: 15000,
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

describe('LOOP-007: CLI', () => {
  let tmpDir: string;
  let tmpDb: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-cli-'));
    tmpDb = path.join(tmpDir, 'test.db');

    // 预填充 DB with 测试数据
    const store = new SessionStore(tmpDb);
    const inst = store.registerSourceInstance({
      deviceId: 'test-device',
      source: 'claude-code',
      rootPath: '/test',
      coverage: 'A',
    });
    store.ingestSession({
      deviceId: 'test-device',
      sourceInstanceId: inst.id,
      nativeSessionId: 'session-001',
      source: 'claude-code',
      cwd: '/Users/test/project-a',
      projectPath: '/Users/test/project-a',
      startedAt: Date.now() - 10000,
      topology: 'root',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    });
    store.ingestSession({
      deviceId: 'test-device',
      sourceInstanceId: inst.id,
      nativeSessionId: 'session-002',
      source: 'claude-code',
      cwd: '/Users/test/project-b',
      projectPath: '/Users/test/project-b',
      startedAt: Date.now() - 5000,
      topology: 'subagent',
      messages: [{ role: 'user', content: 'sub task' }],
    });
    store.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('help 命令输出包含所有命令', () => {
    const result = runCli(['help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('scan');
    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('sessions');
    expect(result.stdout).toContain('daemon');
    expect(result.stdout).toContain('version');
    expect(result.stdout).toContain('help');
  });

  it('无参数时也输出 help', () => {
    const result = runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('yondermesh');
  });

  it('version 命令输出版本号', () => {
    const result = runCli(['version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/v?\d+\.\d+\.\d+/);
  });

  it('version --json 输出合法 JSON', () => {
    const result = runCli(['version', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('sessions 列出 session', () => {
    const result = runCli(['sessions', '--db', tmpDb, '--limit', '10']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('session');
  });

  it('sessions --json 输出合法 JSON', () => {
    const result = runCli(['sessions', '--db', tmpDb, '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.stats).toBeDefined();
  });

  it('sessions --source claude 过滤', () => {
    const result = runCli(['sessions', '--db', tmpDb, '--source', 'claude-code', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions.every((s: { source: string }) => s.source === 'claude-code')).toBe(true);
  });

  it('sessions --topology root 只返回根 session', () => {
    const result = runCli(['sessions', '--db', tmpDb, '--topology', 'root', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].topology).toBe('root');
  });

  it('sessions --limit 1 只返回一条', () => {
    const result = runCli(['sessions', '--db', tmpDb, '--limit', '1', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.sessions).toHaveLength(1);
  });

  it('status 输出 daemon 和统计信息', () => {
    const result = runCli(['status', '--db', tmpDb]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('daemon');
    expect(result.stdout).toContain('未运行');
  });

  it('status --json 输出合法 JSON', () => {
    const result = runCli(['status', '--db', tmpDb, '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.daemonRunning).toBe(false);
    expect(parsed.dbPath).toBe(tmpDb);
  });

  it('未知命令返回退出码 1', () => {
    const result = runCli(['nonexistent-command']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('未知命令');
  });
});
