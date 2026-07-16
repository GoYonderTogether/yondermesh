/**
 * Copilot CLI / SDK 原生 adapter 契约测试
 *
 * 覆盖验收门：
 *   1. CLI session：session.start 元数据（cwd / copilotVersion / startTime）解析，
 *      user+assistant 可显示文本入库，token 统计来自 shutdown.modelMetrics
 *   2. SDK session：workspace.yaml.client_name=sdk → originator=copilot_sdk，
 *      selectedModel / apiCallId 等 SDK 信号亦能独立判定 SDK
 *   3. 排除内部上下文：system.message / tool.execution_* / function / abort /
 *      hook.* / subagent.selected / transformedContent 全部不入库
 *   4. session.model_change / shutdown.currentModel 覆盖 model 字段
 *   5. session.resume → continued_from 关系（仅可验证父）
 *   6. 重复扫描幂等：不新增 revision
 *   7. 内容变更（追加消息）生成新 revision
 *   8. 脏 JSONL：单行损坏被跳过，合法行仍解析
 *   9. 无有效消息：整 session 跳过并计数
 *  10. 无 events.jsonl：目录跳过（skipped）
 *  11. 8 hook 类型计数（hookCounts → toolCallCount）
 *
 * 真实结构（本机 ~/.copilot 实测，2026-07）：
 *   - 路径：<rootPath>/session-state/<uuid>/events.jsonl + workspace.yaml
 *   - events.jsonl 每行一个事件：{ type, data, id, timestamp, parentId }
 *   - 关键事件类型：session.start / session.shutdown / session.model_change /
 *     session.resume / system.message / user.message / assistant.message /
 *     assistant.turn_start/end / tool.execution_start/complete / hook.start/end /
 *     subagent.selected / function / abort
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import {
  CopilotImporter,
  COPILOT_HOOK_TYPES,
  COPILOT_EVENT_TYPES,
} from '../src/copilot/index.js';
import type { CopilotImportStats } from '../src/copilot/index.js';

const DEVICE = 'mac-test';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

/** 一条 events.jsonl 行（松散结构） */
type Line = {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
};

interface SessionStartOpts {
  sessionId: string;
  cwd?: string;
  gitRoot?: string;
  branch?: string;
  copilotVersion?: string;
  startTime?: string;
  timestamp?: string;
  /** SDK 信号：selectedModel / contextTier */
  selectedModel?: string;
  contextTier?: unknown;
}

function sessionStart(o: SessionStartOpts): Line {
  return {
    type: 'session.start',
    id: 'ev-start-' + o.sessionId,
    timestamp: o.timestamp ?? '2026-07-14T12:45:11.000Z',
    parentId: null,
    data: {
      sessionId: o.sessionId,
      version: 1,
      producer: 'copilot-agent',
      copilotVersion: o.copilotVersion ?? '1.0.47',
      startTime: o.startTime ?? '2026-07-14T12:45:11.000Z',
      context: {
        cwd: o.cwd ?? '/Users/zoran/Documents/projects/yondermesh',
        gitRoot: o.gitRoot ?? '/Users/zoran/Documents/projects/yondermesh',
        branch: o.branch ?? 'main',
        headCommit: 'abc1234',
        baseCommit: 'def5678',
      },
      ...(o.selectedModel !== undefined ? { selectedModel: o.selectedModel } : {}),
      ...(o.contextTier !== undefined ? { contextTier: o.contextTier } : {}),
      alreadyInUse: false,
      remoteSteerable: false,
    },
  };
}

interface UserMessageOpts {
  content: string;
  timestamp?: string;
  transformedContent?: string;
  parentAgentTaskId?: string;
}

function userMessage(o: UserMessageOpts): Line {
  return {
    type: 'user.message',
    id: 'ev-user-' + Math.random().toString(36).slice(2, 10),
    timestamp: o.timestamp ?? '2026-07-14T12:45:16.000Z',
    parentId: 'ev-start-1',
    data: {
      content: o.content,
      ...(o.transformedContent ? { transformedContent: o.transformedContent } : {}),
      attachments: [],
      interactionId: 'ix-' + Math.random().toString(36).slice(2, 10),
      ...(o.parentAgentTaskId ? { parentAgentTaskId: o.parentAgentTaskId } : {}),
    },
  };
}

interface AssistantMessageOpts {
  content: string;
  model?: string;
  timestamp?: string;
  outputTokens?: number;
  apiCallId?: string;
}

