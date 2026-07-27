/**
 * session-store.test.ts — SessionStore 工具调用结构化测试（loop build-tool-calls-schema §B）
 *
 * 验收门：
 *   B6. 单测：mock store 写入 + 读取，断言 toolCalls 往返一致
 *   + insertMessages 写 toolCalls、getMessages LEFT JOIN 读取
 *   + attachToolCallsBySeq 幂等（重复跑行数不变）
 *   + 不破坏现有 ingestSession 幂等行为
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from './index.js';
import type { SessionIngestInput, SessionMessageInput } from './index.js';

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

function mkSession(
  store: SessionStore,
  instId: string,
  messages: SessionMessageInput[],
  nativeId?: string,
): string {
  const input: SessionIngestInput = {
    deviceId: DEVICE,
    sourceInstanceId: instId,
    nativeSessionId: nativeId ?? `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'claude-code',
    cwd: '/repo/test',
    projectPath: '/repo/test',
    startedAt: Date.now() - 60_000,
    fileModifiedAt: Date.now(),
    messages,
  };
  return store.ingestSession(input).sessionId;
}

describe('SessionStore toolCalls (loop build-tool-calls-schema §B)', () => {
  let store: SessionStore;
  let instId: string;

  beforeEach(() => {
    store = freshStore();
    instId = registerInstance(store);
  });

  afterEach(() => {
    store.close();
  });

  it('B6: toolCalls 往返一致（写入 + 读取）', () => {
    const messages: SessionMessageInput[] = [
      { role: 'user', content: 'do task' },
      {
        role: 'assistant',
        content: 'I will use tools.',
        toolCalls: [
          { callSeq: 0, toolName: 'Read', toolInput: '{"file_path":"/a.ts"}' },
          { callSeq: 1, toolName: 'Bash', toolInput: '{"command":"ls"}' },
        ],
      },
      { role: 'user', content: 'next' },
    ];
    const sid = mkSession(store, instId, messages);
    const out = store.getMessages(sid);
    expect(out.length).toBe(3);
    expect(out[0].toolCalls).toBeUndefined();
    expect(out[1].toolCalls).toEqual([
      { callSeq: 0, toolName: 'Read', toolInput: '{"file_path":"/a.ts"}' },
      { callSeq: 1, toolName: 'Bash', toolInput: '{"command":"ls"}' },
    ]);
    expect(out[2].toolCalls).toBeUndefined();
  });

  it('多条消息各有 toolCalls 都正确读取', () => {
    const messages: SessionMessageInput[] = [
      {
        role: 'assistant',
        content: 'first',
        toolCalls: [{ callSeq: 0, toolName: 'Edit' }],
      },
      {
        role: 'assistant',
        content: 'second',
        toolCalls: [
          { callSeq: 0, toolName: 'Bash' },
          { callSeq: 1, toolName: 'Write' },
        ],
      },
    ];
    const sid = mkSession(store, instId, messages);
    const out = store.getMessages(sid);
    expect(out[0].toolCalls).toEqual([{ callSeq: 0, toolName: 'Edit' }]);
    expect(out[1].toolCalls).toEqual([
      { callSeq: 0, toolName: 'Bash' },
      { callSeq: 1, toolName: 'Write' },
    ]);
  });

  it('无 toolCalls 的消息读取不受影响', () => {
    const messages: SessionMessageInput[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const sid = mkSession(store, instId, messages);
    const out = store.getMessages(sid);
    expect(out.length).toBe(2);
    expect(out[0].toolCalls).toBeUndefined();
    expect(out[1].toolCalls).toBeUndefined();
  });

  it('attachToolCallsBySeq：补 attach 到已存在 session（无新 revision）', () => {
    // 先入库一个 session 不带 toolCalls
    const messages: SessionMessageInput[] = [
      { role: 'user', content: 'do task' },
      { role: 'assistant', content: 'I will use tools.' },
      { role: 'user', content: 'next' },
    ];
    const sid = mkSession(store, instId, messages, 'native-attach-1');
    const before = store.countToolCalls(sid);
    expect(before).toBe(0);

    // 模拟 reimport：用同内容（content_hash 相同）+ 带 toolCalls 的 messages 调 attachToolCallsBySeq
    const withToolCalls: SessionMessageInput[] = [
      { role: 'user', content: 'do task' },
      {
        role: 'assistant',
        content: 'I will use tools.',
        toolCalls: [
          { callSeq: 0, toolName: 'Read' },
          { callSeq: 1, toolName: 'Bash' },
        ],
      },
      { role: 'user', content: 'next' },
    ];
    const inserted = store.attachToolCallsBySeq(sid, withToolCalls);
    expect(inserted).toBe(2);
    expect(store.countToolCalls(sid)).toBe(2);

    // 重复跑：幂等，0 新插入
    const inserted2 = store.attachToolCallsBySeq(sid, withToolCalls);
    expect(inserted2).toBe(0);
    expect(store.countToolCalls(sid)).toBe(2);

    // 读取验证
    const out = store.getMessages(sid);
    expect(out[1].toolCalls).toEqual([
      { callSeq: 0, toolName: 'Read' },
      { callSeq: 1, toolName: 'Bash' },
    ]);
  });

  it('countToolCalls：新 session 入库时计数正确', () => {
    const messages: SessionMessageInput[] = [
      {
        role: 'assistant',
        content: 'a',
        toolCalls: [
          { callSeq: 0, toolName: 'A' },
          { callSeq: 1, toolName: 'B' },
          { callSeq: 2, toolName: 'C' },
        ],
      },
      {
        role: 'assistant',
        content: 'b',
        toolCalls: [{ callSeq: 0, toolName: 'D' }],
      },
    ];
    const sid = mkSession(store, instId, messages, 'native-count-1');
    expect(store.countToolCalls(sid)).toBe(4);
  });

  it('content_hash 不含 toolCalls：toolCalls 变化不产生新 revision，但幂等补 attach', () => {
    // 同样 content 但不同 toolCalls → 应判定为内容幂等（不产生新 revision）
    // 但 loop build-tool-calls-schema §D2：内容不变也补 attach toolCalls（INSERT OR IGNORE 幂等）
    const m1: SessionMessageInput[] = [
      { role: 'assistant', content: 'x', toolCalls: [{ callSeq: 0, toolName: 'A' }] },
    ];
    const m2: SessionMessageInput[] = [
      { role: 'assistant', content: 'x', toolCalls: [{ callSeq: 0, toolName: 'A' }, { callSeq: 1, toolName: 'B' }] },
    ];
    const sid1 = mkSession(store, instId, m1, 'native-hash-1');
    expect(store.countToolCalls(sid1)).toBe(1);
    const sid2 = mkSession(store, instId, m2, 'native-hash-1');
    expect(sid1).toBe(sid2); // 同 nativeId → 同 sessionId
    // 第二次 ingest 不产生新 revision（content_hash 相同）
    // 但 §D2 补 attach：A(callSeq=0) 已存在被 IGNORE，B(callSeq=1) 新插入
    expect(store.countToolCalls(sid1)).toBe(2);
    // 第三次跑 m2：全幂等，不新增
    mkSession(store, instId, m2, 'native-hash-1');
    expect(store.countToolCalls(sid1)).toBe(2);
  });
});
