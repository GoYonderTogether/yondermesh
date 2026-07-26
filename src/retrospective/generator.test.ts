/**
 * generator.test.ts — 复盘数据组装测试
 *
 * 验收门（loop build-retrospective §B）：
 *   B1. 输入 { sessionId, store }，输出 RetrospectiveFact
 *   B2. 必含字段：originalNeed / toolCalls / toolCallCount / detours /
 *       stuckSegments / sessionMeta / firstUserMessageAt / durationSec
 *   B3. 不调用 LLM；不写文件；只读 store
 *
 * 测试用例：空 session / 1 消息 / 多 tool_call / 命中失败模式
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../store/index.js';
import type { SessionIngestInput } from '../store/index.js';
import { generateRetrospective } from './generator.js';

const DEVICE = 'mac-test';

function freshStore(): SessionStore {
  return new SessionStore(':memory:');
}

function registerInstance(store: SessionStore): string {
  const r = store.registerSourceInstance({
    deviceId: DEVICE,
    source: 'claude-code',
    rootPath: '/home/.claude/projects',
    coverage: 'A',
  });
  return r.id;
}

function mkSession(opts: {
  store: SessionStore;
  sourceInstanceId: string;
  messages: { role: 'user' | 'assistant' | 'system' | 'tool'; content: string; timestamp?: number }[];
  startedAt?: number;
  fileModifiedAt?: number;
  cwd?: string;
  projectPath?: string;
}): string {
  const input: SessionIngestInput = {
    deviceId: DEVICE,
    sourceInstanceId: opts.sourceInstanceId,
    nativeSessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'claude-code',
    cwd: opts.cwd ?? '/repo/test',
    projectPath: opts.projectPath ?? '/repo/test',
    startedAt: opts.startedAt ?? Date.now() - 60_000,
    fileModifiedAt: opts.fileModifiedAt ?? Date.now(),
    messages: opts.messages,
  };
  const r = opts.store.ingestSession(input);
  return r.sessionId;
}

describe('generateRetrospective', () => {
  let store: SessionStore;
  let instId: string;

  beforeEach(() => {
    store = freshStore();
    instId = registerInstance(store);
  });

  afterEach(() => {
    store.close();
  });

  it('B1/B2: 输出含全部必含字段', () => {
    const sid = mkSession({
      store,
      sourceInstanceId: instId,
      messages: [
        { role: 'user', content: '帮我修复 bug' },
        { role: 'assistant', content: '好的' },
      ],
    });
    const fact = generateRetrospective({ sessionId: sid, store });
    expect(fact).toHaveProperty('sessionId', sid);
    expect(fact).toHaveProperty('originalNeed');
    expect(fact).toHaveProperty('toolCalls');
    expect(fact).toHaveProperty('toolCallCount');
    expect(fact).toHaveProperty('detours');
    expect(fact).toHaveProperty('stuckSegments');
    expect(fact).toHaveProperty('sessionMeta');
    expect(fact).toHaveProperty('firstUserMessageAt');
    expect(fact).toHaveProperty('durationSec');
    expect(fact.sessionMeta.source).toBe('claude-code');
    expect(fact.sessionMeta.messageCount).toBe(2);
  });

  it('边界 1：空 session（无消息）不崩', () => {
    const sid = mkSession({
      store,
      sourceInstanceId: instId,
      messages: [],
    });
    const fact = generateRetrospective({ sessionId: sid, store });
    expect(fact.originalNeed).toBe('');
    expect(fact.toolCalls).toEqual([]);
    expect(fact.toolCallCount).toBe(0);
    expect(fact.detours).toEqual([]);
    expect(fact.stuckSegments).toEqual([]);
    expect(fact.firstUserMessageAt).toBeUndefined();
    expect(fact.durationSec).toBeGreaterThanOrEqual(0);
  });

  it('边界 2：仅 1 条 user 消息', () => {
    const sid = mkSession({
      store,
      sourceInstanceId: instId,
      messages: [
        { role: 'user', content: 'hello world', timestamp: 1000 },
      ],
    });
    const fact = generateRetrospective({ sessionId: sid, store });
    expect(fact.originalNeed).toBe('hello world');
    expect(fact.toolCallCount).toBe(0);
    expect(fact.firstUserMessageAt).toBe(1000);
  });

  it('边界 3：多 tool_call，提取名称 + 计数', () => {
    const sid = mkSession({
      store,
      sourceInstanceId: instId,
      messages: [
        { role: 'user', content: 'do task' },
        {
          role: 'assistant',
          content: 'I will use tools. {"type":"tool_use","name":"Read","input":{}}',
        },
        { role: 'tool', content: '{"name":"Read","output":"file contents"}' },
        {
          role: 'assistant',
          content: 'now another: {"type":"tool_use","name":"Bash","input":{}}',
        },
        { role: 'tool', content: '{"output":"done"}' },
      ],
    });
    const fact = generateRetrospective({ sessionId: sid, store });
    expect(fact.toolCallCount).toBeGreaterThanOrEqual(2);
    const names = fact.toolCalls.map((t) => t.name);
    expect(names).toContain('Read');
    expect(names).toContain('Bash');
  });

  it('边界 4：命中 DEFAULT_FAILURE_PATTERNS → detours 非空', () => {
    const sid = mkSession({
      store,
      sourceInstanceId: instId,
      messages: [
        { role: 'user', content: 'run the build' },
        { role: 'assistant', content: 'running...' },
        { role: 'tool', content: 'Error: Cannot find module foo' },
        { role: 'assistant', content: 'TypeError: undefined is not a function' },
      ],
    });
    const fact = generateRetrospective({ sessionId: sid, store });
    expect(fact.detours.length).toBeGreaterThanOrEqual(1);
    // 每条 detour 含 seq / snippet / pattern
    for (const d of fact.detours) {
      expect(d).toHaveProperty('seq');
      expect(d).toHaveProperty('snippet');
      expect(d).toHaveProperty('pattern');
      expect(typeof d.snippet).toBe('string');
      expect(d.snippet.length).toBeGreaterThan(0);
    }
  });

  it('originalNeed 剥离 <task-notification> / 系统注入 preamble', () => {
    const sid = mkSession({
      store,
      sourceInstanceId: instId,
      messages: [
        {
          role: 'user',
          content: '<task-notification>\n<status>completed</status>\n</task-notification>\n真实需求：修复登录',
        },
        { role: 'assistant', content: 'ok' },
        {
          role: 'user',
          content: '<system-reminder>some preamble</system-reminder>\n进一步说明',
        },
      ],
    });
    const fact = generateRetrospective({ sessionId: sid, store });
    // originalNeed 是第一条「真实」user 消息（剥 task-notification 头后非空）
    expect(fact.originalNeed).toContain('修复登录');
    expect(fact.originalNeed).not.toContain('<task-notification>');
  });

  it('durationSec = (lastSeenAt - startedAt) / 1000', () => {
    const startedAt = 1_000_000;
    const lastSeenAt = 1_060_000; // 60s later
    const sid = mkSession({
      store,
      sourceInstanceId: instId,
      startedAt,
      fileModifiedAt: lastSeenAt,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const fact = generateRetrospective({ sessionId: sid, store });
    expect(fact.durationSec).toBeGreaterThanOrEqual(0);
    // sessionMeta.startedAt 透传
    expect(fact.sessionMeta.startedAt).toBe(startedAt);
  });

  it('sessionMeta 字段映射正确', () => {
    const sid = mkSession({
      store,
      sourceInstanceId: instId,
      cwd: '/repo/foo',
      projectPath: '/repo/foo',
      messages: [{ role: 'user', content: 'x' }],
    });
    const fact = generateRetrospective({ sessionId: sid, store });
    expect(fact.sessionMeta.cwd).toBe('/repo/foo');
    expect(fact.sessionMeta.projectPath).toBe('/repo/foo');
    expect(fact.sessionMeta.source).toBe('claude-code');
    expect(fact.sessionMeta.messageCount).toBe(1);
  });
});