function assistantMessage(o: AssistantMessageOpts): Line {
  return {
    type: 'assistant.message',
    id: 'ev-asst-' + Math.random().toString(36).slice(2, 10),
    timestamp: o.timestamp ?? '2026-07-14T12:45:30.000Z',
    parentId: 'ev-turn-1',
    data: {
      messageId: 'msg-' + Math.random().toString(36).slice(2, 10),
      model: o.model ?? 'glm-5.2',
      content: o.content,
      toolRequests: [],
      interactionId: 'ix-1',
      turnId: '0',
      outputTokens: o.outputTokens ?? 10,
      ...(o.apiCallId ? { apiCallId: o.apiCallId } : {}),
    },
  };
}

function systemMessage(content: string, timestamp?: string): Line {
  return {
    type: 'system.message',
    id: 'ev-sys-' + Math.random().toString(36).slice(2, 10),
    timestamp: timestamp ?? '2026-07-14T12:45:15.000Z',
    parentId: null,
    data: { role: 'system', content },
  };
}

function hookStart(hookType: string, input?: Record<string, unknown>, timestamp?: string): Line {
  return {
    type: 'hook.start',
    id: 'ev-hook-start-' + Math.random().toString(36).slice(2, 10),
    timestamp: timestamp ?? '2026-07-14T12:45:15.500Z',
    parentId: 'ev-start-1',
    data: {
      hookInvocationId: 'hinv-' + Math.random().toString(36).slice(2, 10),
      hookType,
      input: input ?? {},
    },
  };
}

function hookEnd(hookType: string, timestamp?: string): Line {
  return {
    type: 'hook.end',
    id: 'ev-hook-end-' + Math.random().toString(36).slice(2, 10),
    timestamp: timestamp ?? '2026-07-14T12:45:15.600Z',
    parentId: 'ev-start-1',
    data: {
      hookInvocationId: 'hinv-1',
      hookType,
      success: true,
    },
  };
}

interface ShutdownOpts {
  currentModel?: string;
  timestamp?: string;
  eventsFileSizeBytes?: number;
  totalNanoAiu?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  requestsCount?: number;
  model?: string;
}

function shutdown(o: ShutdownOpts = {}): Line {
  return {
    type: 'session.shutdown',
    id: 'ev-shutdown-' + Math.random().toString(36).slice(2, 10),
    timestamp: o.timestamp ?? '2026-07-14T12:45:30.500Z',
    parentId: null,
    data: {
      shutdownType: 'routine',
      totalPremiumRequests: 0,
      totalApiDurationMs: 14000,
      sessionStartTime: 1784033111003,
      codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
      modelMetrics: {
        [o.model ?? 'glm-5.2']: {
          requests: {
            count: o.requestsCount ?? 1,
            cost: o.cost ?? 0,
          },
          usage: {
            inputTokens: o.inputTokens ?? 18414,
            outputTokens: o.outputTokens ?? 10,
            cacheReadTokens: o.cacheReadTokens ?? 0,
            cacheWriteTokens: o.cacheWriteTokens ?? 0,
            reasoningTokens: 0,
          },
          ...(o.totalNanoAiu !== undefined ? { totalNanoAiu: o.totalNanoAiu } : {}),
        },
      },
      currentModel: o.currentModel ?? 'glm-5.2',
      currentTokens: 18053,
      systemTokens: 6917,
      conversationTokens: 106,
      toolDefinitionsTokens: 11027,
      ...(o.eventsFileSizeBytes !== undefined ? { eventsFileSizeBytes: o.eventsFileSizeBytes } : {}),
      ...(o.totalNanoAiu !== undefined ? { totalNanoAiu: o.totalNanoAiu } : {}),
    },
  };
}

function modelChange(newModel: string, timestamp?: string): Line {
  return {
    type: 'session.model_change',
    id: 'ev-mc-' + Math.random().toString(36).slice(2, 10),
    timestamp: timestamp ?? '2026-07-14T12:45:12.000Z',
    parentId: 'ev-start-1',
    data: { newModel },
  };
}

function sessionResume(resumedSessionId: string, timestamp?: string): Line {
  return {
    type: 'session.resume',
    id: 'ev-resume-' + Math.random().toString(36).slice(2, 10),
    timestamp: timestamp ?? '2026-07-14T13:00:00.000Z',
    parentId: null,
    data: { sessionId: resumedSessionId },
  };
}

function assistantTurnStart(model: string, timestamp?: string): Line {
  return {
    type: 'assistant.turn_start',
    id: 'ev-ts-' + Math.random().toString(36).slice(2, 10),
    timestamp: timestamp ?? '2026-07-14T12:45:16.100Z',
    parentId: null,
    data: { turnId: '0', model, interactionId: 'ix-1' },
  };
}

