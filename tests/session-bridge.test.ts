/**
 * Session Bridge 契约测试
 *
 * 覆盖：
 *   toNeutralMessages：
 *     1. aider markdown 字符串 → 解析为 user/assistant
 *     2. amp v5 JSON 对象 → 解析
 *     3. trae_cli trajectory 对象 → 解析
 *     4. chatgpt → 恒空
 *     5. 未知 source + {messages:[...]} → 通用映射
 *     6. JSON 字符串 → 解析后映射
 *     7. 非 JSON 裸字符串 → 单条 user 消息
 *   toNeutralJsonl / parseNeutralJsonl：
 *     8. 往返一致
 *   buildHandoffPrompt：
 *     9. 结构正确（标题/source/role 段落）
 *   convertSession：
 *    10. 目标 aider/amp/chatgpt → handoff 提示词
 *    11. 目标 hermes/codex → 中性 JSONL
 *    12. JSONL 可被 parseNeutralJsonl 还原
 */

import { describe, it, expect } from 'vitest';
import {
  toNeutralMessages,
  toNeutralJsonl,
  parseNeutralJsonl,
  buildHandoffPrompt,
  convertSession,
} from '../src/limited/session-bridge.js';

const AIDER_MD = [
  '# aider chat started at 2026-07-14 22:48:56',
  '',
  '#### Hello',
  '',
  'Hi there',
  '',
].join('\n');

const AMP_OBJ = {
  v: 5,
  id: 'T-1',
  created: 1721000000000,
  env: { initial: { trees: [{ uri: 'file:///proj' }] } },
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'amp hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'amp reply' }] },
  ],
};

const TRAE_OBJ = {
  task: 'do task',
  model: 'glm-4.6',
  llm_interactions: [
    {
      input_messages: [{ role: 'user', content: 'do task' }],
      response: { content: 'tr reply' },
    },
  ],
  final_result: 'tr reply', // 与 response 相同 → 去重
};

describe('toNeutralMessages', () => {
  it('aider markdown 字符串 → user/assistant', () => {
    const msgs = toNeutralMessages('aider', AIDER_MD);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hello'],
      ['assistant', 'Hi there'],
    ]);
  });

  it('amp v5 JSON 对象 → 解析', () => {
    const msgs = toNeutralMessages('amp', AMP_OBJ);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'amp hello'],
      ['assistant', 'amp reply'],
    ]);
  });

  it('trae_cli trajectory 对象 → 解析（final_result 去重）', () => {
    const msgs = toNeutralMessages('trae_cli', TRAE_OBJ);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'do task'],
      ['assistant', 'tr reply'],
    ]);
    // model 透传
    expect(msgs[0]!.model).toBe('glm-4.6');
  });

  it('chatgpt → 恒空', () => {
    expect(toNeutralMessages('chatgpt', { messages: [{ role: 'user', content: 'x' }] })).toEqual([]);
  });

  it('未知 source + {messages:[...]} → 通用映射（含 model 透传）', () => {
    const obj = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'generic' },
        { role: 'assistant', content: [{ text: 'block reply' }] },
        { role: 'system', content: 'sys' },
        { role: 'agent', content: 'agent-as-assistant' },
      ],
    };
    const msgs = toNeutralMessages('unknown-cli', obj);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'generic'],
      ['assistant', 'block reply'],
      ['system', 'sys'],
      ['assistant', 'agent-as-assistant'], // 'agent' → 'assistant'
    ]);
    expect(msgs[0]!.model).toBe('gpt-4');
  });

  it('JSON 字符串 → 解析后映射', () => {
    const jsonStr = JSON.stringify({
      messages: [{ role: 'user', content: 'json content' }],
    });
    const msgs = toNeutralMessages('unknown', jsonStr);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('json content');
  });

  it('非 JSON 裸字符串 → 单条 user 消息', () => {
    const msgs = toNeutralMessages('unknown', 'just plain text');
    expect(msgs).toEqual([{ role: 'user', content: 'just plain text' }]);
  });
});

describe('toNeutralJsonl / parseNeutralJsonl', () => {
  it('往返一致', () => {
    const jsonl = toNeutralJsonl('aider', AIDER_MD);
    expect(jsonl).not.toBe('');
    const parsed = parseNeutralJsonl(jsonl);
    expect(parsed.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hello'],
      ['assistant', 'Hi there'],
    ]);
  });

  it('空输入 → 空字符串', () => {
    expect(toNeutralJsonl('chatgpt', {})).toBe('');
  });
});

describe('buildHandoffPrompt', () => {
  it('结构正确：标题 + source + role 段落', () => {
    const msgs = toNeutralMessages('aider', AIDER_MD);
    const prompt = buildHandoffPrompt(msgs, { sourceCli: 'aider', task: 'continue' });
    expect(prompt).toContain('# Session Handoff');
    expect(prompt).toContain('Source: aider');
    expect(prompt).toContain('Task: continue');
    expect(prompt).toContain('Below is the prior conversation. Continue from here:');
    expect(prompt).toContain('## user');
    expect(prompt).toContain('Hello');
    expect(prompt).toContain('## assistant');
    expect(prompt).toContain('Hi there');
  });
});

describe('convertSession', () => {
  it('目标 aider → handoff 提示词', () => {
    const result = convertSession('aider', AIDER_MD, 'aider');
    expect(result).toContain('# Session Handoff');
    expect(result).toContain('Hello');
  });

  it('目标 amp → handoff 提示词', () => {
    const result = convertSession('aider', AIDER_MD, 'amp');
    expect(result).toContain('# Session Handoff');
  });

  it('目标 chatgpt → handoff 提示词（人工粘贴）', () => {
    const result = convertSession('trae_cli', TRAE_OBJ, 'chatgpt');
    expect(result).toContain('# Session Handoff');
    expect(result).toContain('do task');
  });

  it('目标 hermes → 中性 JSONL', () => {
    const result = convertSession('aider', AIDER_MD, 'hermes');
    const lines = result.trim().split('\n');
    expect(lines).toHaveLength(2);
    // 每行是合法 JSON
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj.role).toMatch(/^(user|assistant)$/);
      expect(typeof obj.content).toBe('string');
    }
  });

  it('JSONL 可被 parseNeutralJsonl 还原', () => {
    const jsonl = convertSession('trae_cli', TRAE_OBJ, 'codex');
    const restored = parseNeutralJsonl(jsonl);
    expect(restored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'do task'],
      ['assistant', 'tr reply'],
    ]);
  });
});
