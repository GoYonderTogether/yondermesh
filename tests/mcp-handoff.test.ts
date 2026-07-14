/**
 * LOOP-014 MCP 任务接管 handoff 测试
 *
 * 验收门：
 *   1. get_session_handoff 返回 compacted_summaries（含 compacted 摘要文本）
 *   2. get_session_handoff recent_messages 保留 function_call / function_call_output
 *   3. get_session_handoff last_user_message 跳过系统 preamble（<user_instructions>）
 *   4. get_session_handoff task_plan 从 update_plan 提取
 *   5. get_session_handoff session_meta 含 cwd / topology / model / cliVersion
 *   6. get_session_detail include_compacted=true 附 compacted_summaries
 *   7. get_session_detail handoff_mode=true 等价 include_compacted + include_tool_calls
 *   8. get_session_detail 默认行为保持向后兼容（返回数组）
 *   9. get_session_handoff 缺少 session_id 返回 isError
 *   10. buildSessionHandoff 找不到文件返回 null
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { McpServer } from '../src/mcp/server.js';
import {
  buildSessionHandoff,
  buildCodexHandoff,
  type HandoffPackage,
} from '../src/mcp/codex-handoff.js';

const SESSION_ID = '019f5fe4-b127-7de2-b8f1-efa45bee24cb';

/** 构造一份 codex rollout JSONL fixture，含 compacted + function_call + custom_tool_call + preamble */
function writeCodexFixture(dir: string): string {
  const filePath = path.join(dir, `rollout-2026-07-14T17-00-33-${SESSION_ID}.jsonl`);
  const lines: string[] = [];

  // session_meta
  lines.push(JSON.stringify({
    timestamp: '2026-07-14T17:00:33.000Z',
    type: 'session_meta',
    payload: {
      id: SESSION_ID,
      cwd: '/Users/zoran/projects/yondermesh',
      originator: 'codex-cli',
      source: 'cli',
      cli_version: 'codex 0.42.0',
      model_provider: 'gpt-5',
    },
  }));

  // compacted 摘要（window 1）
  lines.push(JSON.stringify({
    timestamp: '2026-07-14T17:05:00.000Z',
    type: 'compacted',
    payload: {
      message: '用户要求实现 MCP handoff 能力。已完成 server.ts 初步分析，待新增 get_session_handoff 工具。',
      replacement_history: ['old msg 1', 'old msg 2'], // 冗余历史，应被忽略
      window_number: 1,
      first_window_id: 'win-0',
      previous_window_id: 'win-0',
      window_id: 'win-1',
    },
  }));

  // compacted 摘要（window 2）
  lines.push(JSON.stringify({
    timestamp: '2026-07-14T17:15:00.000Z',
    type: 'compacted',
    payload: {
      message: '第二次压缩：handoff 工具已实现，正在写测试。',
      replacement_history: [],
      window_number: 2,
      window_id: 'win-2',
    },
  }));

  // 系统注入 preamble（<user_instructions>，应被 last_user_message 跳过）
  lines.push(JSON.stringify({
    timestamp: '2026-07-14T17:20:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<user_instructions>AGENTS.md preamble content here</user_instructions>' }],
    },
  }));

  // 真实 user 消息
  lines.push(JSON.stringify({
    timestamp: '2026-07-14T17:21:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '请帮我把 handoff 测试写完' }],
    },
  }));

  // assistant 消息
  lines.push(JSON.stringify({
    timestamp: '2026-07-14T17:22:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '好的，我来写 handoff 测试。' }],
    },
  }));

  // function_call
  lines.push(JSON.stringify({
    timestamp: '2026-07-14T17:22:30.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'shell',
      arguments: JSON.stringify({ command: 'cat src/mcp/server.ts' }),
      call_id: 'call-001',
    },
  }));

  // function_call_output
  lines.push(JSON.stringify({
    timestamp: '2026-07-14T17:22:31.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call-001',
      output: 'export class McpServer { ... }',
    },
  }));

  // custom_tool_call: update_plan（应被 task_plan 提取）
  lines.push(JSON.stringify({
    timestamp: '2026-07-14T17:23:00.000Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'update_plan',
      input: {
        explanation: '正在实施 handoff 优化，已写测试。',
        plan: [
          { step: '新建 codex-handoff.ts', status: 'completed' },
          { step: '写测试覆盖', status: 'in_progress' },
          { step: '跑全量回归', status: 'pending' },
        ],
      },
      call_id: 'call-002',
    },
  }));

  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