function assistantTurnEnd(model: string, timestamp?: string): Line {
  return {
    type: 'assistant.turn_end',
    id: 'ev-te-' + Math.random().toString(36).slice(2, 10),
    timestamp: timestamp ?? '2026-07-14T12:45:30.400Z',
    parentId: null,
    data: { turnId: '0', model },
  };
}

function toolExecutionStart(timestamp?: string): Line {
  return {
    type: 'tool.execution_start',
    id: 'ev-tes-' + Math.random().toString(36).slice(2, 10),
    timestamp: timestamp ?? '2026-07-14T12:45:20.000Z',
    parentId: null,
    data: { toolName: 'read', toolCallId: 'tc-1' },
  };
}

function toolExecutionComplete(timestamp?: string): Line {
  return {
    type: 'tool.execution_complete',
    id: 'ev-tec-' + Math.random().toString(36).slice(2, 10),
    timestamp: timestamp ?? '2026-07-14T12:45:21.000Z',
    parentId: null,
    data: { toolName: 'read', toolCallId: 'tc-1', success: true },
  };
}

/** 写一个 session 目录（events.jsonl + 可选 workspace.yaml） */
function writeSession(
  rootPath: string,
  uuid: string,
  events: Line[],
  opts: { workspace?: Record<string, string>; brokenLines?: string[] } = {},
): string {
  const dir = path.join(rootPath, 'session-state', uuid);
  fs.mkdirSync(dir, { recursive: true });
  const body = events.map((l) => JSON.stringify(l)).join('\n') + '\n';
  let content = body;
  if (opts.brokenLines) {
    content = opts.brokenLines.join('\n') + '\n' + body;
  }
  fs.writeFileSync(path.join(dir, 'events.jsonl'), content, 'utf8');
  if (opts.workspace) {
    const yaml = Object.entries(opts.workspace)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), yaml + '\n', 'utf8');
  }
  return dir;
}

// ─── 测试体 ──────────────────────────────────────────────────────────────────

