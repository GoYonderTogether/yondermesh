/**
 * OpenClaw + Kimi 原生 adapter 契约测试
 *
 * 覆盖验收：
 *   1. OpenClaw importer：解析 session 头 + message 行，user/assistant 文本入库
 *   2. OpenClaw importer：脏行跳过、无消息跳过、幂等
 *   3. OpenClaw importer：model_change / thinking_level_change / custom 行不产生消息
 *   4. Kimi importer：解析 context.jsonl，user/assistant 文本入库
 *   5. Kimi importer：_system_prompt / tool 行排除
 *   6. CLI 链式注入：系统提示词 + skill 内容正确拼接（等效 MCP/Skill/Always-on）
 *   7. session 转交：extractSession / transferSession 提取中性格式
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { OpenClawImporter, resolveOpenClawPath } from '../src/openclaw/index.js';
import { KimiImporter, resolveKimiPath } from '../src/kimi/index.js';
import { OpenClawController, CliChainInjector } from '../src/openclaw/index.js';
import { KimiController, KimiWireInjector } from '../src/kimi/index.js';
import type { OpenClawImportStats, KimiImportStats } from '../src/index.js';

const DEVICE = 'mac-test';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

/** OpenClaw session 头行 */
function ocSessionHeader(id: string, cwd?: string): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-06-26T20:16:11.929Z',
    cwd: cwd ?? '/Users/zoran/.openclaw/workspace',
  });
}