/** 构造一份 claude fixture（无 compacted） */
function writeClaudeFixture(dir: string): string {
  const filePath = path.join(dir, 'claude-session-001.jsonl');
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: 'user',
    sessionId: 'claude-session-001',
    cwd: '/projects/demo',
    message: { role: 'user', content: 'hello from claude' },
  }));
  lines.push(JSON.stringify({
    type: 'assistant',
    sessionId: 'claude-session-001',
    message: { role: 'assistant', content: 'hi there' },
  }));
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

describe('LOOP-014: get_session_handoff MCP 工具', () => {
  let tmpDir: string;
  let codexDir: string;
  let mcp: McpServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-handoff-'));
    codexDir = path.join(tmpDir, 'codex-sessions', '2026', '07', '14');
    fs.mkdirSync(codexDir, { recursive: true });
    writeCodexFixture(codexDir);

    const store = new SessionStore(':memory:');
    mcp = new McpServer(store, {
      claudeProjectsPath: path.join(tmpDir, 'claude'),
      codexSessionsPath: path.join(tmpDir, 'codex-sessions'),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('返回 compacted_summaries（含摘要文本，按 window 排序）', async () => {
    const result = await mcp.callTool('get_session_handoff', { session_id: SESSION_ID });
    expect(result.isError).toBeFalsy();
    const pkg = JSON.parse(result.content) as HandoffPackage;
    expect(pkg.compacted_summaries).toHaveLength(2);
    expect(pkg.compacted_summaries[0].window_number).toBe(1);
    expect(pkg.compacted_summaries[1].window_number).toBe(2);
    expect(pkg.compacted_summaries[0].message).toContain('实现 MCP handoff');
    expect(pkg.compacted_summaries[1].message).toContain('第二次压缩');
    // replacement_history 噪音不应出现
    expect(pkg.compacted_summaries[0].message).not.toContain('old msg');
  });

  it('recent_messages 保留 function_call / function_call_output', async () => {
    const result = await mcp.callTool('get_session_handoff', { session_id: SESSION_ID });
    const pkg = JSON.parse(result.content) as HandoffPackage;
    const roles = pkg.recent_messages.map((m) => m.role);
    expect(roles).toContain('function_call');
    expect(roles).toContain('function_call_output');
    const fnCall = pkg.recent_messages.find((m) => m.role === 'function_call');
    expect(fnCall?.name).toBe('shell');
    expect(fnCall?.arguments).toContain('cat src/mcp/server.ts');
    const fnOut = pkg.recent_messages.find((m) => m.role === 'function_call_output');
    expect(fnOut?.output).toContain('McpServer');
  });

  it('last_user_message 跳过 <user_instructions> preamble', async () => {
    const result = await mcp.callTool('get_session_handoff', { session_id: SESSION_ID });
    const pkg = JSON.parse(result.content) as HandoffPackage;
    expect(pkg.last_user_message).toBe('请帮我把 handoff 测试写完');
    expect(pkg.last_user_message).not.toContain('user_instructions');
    expect(pkg.last_user_message).not.toContain('AGENTS.md');
  });

  it('task_plan 从 update_plan 提取', async () => {
    const result = await mcp.callTool('get_session_handoff', { session_id: SESSION_ID });
    const pkg = JSON.parse(result.content) as HandoffPackage;
    expect(pkg.task_plan).not.toBeNull();
    expect(pkg.task_plan).toContain('正在实施 handoff 优化');
    expect(pkg.task_plan).toContain('新建 codex-handoff.ts');
    expect(pkg.task_plan).toContain('跑全量回归');
  });

  it('session_meta 含 cwd / topology / model / cliVersion', async () => {
    const result = await mcp.callTool('get_session_handoff', { session_id: SESSION_ID });
    const pkg = JSON.parse(result.content) as HandoffPackage;
    expect(pkg.session_meta.cwd).toBe('/Users/zoran/projects/yondermesh');
    expect(pkg.session_meta.topology).toBe('root');
    expect(pkg.session_meta.model).toBe('gpt-5');
    expect(pkg.session_meta.cliVersion).toBe('codex 0.42.0');
    expect(pkg.session_meta.originator).toBe('codex-cli');
  });

  it('session_id 和 source 正确', async () => {
    const result = await mcp.callTool('get_session_handoff', { session_id: SESSION_ID });
    const pkg = JSON.parse(result.content) as HandoffPackage;
    expect(pkg.session_id).toBe(SESSION_ID);
    expect(pkg.source).toBe('codex');
  });

  it('message_count 统计 user/assistant 消息', async () => {
    const result = await mcp.callTool('get_session_handoff', { session_id: SESSION_ID });
    const pkg = JSON.parse(result.content) as HandoffPackage;
    // preamble user + real user + assistant = 3
    expect(pkg.message_count).toBe(3);
  });

  it('is_live / last_activity_sec_ago 字段存在', async () => {
    const result = await mcp.callTool('get_session_handoff', { session_id: SESSION_ID });
    const pkg = JSON.parse(result.content) as HandoffPackage;
    expect(typeof pkg.is_live).toBe('boolean');
    expect(typeof pkg.last_activity_sec_ago).toBe('number');
  });

  it('tail_messages 控制尾部条数', async () => {
    const result = await mcp.callTool('get_session_handoff', {
      session_id: SESSION_ID,
      tail_messages: 2,
    });
    const pkg = JSON.parse(result.content) as HandoffPackage;
    expect(pkg.recent_messages.length).toBeLessThanOrEqual(2);
  });

  it('缺少 session_id 返回 isError', async () => {
    const result = await mcp.callTool('get_session_handoff', {});
    expect(result.isError).toBe(true);
  });

  it('找不到 session 返回 isError', async () => {
    const result = await mcp.callTool('get_session_handoff', {
      session_id: 'nonexistent-uuid',
    });
    expect(result.isError).toBe(true);
  });
});

describe('LOOP-014: get_session_detail 增强参数', () => {
  let tmpDir: string;
  let codexDir: string;
  let mcp: McpServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-detail-'));
    codexDir = path.join(tmpDir, 'codex-sessions', '2026', '07', '14');
    fs.mkdirSync(codexDir, { recursive: true });
    writeCodexFixture(codexDir);

    const store = new SessionStore(':memory:');
    mcp = new McpServer(store, {
      claudeProjectsPath: path.join(tmpDir, 'claude'),
      codexSessionsPath: path.join(tmpDir, 'codex-sessions'),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('include_compacted=true 附 compacted_summaries 数组', async () => {
    const result = await mcp.callTool('get_session_detail', {
      session_id: SESSION_ID,
      live: true,
      include_compacted: true,
    });
    expect(result.isError).toBeFalsy();
    const obj = JSON.parse(result.content) as { messages: unknown[]; compacted_summaries: Array<{ window_number: number; message: string }> };
    expect(obj.compacted_summaries).toBeDefined();
    expect(obj.compacted_summaries).toHaveLength(2);
    expect(obj.compacted_summaries[0].message).toContain('实现 MCP handoff');
  });

  it('include_tool_calls=true 保留 function_call', async () => {
    const result = await mcp.callTool('get_session_detail', {
      session_id: SESSION_ID,
      live: true,
      include_tool_calls: true,
    });
    const obj = JSON.parse(result.content) as { messages: Array<{ role: string; name?: string }> };
    const roles = obj.messages.map((m) => m.role);
    expect(roles).toContain('function_call');
    expect(roles).toContain('function_call_output');
  });

  it('handoff_mode=true 等价 include_compacted + include_tool_calls + 自动尾部', async () => {
    const result = await mcp.callTool('get_session_detail', {
      session_id: SESSION_ID,
      handoff_mode: true,
    });
    expect(result.isError).toBeFalsy();
    const obj = JSON.parse(result.content) as {
      messages: Array<{ role: string }>;
      compacted_summaries: unknown[];
    };
    // handoff_mode 隐含 live，应找到文件
    expect(obj.messages.length).toBeGreaterThan(0);
    expect(obj.compacted_summaries).toBeDefined();
    expect(obj.compacted_summaries).toHaveLength(2);
    // 含 tool call
    const roles = obj.messages.map((m) => m.role);
    expect(roles).toContain('function_call');
  });

  it('默认 live 模式保持向后兼容（返回数组，无 compacted）', async () => {
    const result = await mcp.callTool('get_session_detail', {
      session_id: SESSION_ID,
      live: true,
    });
    expect(result.isError).toBeFalsy();
    const arr = JSON.parse(result.content);
    expect(Array.isArray(arr)).toBe(true);
    // 默认不含 tool_call 细节（parseCodexMessages 只取 message）
    const roles = arr.map((m: { role: string }) => m.role);
    expect(roles).not.toContain('function_call');
  });
});

describe('LOOP-014: buildSessionHandoff 共享函数', () => {
  let tmpDir: string;
  let codexDir: string;
  let claudeDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-shared-'));
    codexDir = path.join(tmpDir, 'codex-sessions', '2026', '07', '14');
    claudeDir = path.join(tmpDir, 'claude');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('codex 文件返回完整 handoff 包', () => {
    writeCodexFixture(codexDir);
    const pkg = buildSessionHandoff(
      SESSION_ID,
      claudeDir,
      path.join(tmpDir, 'codex-sessions'),
    );
    expect(pkg).not.toBeNull();
    expect(pkg!.source).toBe('codex');
    expect(pkg!.compacted_summaries).toHaveLength(2);
    expect(pkg!.task_plan).not.toBeNull();
  });

  it('claude 文件返回简版 handoff（无 compacted）', () => {
    writeClaudeFixture(claudeDir);
    const pkg = buildSessionHandoff(
      'claude-session-001',
      claudeDir,
      path.join(tmpDir, 'codex-sessions'),
    );
    expect(pkg).not.toBeNull();
    expect(pkg!.source).toBe('claude');
    expect(pkg!.compacted_summaries).toHaveLength(0);
    expect(pkg!.task_plan).toBeNull();
    expect(pkg!.last_user_message).toBe('hello from claude');
  });

  it('找不到文件返回 null', () => {
    const pkg = buildSessionHandoff(
      'nonexistent',
      claudeDir,
      path.join(tmpDir, 'codex-sessions'),
    );
    expect(pkg).toBeNull();
  });

  it('buildCodexHandoff 截断超长 arguments', () => {
    writeCodexFixture(codexDir);
    const filePath = path.join(codexDir, `rollout-2026-07-14T17-00-33-${SESSION_ID}.jsonl`);
    // 追加一条超长 arguments 的 function_call
    const longArgs = 'x'.repeat(5000);
    fs.appendFileSync(filePath, JSON.stringify({
      timestamp: '2026-07-14T17:30:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell',
        arguments: longArgs,
        call_id: 'call-long',
      },
    }) + '\n');
    const pkg = buildCodexHandoff(filePath, { tailMessages: 2 });
    expect(pkg).not.toBeNull();
    const longCall = pkg!.recent_messages.find((m) => m.name === 'shell' && m.arguments?.includes('xxx'));
    expect(longCall).toBeDefined();
    expect(longCall!.arguments!.length).toBeLessThan(5000);
    expect(longCall!.arguments).toContain('...[truncated]');
  });
});
