/**
 * TriggerAdapter 路由单测（loop: verify-trigger-reply-adapter）
 *
 * 测试 3 模式路由（stopped / running / new）+ IDE CLI 通道选择 + getCapability 分类。
 * 用 FakeTriggerAdapter（extends TriggerAdapter，override trigger()）作为可复用测试替身，
 * 验证 3 模式契约；同时对真实 TriggerAdapter.trigger() 的错误路径与路由决策做断言。
 *
 * 不真正 spawn 进程：用 vi.mock('node:child_process') 把 spawnSync/spawn 替换为 fake。
 * 真实 TriggerAdapter 的"未知 CLI"路径天然不 spawn（BIN_MAP/registry 返回 undefined/null）。
 *
 * 对应 roadmap T3.2。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── mock node:child_process：默认所有 spawnSync 返回"命令未找到" ─────────
//   hoisted 到 import 之前；per-test 用 vi.mocked(spawnSync).mockImplementationOnce 覆盖。
vi.mock('node:child_process', () => {
  const fakeSpawnSync = vi.fn(
    (
      _cmd: string,
      _args?: readonly string[] | null,
      _opts?: Record<string, unknown>,
    ) => ({
      status: 1,
      stdout: '',
      stderr: 'command not found',
      error: undefined as Error | undefined,
    }),
  );
  const fakeSpawn = vi.fn(() => ({
    stdout: { on: () => {}, setEncoding: () => {} },
    stderr: { on: () => {}, setEncoding: () => {} },
    on: () => {},
    kill: () => {},
    pid: -1,
  }));
  return { spawnSync: fakeSpawnSync, spawn: fakeSpawn };
});

import { spawnSync } from 'node:child_process';

import { TriggerAdapter } from '../src/trigger/index.js';
import type {
  TriggerRequest,
  TriggerResult,
  TriggerMode,
  TriggerChannel,
} from '../src/trigger/index.js';

// ─── FakeTriggerAdapter：可复用测试替身 ─────────────────────────────────────
//
// 继承 TriggerAdapter，override trigger() 返回按模式分发的 canned 结果。
// 用于：① 验证 3 模式路由契约；② 其他需要 TriggerAdapter 依赖的测试（如 mailbox）
// 注入此 fake 避免真 spawn。cannedResponse 字段可覆盖默认行为以模拟错误等场景。
//
// 设计：保留 getCapability/listCapabilities 真实实现（这些是纯查询，无副作用）。
export class FakeTriggerAdapter extends TriggerAdapter {
  public readonly calls: TriggerRequest[] = [];
  public cannedResponse: TriggerResult | null = null;

  override async trigger(req: TriggerRequest): Promise<TriggerResult> {
    this.calls.push(req);
    if (this.cannedResponse) return { ...this.cannedResponse };
    switch (req.mode) {
      case 'stopped':
        return {
          delivered: true,
          response: `stopped-reply:${req.message}`,
          exitCode: 0,
          channel: 'cli-spawn',
          latencyMs: 1,
        };
      case 'running':
        return {
          delivered: true,
          response: `running-reply:${req.message}`,
          channel: 'stdin',
          latencyMs: 1,
        };
      case 'new':
        return {
          delivered: true,
          response: `new-reply:${req.message}`,
          newSessionId: 'fake-session-id',
          channel: 'cli-spawn',
          latencyMs: 1,
        };
      default:
        return {
          delivered: false,
          response: '',
          channel: 'cli-spawn',
          latencyMs: 0,
          error: `未知模式: ${String(req.mode)}`,
        };
    }
  }
}

// ─── 辅助 ────────────────────────────────────────────────────────────────────

function mkReq(
  partial: Partial<TriggerRequest> &
    Pick<TriggerRequest, 'cli' | 'message' | 'mode'>,
): TriggerRequest {
  return {
    cli: partial.cli,
    message: partial.message,
    mode: partial.mode,
    sessionId: partial.sessionId,
    model: partial.model,
    effort: partial.effort,
    cwd: partial.cwd,
    timeoutMs: partial.timeoutMs ?? 5000,
  };
}

// ─── getCapability：CLI 分类（纯查询，无 spawn 副作用）────────────────────────

describe('TriggerAdapter.getCapability — CLI 分类', () => {
  const adapter = new TriggerAdapter();

  it('IDE 类 CLI (trae-ide)：modes=[running,new]，primaryChannel=tmux，fallbackChannel=applescript', () => {
    const cap = adapter.getCapability('trae-ide');
    expect(cap.cli).toBe('trae-ide');
    expect(cap.modes).toEqual(['running', 'new']);
    expect(cap.primaryChannel).toBe('tmux');
    expect(cap.fallbackChannel).toBe('applescript');
    expect(cap.wrapperInject).toBe(false); // IDE 类没有 wrapper inject
    expect(cap.notes).toContain('tmux');
  });

  it('IDE 类 CLI (windsurf/cursor-ide/chatgpt) 同分类', () => {
    for (const cli of ['windsurf', 'cursor-ide', 'chatgpt']) {
      const cap = adapter.getCapability(cli);
      expect(cap.modes).toEqual(['running', 'new']);
      expect(cap.primaryChannel).toBe('tmux');
      expect(cap.fallbackChannel).toBe('applescript');
    }
  });

  it('HTTP API 类 CLI (opencode)：modes=[stopped,running,new]，primaryChannel=http-api', () => {
    const cap = adapter.getCapability('opencode');
    expect(cap.modes).toEqual(['stopped', 'running', 'new']);
    expect(cap.primaryChannel).toBe('http-api');
    expect(cap.fallbackChannel).toBeUndefined();
    expect(cap.wrapperInject).toBe(true);
  });

  it('HTTP API 类 CLI (openhands/qwen) 同分类', () => {
    for (const cli of ['openhands', 'qwen']) {
      const cap = adapter.getCapability(cli);
      expect(cap.modes).toEqual(['stopped', 'running', 'new']);
      expect(cap.primaryChannel).toBe('http-api');
    }
  });

  it('WS-RPC 类 CLI (kimi)：modes=[stopped,running,new]，primaryChannel=ws-rpc', () => {
    const cap = adapter.getCapability('kimi');
    expect(cap.modes).toEqual(['stopped', 'running', 'new']);
    expect(cap.primaryChannel).toBe('ws-rpc');
    expect(cap.wrapperInject).toBe(true);
  });

  it('WS-RPC 类 CLI (openclaw/pi/copilot) 同分类', () => {
    for (const cli of ['openclaw', 'pi', 'copilot']) {
      const cap = adapter.getCapability(cli);
      expect(cap.modes).toEqual(['stopped', 'running', 'new']);
      expect(cap.primaryChannel).toBe('ws-rpc');
    }
  });

  it('常规 CLI (claude)：modes=[stopped,new]，primaryChannel=cli-spawn', () => {
    const cap = adapter.getCapability('claude');
    expect(cap.modes).toEqual(['stopped', 'new']);
    expect(cap.primaryChannel).toBe('cli-spawn');
    expect(cap.fallbackChannel).toBeUndefined();
    expect(cap.wrapperInject).toBe(true);
  });

  it('未知 CLI：installed=false，primaryChannel=cli-spawn（保守默认）', () => {
    const cap = adapter.getCapability('not-a-real-cli');
    expect(cap.installed).toBe(false);
    expect(cap.primaryChannel).toBe('cli-spawn');
    expect(cap.modes).toEqual(['stopped', 'new']);
  });

  it('listCapabilities 返回所有 BIN_MAP 条目（≥20 个 CLI）', () => {
    const caps = adapter.listCapabilities();
    expect(caps.length).toBeGreaterThanOrEqual(20);
    const ids = caps.map((c) => c.cli);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(ids).toContain('hermes');
    expect(ids).toContain('trae-ide');
    expect(ids).toContain('opencode');
    expect(ids).toContain('kimi');
  });

  it('IDE 类 notes 字段非空（提示 tmux/applescript）', () => {
    const cap = adapter.getCapability('cursor-ide');
    expect(cap.notes).toBeTruthy();
    expect(cap.notes).toContain('applescript');
  });
});

// ─── trigger() 3 模式路由：纯错误路径（无 spawn）─────────────────────────────

describe('TriggerAdapter.trigger — 3 模式路由（纯错误路径，未知 CLI 不 spawn）', () => {
  const adapter = new TriggerAdapter();

  it('stopped 模式无 sessionId → delivered=false + error 含 "sessionId"', async () => {
    const r = await adapter.trigger(
      mkReq({ cli: 'claude', message: 'hi', mode: 'stopped' }),
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toContain('sessionId');
    expect(r.channel).toBe('cli-spawn');
  });

  it('running 模式无 sessionId → delivered=false + error 含 "sessionId"', async () => {
    const r = await adapter.trigger(
      mkReq({ cli: 'claude', message: 'hi', mode: 'running' }),
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toContain('sessionId');
  });

  it('stopped 模式 + 未知 CLI + sessionId → fallbackSpawn 返回 "未知 CLI"（无 spawn）', async () => {
    const r = await adapter.trigger(
      mkReq({
        cli: 'unknown-cli-xxx',
        message: 'hi',
        mode: 'stopped',
        sessionId: 'sid-1',
      }),
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toContain('未知 CLI');
    expect(r.channel).toBe('cli-spawn');
  });

  it('running 模式 + 未知 CLI + sessionId → 同 stopped 路径（fallbackSpawn）', async () => {
    const r = await adapter.trigger(
      mkReq({
        cli: 'unknown-cli-xxx',
        message: 'hi',
        mode: 'running',
        sessionId: 'sid-2',
      }),
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toContain('未知 CLI');
  });

  it('new 模式 + 未知 CLI → delivered=false + error 含 "不支持 new 模式"', async () => {
    const r = await adapter.trigger(
      mkReq({ cli: 'unknown-cli-xxx', message: 'hi', mode: 'new' }),
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toContain('不支持 new 模式');
    expect(r.channel).toBe('cli-spawn');
  });

  it('未知模式 → delivered=false + error 含 "未知模式"', async () => {
    const r = await adapter.trigger(
      mkReq({
        cli: 'claude',
        message: 'hi',
        mode: 'unknown-mode' as TriggerMode,
      }),
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toContain('未知模式');
  });
});

// ─── trigger() IDE CLI 路由（mock spawnSync）────────────────────────────────

describe('TriggerAdapter.trigger — IDE CLI 路由（mock child_process）', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockClear();
  });
  afterEach(() => {
    vi.mocked(spawnSync).mockReset();
    // 恢复默认 mock（命令未找到）
    vi.mocked(spawnSync).mockImplementation(
      () => ({ status: 1, stdout: '', stderr: 'command not found', error: undefined }),
    );
  });

  it('IDE CLI new 模式 + tmux 未安装 → delivered=false（tmux 通道失败）', async () => {
    // 默认 mock：spawnSync 返回 status=1（命令未找到）
    const adapter = new TriggerAdapter();
    const r = await adapter.trigger(
      mkReq({ cli: 'trae-ide', message: 'hi', mode: 'new', timeoutMs: 1000 }),
    );
    expect(r.delivered).toBe(false);
    // tmux 通道失败后，macOS 会走 applescript；非 macOS 直接返回 tmux 结果
    // 两者都 delivered=false
    expect(r.channel === 'tmux' || r.channel === 'applescript').toBe(true);
    expect(r.error).toBeTruthy();
  });

  it('IDE CLI running 模式 + tmux 未安装 → delivered=false', async () => {
    const adapter = new TriggerAdapter();
    const r = await adapter.trigger(
      mkReq({ cli: 'windsurf', message: 'hi', mode: 'running', timeoutMs: 1000 }),
    );
    expect(r.delivered).toBe(false);
    expect(r.channel === 'tmux' || r.channel === 'applescript').toBe(true);
  });

  it('IDE CLI new 模式调用了 spawnSync（验证走 tmux 通道）', async () => {
    const adapter = new TriggerAdapter();
    await adapter.trigger(
      mkReq({ cli: 'trae-ide', message: 'hi', mode: 'new', timeoutMs: 500 }),
    );
    expect(spawnSync).toHaveBeenCalled();
    // tmux 的存在性现在由共享解析器判断（cli-path：PATH → 常见安装目录回退），
    // 所以不再保证"第一次 spawnSync 是 which tmux"。这里改为断言
    // 确实走了 tmux 通道 —— 即 spawnSync 里出现过 tmux 命令。
    const calls = vi.mocked(spawnSync).mock.calls.map((c) => c[0]);
    expect(calls.some((bin) => String(bin).includes('tmux'))).toBe(true);
  });
});

// ─── trigger() stopped 模式：spy fallbackSpawn 验证路由 ──────────────────────

describe('TriggerAdapter.trigger — stopped 模式路由到 fallbackSpawn（spy 验证）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stopped 模式 + sessionId + wrapper inject 返回 null → 调用 fallbackSpawn', async () => {
    const adapter = new TriggerAdapter();
    // 未知 CLI：callWrapperInject 返回 null（registry 无 wrapperLoader）
    // → 走 this.fallbackSpawn → BIN_MAP 无条目 → 返回 "未知 CLI"（不 spawn）
    const spy = vi.spyOn(
      TriggerAdapter.prototype as unknown as {
        fallbackSpawn: (req: TriggerRequest, start: number) => TriggerResult;
      },
      'fallbackSpawn',
    );

    const r = await adapter.trigger(
      mkReq({
        cli: 'unknown-cli-spy',
        message: 'hi',
        mode: 'stopped',
        sessionId: 'sid-x',
      }),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.delivered).toBe(false);
    expect(r.error).toContain('未知 CLI');
  });

  it('FakeTriggerAdapter 覆盖 fallbackSpawn 也不影响 fake 的 trigger（fake 不调用真实方法）', async () => {
    const fake = new FakeTriggerAdapter();
    const spy = vi.spyOn(
      TriggerAdapter.prototype as unknown as {
        fallbackSpawn: (req: TriggerRequest, start: number) => TriggerResult;
      },
      'fallbackSpawn',
    );
    const r = await fake.trigger(
      mkReq({ cli: 'whatever', message: 'hi', mode: 'stopped', sessionId: 's' }),
    );
    // fake.trigger override 后不再走真实路由，故 fallbackSpawn 不被调用
    expect(spy).not.toHaveBeenCalled();
    expect(r.delivered).toBe(true);
    expect(r.response).toBe('stopped-reply:hi');
    spy.mockRestore();
  });
});

// ─── FakeTriggerAdapter：3 模式路由契约 ─────────────────────────────────────

describe('FakeTriggerAdapter — 3 模式路由契约', () => {
  it('stopped 模式返回 canned stopped-reply', async () => {
    const fake = new FakeTriggerAdapter();
    const r = await fake.trigger(
      mkReq({ cli: 'claude', message: 'hi', mode: 'stopped', sessionId: 's1' }),
    );
    expect(r.delivered).toBe(true);
    expect(r.response).toBe('stopped-reply:hi');
    expect(r.channel).toBe('cli-spawn');
    expect(r.exitCode).toBe(0);
  });

  it('running 模式返回 canned running-reply', async () => {
    const fake = new FakeTriggerAdapter();
    const r = await fake.trigger(
      mkReq({ cli: 'codex', message: 'hello', mode: 'running', sessionId: 's2' }),
    );
    expect(r.delivered).toBe(true);
    expect(r.response).toBe('running-reply:hello');
    expect(r.channel).toBe('stdin');
  });

  it('new 模式返回 canned new-reply + newSessionId', async () => {
    const fake = new FakeTriggerAdapter();
    const r = await fake.trigger(
      mkReq({ cli: 'hermes', message: 'start', mode: 'new' }),
    );
    expect(r.delivered).toBe(true);
    expect(r.response).toBe('new-reply:start');
    expect(r.newSessionId).toBe('fake-session-id');
    expect(r.channel).toBe('cli-spawn');
  });

  it('记录所有调用（calls 数组）', async () => {
    const fake = new FakeTriggerAdapter();
    await fake.trigger(mkReq({ cli: 'a', message: 'm1', mode: 'new' }));
    await fake.trigger(
      mkReq({ cli: 'b', message: 'm2', mode: 'stopped', sessionId: 's' }),
    );
    await fake.trigger(
      mkReq({ cli: 'c', message: 'm3', mode: 'running', sessionId: 's' }),
    );
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]!.cli).toBe('a');
    expect(fake.calls[1]!.cli).toBe('b');
    expect(fake.calls[2]!.cli).toBe('c');
    expect(fake.calls.map((c) => c.mode)).toEqual(['new', 'stopped', 'running']);
  });

  it('cannedResponse 覆盖默认行为（模拟错误）', async () => {
    const fake = new FakeTriggerAdapter();
    fake.cannedResponse = {
      delivered: false,
      response: '',
      channel: 'cli-spawn',
      latencyMs: 0,
      error: 'injected-failure',
    };
    const r = await fake.trigger(
      mkReq({ cli: 'x', message: 'y', mode: 'new' }),
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBe('injected-failure');
  });

  it('保留 TriggerAdapter.getCapability 真实实现（不 override 查询方法）', () => {
    const fake = new FakeTriggerAdapter();
    const cap = fake.getCapability('claude');
    expect(cap.modes).toEqual(['stopped', 'new']);
    expect(cap.primaryChannel).toBe('cli-spawn');
    // listCapabilities 也应可用
    expect(fake.listCapabilities().length).toBeGreaterThan(0);
  });
});

// ─── TriggerResult 字段约束 ─────────────────────────────────────────────────

describe('TriggerAdapter.trigger — 返回值字段约束', () => {
  it('错误路径返回的 channel 是合法 TriggerChannel', async () => {
    const adapter = new TriggerAdapter();
    const validChannels: TriggerChannel[] = [
      'cli-spawn',
      'stdin',
      'http-api',
      'ws-rpc',
      'tmux',
      'applescript',
    ];
    const r = await adapter.trigger(
      mkReq({ cli: 'unknown', message: 'x', mode: 'stopped', sessionId: 's' }),
    );
    expect(validChannels).toContain(r.channel);
  });

  it('错误路径返回的 latencyMs 非负', async () => {
    const adapter = new TriggerAdapter();
    const r = await adapter.trigger(
      mkReq({ cli: 'unknown', message: 'x', mode: 'new' }),
    );
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
