/**
 * trigger-resume-args.test.ts — 「续接 session 并发一条消息」的参数语法
 *
 * 为什么值得一个专门的测试：投递链路真跑起来之后（PATH 修好之前它连 CLI 都
 * 启动不了，所以这个坑一直是隐藏的），才发现所有 CLI 都被喂了同一套
 * `--resume <sid> --message <msg>`。实际语法各不相同，实测报错：
 *   codex → error: unexpected argument '--resume' found
 * 用户看到的现象只是"消息发了没人收到"。
 *
 * 这里锁住已验证的语法（都对着各 CLI 的 --help 核过），任何改动都必须同步更新。
 */

import { describe, it, expect } from 'vitest';
import { CLI_RESUME_COMMANDS } from '../src/trigger/adapter.js';

describe('CLI 续接语法', () => {
  const SID = 'abc-123';
  const PROMPT = 'hello';

  it('codex：exec resume <SESSION_ID> <PROMPT>（不是 --resume）', () => {
    expect(CLI_RESUME_COMMANDS.codex?.(SID, PROMPT)).toEqual(['exec', 'resume', SID, PROMPT]);
  });

  it('claude：-p <PROMPT> --resume <SESSION_ID>', () => {
    expect(CLI_RESUME_COMMANDS.claude?.(SID, PROMPT)).toEqual(['-p', PROMPT, '--resume', SID]);
    expect(CLI_RESUME_COMMANDS['claude-code']?.(SID, PROMPT)).toEqual(['-p', PROMPT, '--resume', SID]);
  });

  it('pi：--session <SESSION_ID> <PROMPT>', () => {
    expect(CLI_RESUME_COMMANDS.pi?.(SID, PROMPT)).toEqual(['--session', SID, PROMPT]);
  });

  it('model 参数透传给支持它的 CLI', () => {
    expect(CLI_RESUME_COMMANDS.codex?.(SID, PROMPT, { model: 'gpt-5' })).toContain('-m');
    expect(CLI_RESUME_COMMANDS.claude?.(SID, PROMPT, { model: 'opus' })).toContain('--model');
  });

  it('未适配的 CLI 不在表里 → 调用方给明确错误，而不是拿通用参数硬试', () => {
    expect(CLI_RESUME_COMMANDS['aider']).toBeUndefined();
    expect(CLI_RESUME_COMMANDS['windsurf']).toBeUndefined();
  });
});