describe('Copilot CLI / SDK 原生 adapter', () => {
  let tmpHome: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('解析 CLI session：元数据 + 消息 + token 统计 + hook 计数', () => {
    const sessionId = 'e5347539-71e7-4223-8c7e-fa74567af858';
    writeSession(tmpHome, sessionId, [
      sessionStart({
        sessionId,
        cwd: '/Users/zoran/Documents/projects/vela-ai',
        gitRoot: '/Users/zoran/Documents/projects/vela-ai',
        branch: 'main',
        copilotVersion: '1.0.31',
      }),
      modelChange('claude-opus-4.7'),
      systemMessage('You are the GitHub Copilot CLI...'),
      hookStart('sessionStart', { source: 'new', cwd: '/Users/zoran/Documents/projects/vela-ai' }),
      hookEnd('sessionStart'),
      hookStart('userPromptSubmitted'),
      hookEnd('userPromptSubmitted'),
      userMessage({ content: 'hello copilot', transformedContent: '<current_datetime>...</current_datetime>\nhello copilot' }),
      assistantMessage({ content: 'hi there', model: 'claude-opus-4.7', outputTokens: 5 }),
      hookStart('agentStop'),
      hookEnd('agentStop'),
      hookStart('sessionEnd'),
      hookEnd('sessionEnd'),
      shutdown({ currentModel: 'claude-opus-4.7', inputTokens: 100, outputTokens: 5, cost: 0.001 }),
    ]);

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.cliSessions).toBe(1);
    expect(stats.sdkSessions).toBe(0);

    // 验证入库的 session
    const sessions = store.querySessions({ source: 'copilot', deviceId: DEVICE });
    expect(sessions.length).toBe(1);
    const s = sessions[0]!;
    expect(s.nativeSessionId).toBe(sessionId);
    expect(s.cwd).toBe('/Users/zoran/Documents/projects/vela-ai');
    expect(s.source).toBe('copilot');
    expect(s.topology).toBe('root');
    expect(s.model).toBe('claude-opus-4.7');
    expect(s.cliVersion).toBe('1.0.31');
    expect(s.originator).toBe('copilot_cli');
    expect(s.entrySource).toBe('new');
    expect(s.totalInputTokens).toBe(100);
    expect(s.totalOutputTokens).toBe(5);
    expect(s.estimatedCostUsd).toBe(0.001);
    // 注：toolCallCount 用 hookCounts 累积，每个 hookType 每次 hook.start +1，
    // 这里 4 种 hookType（sessionStart / userPromptSubmitted / agentStop / sessionEnd）各 1 次 → 4
    expect(s.toolCallCount).toBe(4);

    // 验证消息
    const msgs = store.getMessages(s.id);
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('hello copilot'); // 原文，不含 transformedContent
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[1]!.content).toBe('hi there');
  });

  it('判定 SDK session：workspace.yaml.client_name=sdk', () => {
    const sessionId = 'e9e396a9-7bc0-43c1-a19e-9d17062f7640';
    writeSession(
      tmpHome,
      sessionId,
      [
        sessionStart({ sessionId, cwd: '/tmp/test', selectedModel: 'glm-5.2' }),
        hookStart('sessionStart', { source: 'new' }),
        hookEnd('sessionStart'),
        userMessage({ content: 'Reply with PONG' }),
        assistantMessage({ content: 'PONG', apiCallId: 'msg_001' }), // SDK 信号
        hookStart('agentStop'),
        hookEnd('agentStop'),
        hookStart('sessionEnd'),
        hookEnd('sessionEnd'),
        shutdown({ eventsFileSizeBytes: 11820, totalNanoAiu: 0, inputTokens: 1924, outputTokens: 3 }),
      ],
      {
        workspace: {
          cwd: '/tmp/copilot-sdk-test',
          client_name: 'sdk',
          name: 'Reply with exactly one word: PONG',
        },
      },
    );

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.inserted).toBe(1);
    expect(stats.sdkSessions).toBe(1);
    expect(stats.cliSessions).toBe(0);

    const s = store.querySessions({ source: 'copilot', deviceId: DEVICE })[0]!;
    expect(s.originator).toBe('copilot_sdk');
    expect(s.threadSource).toBe('sdk');
    expect(s.model).toBe('glm-5.2');
  });

  it('SDK 信号独立判定（无 workspace.yaml）', () => {
    const sessionId = 'sdk-only-001';
    writeSession(tmpHome, sessionId, [
      sessionStart({ sessionId, selectedModel: 'glm-5.2', contextTier: null }),
      assistantTurnStart('glm-5.2'), // SDK 信号：turn_start 含 model
      userMessage({ content: 'hi' }),
      assistantMessage({ content: 'hi', apiCallId: 'msg_x' }),
      assistantTurnEnd('glm-5.2'),
      shutdown({ eventsFileSizeBytes: 1000 }),
    ]);

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.sdkSessions).toBe(1);
    expect(stats.cliSessions).toBe(0);
    const s = store.querySessions({ source: 'copilot', deviceId: DEVICE })[0]!;
    expect(s.originator).toBe('copilot_sdk');
  });

  it('排除内部上下文：system.message / tool.execution_* / hook.* / transformedContent', () => {
    const sessionId = 'cli-excl-001';
    writeSession(tmpHome, sessionId, [
      sessionStart({ sessionId }),
      systemMessage('system prompt'), // 必须排除
      hookStart('sessionStart'), // hook 不入库
      hookEnd('sessionStart'),
      toolExecutionStart(), // 必须排除
      toolExecutionComplete(), // 必须排除
      userMessage({
        content: 'real user msg',
        transformedContent: '<current_datetime>2026-07-14</current_datetime>\nreal user msg',
      }),
      assistantMessage({ content: 'real assistant msg' }),
    ]);

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    importer.import();

    const s = store.querySessions({ source: 'copilot', deviceId: DEVICE })[0]!;
    const msgs = store.getMessages(s.id);
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.content).toBe('real user msg'); // 不含 transformedContent
    expect(msgs[1]!.content).toBe('real assistant msg');
  });

  it('session.resume → continued_from 关系（父在同次扫描入库）', () => {
    const parent = 'parent-001';
    const child = 'child-001';
    writeSession(tmpHome, parent, [
      sessionStart({ sessionId: parent }),
      userMessage({ content: 'parent q' }),
      assistantMessage({ content: 'parent a' }),
    ]);
    writeSession(tmpHome, child, [
      sessionStart({ sessionId: child }),
      sessionResume(parent), // child 续自 parent
      userMessage({ content: 'child q' }),
      assistantMessage({ content: 'child a' }),
    ]);

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.inserted).toBe(2);
    expect(stats.relationships).toBe(1);

    // 找到 child session（按 native id）
    const childSession = store.querySessions({ source: 'copilot', deviceId: DEVICE })
      .find((s) => s.nativeSessionId === child)!;
    const rels = store.queryRelationships(childSession.id);
    const cont = rels.find((r) => r.relationType === 'continued_from' && r.direction === 'outgoing');
    expect(cont).toBeDefined();
  });

  it('session.resume 父不存在 → 不写关系', () => {
    const child = 'orphan-001';
    writeSession(tmpHome, child, [
      sessionStart({ sessionId: child }),
      sessionResume('nonexistent-parent'),
      userMessage({ content: 'q' }),
      assistantMessage({ content: 'a' }),
    ]);

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.inserted).toBe(1);
    expect(stats.relationships).toBe(0); // 父未入库 → 不猜测
  });

  it('重复扫描幂等：内容相同不新增 revision', () => {
    const sessionId = 'idem-001';
    writeSession(tmpHome, sessionId, [
      sessionStart({ sessionId }),
      userMessage({ content: 'q' }),
      assistantMessage({ content: 'a' }),
    ]);

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    const s1 = importer.import();
    const s2 = importer.import();

    expect(s1.inserted).toBe(1);
    expect(s2.inserted).toBe(0);
    expect(s2.updated).toBe(0);
    expect(s2.unchanged).toBe(1);
  });

  it('内容变更生成新 revision', () => {
    const sessionId = 'rev-001';
    const dir = writeSession(tmpHome, sessionId, [
      sessionStart({ sessionId }),
      userMessage({ content: 'q1' }),
      assistantMessage({ content: 'a1' }),
    ]);

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    importer.import();

    // 追加一条消息
    const eventsPath = path.join(dir, 'events.jsonl');
    const existing = fs.readFileSync(eventsPath, 'utf8');
    const newEvent = JSON.stringify(assistantMessage({ content: 'a2 follow-up' })) + '\n';
    fs.writeFileSync(eventsPath, existing + newEvent, 'utf8');

    const stats2 = importer.import();
    expect(stats2.updated).toBe(1);
    expect(stats2.unchanged).toBe(0);

    const s = store.querySessions({ source: 'copilot', deviceId: DEVICE })[0]!;
    const msgs = store.getMessages(s.id);
    expect(msgs.length).toBe(3);
  });

  it('脏 JSONL：单行损坏被跳过', () => {
    const sessionId = 'dirty-001';
    writeSession(
      tmpHome,
      sessionId,
      [
        sessionStart({ sessionId }),
        userMessage({ content: 'q' }),
        assistantMessage({ content: 'a' }),
      ],
      {
        brokenLines: ['{ this is not valid json'],
      },
    );

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.inserted).toBe(1);
    const s = store.querySessions({ source: 'copilot', deviceId: DEVICE })[0]!;
    const msgs = store.getMessages(s.id);
    expect(msgs.length).toBe(2); // 1 user + 1 assistant
  });

  it('无有效消息：整 session 跳过', () => {
    const sessionId = 'empty-001';
    writeSession(tmpHome, sessionId, [
      sessionStart({ sessionId }),
      systemMessage('system only'),
      hookStart('sessionStart'),
      hookEnd('sessionStart'),
      shutdown(),
    ]);

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('无 events.jsonl：目录跳过', () => {
    const dir = path.join(tmpHome, 'session-state', 'no-events-001');
    fs.mkdirSync(dir, { recursive: true });
    // 只写 workspace.yaml，无 events.jsonl
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'cwd: /tmp/test\n', 'utf8');

    const importer = new CopilotImporter(store, { homePath: tmpHome, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.inserted).toBe(0);
  });

  it('导出 8 个 hook 类型 + 17 个 event 类型常量', () => {
    expect(COPILOT_HOOK_TYPES).toHaveLength(8);
    expect(COPILOT_HOOK_TYPES).toContain('sessionStart');
    expect(COPILOT_HOOK_TYPES).toContain('sessionEnd');
    expect(COPILOT_HOOK_TYPES).toContain('userPromptSubmitted');
    expect(COPILOT_HOOK_TYPES).toContain('preToolUse');
    expect(COPILOT_HOOK_TYPES).toContain('postToolUse');
    expect(COPILOT_HOOK_TYPES).toContain('agentStop');
    expect(COPILOT_HOOK_TYPES).toContain('subagentStop');
    expect(COPILOT_HOOK_TYPES).toContain('errorOccurred');

    expect(COPILOT_EVENT_TYPES).toHaveLength(17);
    expect(COPILOT_EVENT_TYPES).toContain('session.start');
    expect(COPILOT_EVENT_TYPES).toContain('session.shutdown');
    expect(COPILOT_EVENT_TYPES).toContain('user.message');
    expect(COPILOT_EVENT_TYPES).toContain('assistant.message');
    expect(COPILOT_EVENT_TYPES).toContain('hook.start');
    expect(COPILOT_EVENT_TYPES).toContain('hook.end');
  });
});