/** OpenClaw message 行 */
function ocMessage(role: 'user' | 'assistant', text: string, opts?: { model?: string; provider?: string; timestamp?: string }): string {
  return JSON.stringify({
    type: 'message',
    id: 'msg-' + Math.random().toString(36).slice(2, 8),
    parentId: null,
    timestamp: opts?.timestamp ?? '2026-06-26T20:16:12.000Z',
    message: {
      role,
      content: [{ type: 'text', text }],
      provider: opts?.provider ?? 'bai',
      model: opts?.model ?? 'glm-5.2',
      timestamp: 1782504972000,
      usage: { input: 100, output: 50, totalTokens: 150, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      stopReason: 'end',
    },
  });
}

/** OpenClaw model_change 行 */
function ocModelChange(provider: string, modelId: string): string {
  return JSON.stringify({
    type: 'model_change',
    id: 'mc-' + Math.random().toString(36).slice(2, 8),
    parentId: null,
    timestamp: '2026-06-26T20:16:11.935Z',
    provider,
    modelId,
  });
}

/** OpenClaw thinking_level_change 行（必须排除） */
function ocThinkingLevel(level: string): string {
  return JSON.stringify({
    type: 'thinking_level_change',
    id: 'tl-' + Math.random().toString(36).slice(2, 8),
    parentId: null,
    timestamp: '2026-06-26T20:16:11.935Z',
    thinkingLevel: level,
  });
}

/** Kimi context.jsonl 行 */
function kimiContextLine(role: string, content: string): string {
  return JSON.stringify({ role, content });
}

// ─── OpenClaw importer 测试 ──────────────────────────────────────────────

describe('OpenClawImporter', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-oc-'));
    store = new SessionStore(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('解析 session 头 + user/assistant message 入库', () => {
    const sessionId = 'f02eb565-c84a-4509-9620-d9a96c53ab3f';
    const sessionsDir = path.join(tmpDir, 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      [
        ocSessionHeader(sessionId),
        ocModelChange('bai', 'glm-5.2'),
        ocThinkingLevel('off'),
        ocMessage('user', '你好'),
        ocMessage('assistant', '你好！有什么可以帮你的？'),
      ].join('\n'),
    );

    const importer = new OpenClawImporter(store, { rootPath: tmpDir, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0);
  });

  it('脏行跳过，无有效消息文件跳过', () => {
    const sessionsDir = path.join(tmpDir, 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // 文件 1：含脏行但有效消息
    fs.writeFileSync(
      path.join(sessionsDir, 'a.jsonl'),
      [
        'not-json',
        ocSessionHeader('aaa'),
        ocMessage('user', 'hello'),
      ].join('\n'),
    );
    // 文件 2：仅含 session 头 + model_change，无有效消息
    fs.writeFileSync(
      path.join(sessionsDir, 'b.jsonl'),
      [ocSessionHeader('bbb'), ocModelChange('bai', 'glm-5.2'), ocThinkingLevel('off')].join('\n'),
    );

    const importer = new OpenClawImporter(store, { rootPath: tmpDir, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(1);
  });

  it('重复扫描幂等：不新增 revision', () => {
    const sessionId = 'idempotent-test';
    const sessionsDir = path.join(tmpDir, 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      [ocSessionHeader(sessionId), ocMessage('user', 'test')].join('\n'),
    );

    const importer = new OpenClawImporter(store, { rootPath: tmpDir, deviceId: DEVICE });
    const stats1 = importer.import();
    const stats2 = importer.import();

    expect(stats1.inserted).toBe(1);
    expect(stats2.unchanged).toBe(1);
    expect(stats2.inserted).toBe(0);
  });

  it('旋转文件 .reset. 也被扫描', () => {
    const sessionId = 'rotated-session';
    const sessionsDir = path.join(tmpDir, 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.jsonl.reset.2026-06-25T20-16-07.123Z`),
      [ocSessionHeader(sessionId), ocMessage('user', 'old message')].join('\n'),
    );

    const importer = new OpenClawImporter(store, { rootPath: tmpDir, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
  });
});

// ─── Kimi importer 测试 ──────────────────────────────────────────────────

describe('KimiImporter', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-kimi-'));
    store = new SessionStore(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('解析 context.jsonl，user/assistant 文本入库', () => {
    const workDirHash = '1dd63d98c084c4af9b1b0ab2a8a8d472';
    const sessionUuid = '218957c1-7511-4718-9539-279040d388ec';
    const sessionDir = path.join(tmpDir, 'sessions', workDirHash, sessionUuid);
    fs.mkdirSync(sessionDir, { recursive: true });

    fs.writeFileSync(
      path.join(sessionDir, 'context.jsonl'),
      [
        kimiContextLine('_system_prompt', 'You are Kimi...'),
        kimiContextLine('user', '你好'),
        kimiContextLine('assistant', '你好！'),
      ].join('\n'),
    );

    const importer = new KimiImporter(store, { rootPath: tmpDir, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0);
  });

  it('_system_prompt / tool 行排除，无有效消息跳过', () => {
    const workDirHash = 'abc123';
    const sessionUuid = 'no-user-msg-session';
    const sessionDir = path.join(tmpDir, 'sessions', workDirHash, sessionUuid);
    fs.mkdirSync(sessionDir, { recursive: true });

    fs.writeFileSync(
      path.join(sessionDir, 'context.jsonl'),
      [
        kimiContextLine('_system_prompt', 'system only'),
        kimiContextLine('tool', 'tool result'),
      ].join('\n'),
    );

    const importer = new KimiImporter(store, { rootPath: tmpDir, deviceId: DEVICE });
    const stats = importer.import();

    // scanned 计数含所有有 context.jsonl 的 session（含被跳过的）
    expect(stats.scanned).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.inserted).toBe(0);
  });

  it('无 context.jsonl 的 session 跳过', () => {
    const workDirHash = 'noctx';
    const sessionUuid = 'no-ctx-uuid';
    const sessionDir = path.join(tmpDir, 'sessions', workDirHash, sessionUuid);
    fs.mkdirSync(sessionDir, { recursive: true });
    // 不写 context.jsonl

    const importer = new KimiImporter(store, { rootPath: tmpDir, deviceId: DEVICE });
    const stats = importer.import();

    expect(stats.scanned).toBe(0);
    expect(stats.skipped).toBe(1);
  });
});

// ─── CLI 链式注入测试 ─────────────────────────────────────────────────────

describe('CliChainInjector（CLI 链式注入等效 MCP/Skill/Always-on）', () => {
  let tmpDir: string;
  let skillFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-inj-'));
    skillFile = path.join(tmpDir, 'test-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, '# Test Skill\n\nThis is a test skill for injection.');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('系统提示词 + skill 内容 + 用户 prompt 正确拼接', () => {
    const ctrl = new OpenClawController({ rootPath: tmpDir });
    const injector = new CliChainInjector(ctrl, {
      systemPrompt: '你是 yondermesh 节点',
      skillFiles: [skillFile],
    });

    const { prompt, skillsInjected, systemPromptInjected } = injector.buildLaunchedPrompt('执行任务');

    expect(systemPromptInjected).toBe(true);
    expect(skillsInjected).toBe(1);
    expect(prompt).toContain('你是 yondermesh 节点');
    expect(prompt).toContain('# Test Skill');
    expect(prompt).toContain('执行任务');
    // 验证格式块标记存在
    expect(prompt).toContain('<<<SYSTEM CONTEXT (always-on equivalent)>>>');
    expect(prompt).toContain('<<<SKILL: test-skill>>>');
  });

  it('verifyEquivalence 验证 CLI 链式注入等效 MCP/Skill', () => {
    const ctrl = new OpenClawController({ rootPath: tmpDir });
    const injector = new CliChainInjector(ctrl, {
      systemPrompt: 'always-on system prompt',
      skillFiles: [skillFile],
    });

    const result = injector.verifyEquivalence();
    expect(result.systemPromptInSession).toBe(true);
    expect(result.skillInSession).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('无系统提示词时 systemPromptInjected=false', () => {
    const ctrl = new OpenClawController({ rootPath: tmpDir });
    const injector = new CliChainInjector(ctrl, {
      skillFiles: [skillFile],
    });

    const { systemPromptInjected, skillsInjected } = injector.buildLaunchedPrompt('test');
    expect(systemPromptInjected).toBe(false);
    expect(skillsInjected).toBe(1);
  });
});

// ─── Kimi Wire 注入测试 ────────────────────────────────────────────────────

describe('KimiWireInjector（Wire 协议 + CLI 链式注入）', () => {
  let tmpDir: string;
  let skillFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-kimi-inj-'));
    skillFile = path.join(tmpDir, 'kimi-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, '# Kimi Skill\n\nKimi skill content.');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('系统提示词 + skill 内容 + 用户 prompt 正确拼接', () => {
    const ctrl = new KimiController({ rootPath: tmpDir });
    const injector = new KimiWireInjector(ctrl, {
      systemPrompt: '你是 yondermesh Kimi 节点',
      skillFiles: [skillFile],
    });

    const { prompt, skillsInjected, systemPromptInjected } = injector.buildLaunchedPrompt('执行任务');

    expect(systemPromptInjected).toBe(true);
    expect(skillsInjected).toBe(1);
    expect(prompt).toContain('你是 yondermesh Kimi 节点');
    expect(prompt).toContain('# Kimi Skill');
    expect(prompt).toContain('执行任务');
  });

  it('verifyEquivalence 验证 CLI 链式注入等效', () => {
    const ctrl = new KimiController({ rootPath: tmpDir });
    const injector = new KimiWireInjector(ctrl, {
      systemPrompt: 'kimi always-on',
      skillFiles: [skillFile],
    });

    const result = injector.verifyEquivalence();
    expect(result.ok).toBe(true);
  });
});

// ─── session 转交测试 ──────────────────────────────────────────────────────

describe('session 转交（extractSession / transferSession）', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-transfer-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('OpenClaw extractSession 提取消息 + transferSession 转中性格式', () => {
    const sessionId = 'transfer-test-uuid';
    const sessionsDir = path.join(tmpDir, 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      [
        ocSessionHeader(sessionId, '/project/path'),
        ocModelChange('bai', 'glm-5.2'),
        ocMessage('user', 'build feature X'),
        ocMessage('assistant', 'I will build feature X now.'),
      ].join('\n'),
    );

    const ctrl = new OpenClawController({ rootPath: tmpDir });
    const messages = ctrl.extractSession(sessionId);
    expect(messages).not.toBeNull();
    expect(messages!.length).toBe(2);
    expect(messages![0].role).toBe('user');
    expect(messages![0].content).toBe('build feature X');

    const transferred = ctrl.transferSession(sessionId);
    expect(transferred).not.toBeNull();
    expect(transferred!.source).toBe('openclaw');
    expect(transferred!.sessionId).toBe(sessionId);
    expect(transferred!.cwd).toBe('/project/path');
    expect(transferred!.model).toBe('glm-5.2');
    expect(transferred!.messages.length).toBe(2);
  });

  it('Kimi extractSession 提取消息 + transferSession 转中性格式', () => {
    const workDirHash = 'transferhash';
    const sessionUuid = 'kimi-transfer-uuid';
    const sessionDir = path.join(tmpDir, 'sessions', workDirHash, sessionUuid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'context.jsonl'),
      [
        kimiContextLine('_system_prompt', 'system'),
        kimiContextLine('user', 'implement Y'),
        kimiContextLine('assistant', 'Starting implementation of Y.'),
      ].join('\n'),
    );

    const ctrl = new KimiController({ rootPath: tmpDir });
    const messages = ctrl.extractSession(sessionUuid);
    expect(messages).not.toBeNull();
    expect(messages!.length).toBe(2);
    expect(messages![0].content).toBe('implement Y');

    const transferred = ctrl.transferSession(sessionUuid);
    expect(transferred).not.toBeNull();
    expect(transferred!.source).toBe('kimi');
    expect(transferred!.sessionId).toBe(sessionUuid);
    expect(transferred!.messages.length).toBe(2);
  });
});
