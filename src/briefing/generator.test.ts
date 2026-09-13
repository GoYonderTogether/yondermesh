/**
 * BriefingGenerator 测试
 *
 * 验收门：
 *   1. 多维切分计数与 store 实际值一致（bySource / byProject / byDevice / byHour）
 *   2. 完成 / 活跃 / 卡住待办计数正确
 *   3. 不漏报失败 session（sessions 列表覆盖全部今日 session）
 *   4. 空库不崩，successRate=1
 *   5. markdown 含关键段落
 *   6. enabled 时写入文件
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../store/index.js';
import type { SessionIngestInput } from '../store/index.js';
import { BriefingGenerator } from './generator.js';

const DEVICE_A = 'mac-001';
const DEVICE_B = 'mac-002';

function freshStore(): SessionStore {
  return new SessionStore(':memory:');
}

function registerInstances(store: SessionStore): void {
  store.registerSourceInstance({ deviceId: DEVICE_A, source: 'claude', rootPath: '/home/.claude/projects', coverage: 'A' });
  store.registerSourceInstance({ deviceId: DEVICE_B, source: 'codex', rootPath: '/home/.codex/sessions', coverage: 'A' });
}

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-briefing-'));
}

/** 构造一个 session 入库输入 */
function mkSession(opts: {
  store: SessionStore;
  sourceInstanceId: string;
  device: string;
  source: string;
  project: string;
  startedAt: number;
  fileModifiedAt: number;
  messages: { role: 'user' | 'assistant'; content: string }[];
  nativeId?: string;
}): void {
  const input: SessionIngestInput = {
    deviceId: opts.device,
    sourceInstanceId: opts.sourceInstanceId,
    nativeSessionId: opts.nativeId ?? `${opts.source}-${opts.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    source: opts.source,
    projectPath: opts.project,
    startedAt: opts.startedAt,
    fileModifiedAt: opts.fileModifiedAt,
    messages: opts.messages,
  };
  opts.store.ingestSession(input);
}

describe('BriefingGenerator', () => {
  let store: SessionStore;
  let tmpDir: string;

  beforeEach(() => {
    store = freshStore();
    registerInstances(store);
    tmpDir = mkdtemp();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('多维切分计数与 store 一致', async () => {
    const t0 = Date.now();
    // 取已注册的 source instance id
    const claudeInst = store.registerSourceInstance({ deviceId: DEVICE_A, source: 'claude', rootPath: '/home/.claude/projects', coverage: 'A' });
    const codexInst = store.registerSourceInstance({ deviceId: DEVICE_B, source: 'codex', rootPath: '/home/.codex/sessions', coverage: 'A' });

    mkSession({ store, sourceInstanceId: claudeInst.id, device: DEVICE_A, source: 'claude', project: '/repo1', startedAt: t0, fileModifiedAt: t0 - 7_200_000, messages: [{ role: 'user', content: 'do A' }, { role: 'assistant', content: 'done A' }] });
    mkSession({ store, sourceInstanceId: codexInst.id, device: DEVICE_B, source: 'codex', project: '/repo2', startedAt: t0, fileModifiedAt: t0 - 60_000, messages: [{ role: 'user', content: 'do B' }, { role: 'assistant', content: 'done B' }] });
    mkSession({ store, sourceInstanceId: claudeInst.id, device: DEVICE_A, source: 'claude', project: '/repo1', startedAt: t0, fileModifiedAt: t0 - 60_000, messages: [{ role: 'user', content: 'do C' }] });

    const gen = new BriefingGenerator(store, { enabled: false, output: tmpDir });
    const b = await gen.generate({ now: t0 });

    // 总数与 store stats 一致
    const stats = store.getSessionStats({});
    expect(b.totalSessions).toBe(stats.totalSessions);
    expect(b.totalMessages).toBe(stats.totalMessages);

    // 多维切分求和 = totalSessions
    expect(sum(b.bySource)).toBe(b.totalSessions);
    expect(sum(b.byProject)).toBe(b.totalSessions);
    expect(sum(b.byDevice)).toBe(b.totalSessions);
    expect(sumNum(b.byHour)).toBe(b.totalSessions);

    // 具体分组
    expect(b.bySource['claude']).toBe(2);
    expect(b.bySource['codex']).toBe(1);
    expect(b.byDevice[DEVICE_A]).toBe(2);
    expect(b.byDevice[DEVICE_B]).toBe(1);
    expect(b.byProject['/repo1']).toBe(2);
    expect(b.byProject['/repo2']).toBe(1);
    expect(b.agents.sort()).toEqual(['claude', 'codex']);
    expect(b.devices.sort()).toEqual([DEVICE_A, DEVICE_B]);
  });

  it('完成 / 活跃 / 卡住计数正确，不漏报 session', async () => {
    const t0 = Date.now();
    const claudeInst = store.registerSourceInstance({ deviceId: DEVICE_A, source: 'claude', rootPath: '/home/.claude/projects', coverage: 'A' });
    const codexInst = store.registerSourceInstance({ deviceId: DEVICE_B, source: 'codex', rootPath: '/home/.codex/sessions', coverage: 'A' });

    // A: 2h 前停止 → 已完成
    mkSession({ store, sourceInstanceId: claudeInst.id, device: DEVICE_A, source: 'claude', project: '/repo1', startedAt: t0, fileModifiedAt: t0 - 7_200_000, messages: [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'a' }] });
    // B: 1min 前，最后 assistant → 活跃 + 卡住待审阅
    mkSession({ store, sourceInstanceId: codexInst.id, device: DEVICE_B, source: 'codex', project: '/repo2', startedAt: t0, fileModifiedAt: t0 - 60_000, messages: [{ role: 'user', content: 'B' }, { role: 'assistant', content: 'b' }] });
    // C: 1min 前，最后 user → 活跃但不卡住
    mkSession({ store, sourceInstanceId: claudeInst.id, device: DEVICE_A, source: 'claude', project: '/repo1', startedAt: t0, fileModifiedAt: t0 - 60_000, messages: [{ role: 'user', content: 'C' }] });

    const gen = new BriefingGenerator(store, { enabled: false, output: tmpDir });
    const b = await gen.generate({ now: t0 });

    expect(b.totalSessions).toBe(3);
    expect(b.completedSessions).toBe(1); // A
    expect(b.activeSessions).toBe(2); // B + C
    expect(b.completedSessions + b.activeSessions).toBe(b.totalSessions);
    expect(b.awaitingReview).toBe(1); // B
    expect(b.stuckSessions).toHaveLength(1);
    expect(b.stuckSessions[0]!.agent).toBe('codex');
    expect(b.stuckSessions[0]!.summary).toContain('B');
    // 不漏报：sessions 列表覆盖全部今日 session
    expect(b.sessions).toHaveLength(3);
    expect(b.successRate).toBeCloseTo(1 / 3, 5);
  });

  it('空库不崩，successRate=1', async () => {
    const gen = new BriefingGenerator(store, { enabled: false, output: tmpDir });
    const b = await gen.generate();
    expect(b.totalSessions).toBe(0);
    expect(b.totalMessages).toBe(0);
    expect(b.completedSessions).toBe(0);
    expect(b.activeSessions).toBe(0);
    expect(b.awaitingReview).toBe(0);
    expect(b.successRate).toBe(1);
    expect(b.sessions).toHaveLength(0);
    expect(b.stuckSessions).toHaveLength(0);
  });

  it('markdown 含关键段落', async () => {
    const t0 = Date.now();
    const claudeInst = store.registerSourceInstance({ deviceId: DEVICE_A, source: 'claude', rootPath: '/home/.claude/projects', coverage: 'A' });
    mkSession({ store, sourceInstanceId: claudeInst.id, device: DEVICE_A, source: 'claude', project: '/repo1', startedAt: t0, fileModifiedAt: t0 - 60_000, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] });

    const gen = new BriefingGenerator(store, { enabled: false, output: tmpDir });
    const b = await gen.generate({ now: t0 });
    expect(b.markdown).toContain('晨报');
    expect(b.markdown).toContain('## 概览');
    expect(b.markdown).toContain('## 按 agent');
    expect(b.markdown).toContain('## 卡住待审阅');
    expect(b.markdown).toContain('## 全部 session');
    expect(b.markdown).toContain('完成率');
  });

  it('enabled 时写入 <date>.md 文件', async () => {
    const t0 = Date.now();
    const claudeInst = store.registerSourceInstance({ deviceId: DEVICE_A, source: 'claude', rootPath: '/home/.claude/projects', coverage: 'A' });
    mkSession({ store, sourceInstanceId: claudeInst.id, device: DEVICE_A, source: 'claude', project: '/repo1', startedAt: t0, fileModifiedAt: t0 - 60_000, messages: [{ role: 'user', content: 'hi' }] });

    const gen = new BriefingGenerator(store, { enabled: true, output: tmpDir });
    const b = await gen.generate({ date: '2026-07-25', now: t0 });
    const file = path.join(tmpDir, '2026-07-25.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe(b.markdown);
    expect(b.date).toBe('2026-07-25');
  });

  it('date 参数覆盖今日窗口（只统计该日）', async () => {
    const t0 = Date.now();
    const claudeInst = store.registerSourceInstance({ deviceId: DEVICE_A, source: 'claude', rootPath: '/home/.claude/projects', coverage: 'A' });
    // 昨天的 session
    const yesterday = t0 - 26 * 3600_000;
    mkSession({ store, sourceInstanceId: claudeInst.id, device: DEVICE_A, source: 'claude', project: '/repo1', startedAt: yesterday, fileModifiedAt: yesterday, messages: [{ role: 'user', content: 'old' }] });
    // 今天的 session
    mkSession({ store, sourceInstanceId: claudeInst.id, device: DEVICE_A, source: 'claude', project: '/repo1', startedAt: t0, fileModifiedAt: t0 - 60_000, messages: [{ role: 'user', content: 'new' }] });

    const gen = new BriefingGenerator(store, { enabled: false, output: tmpDir });
    const today = new Date(t0);
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const b = await gen.generate({ date: todayStr, now: t0 });
    // 只统计今天：1 条
    expect(b.totalSessions).toBe(1);
  });

  it('跨天续跑的长会话要算进今天（不再只看「今天开始」）', async () => {
    const t0 = Date.now();
    const claudeInst = store.registerSourceInstance({ deviceId: DEVICE_A, source: 'claude', rootPath: '/home/.claude/projects', coverage: 'A' });
    // 昨天 21:30 开始，今天还在写（文件 mtime 是刚刚）——线上真实案例：
    // codex fd4870c6，9/12 21:30 起、9/13 11:22 还在动，382 条消息，旧口径整场漏掉
    const startedYesterday = t0 - 14 * 3600_000;
    mkSession({
      store,
      sourceInstanceId: claudeInst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo/long-running',
      startedAt: startedYesterday,
      fileModifiedAt: t0 - 60_000, // 刚刚还在写
      messages: [{ role: 'user', content: '跑了一整晚的活' }],
    });

    const gen = new BriefingGenerator(store, { enabled: false, output: tmpDir });
    const today = new Date(t0);
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const b = await gen.generate({ date: todayStr, now: t0 });

    expect(b.totalSessions).toBe(1);
    expect(b.sessions[0].projectPath).toBe('/repo/long-running');
  });
});

function sum(rec: Record<string, number>): number {
  return Object.values(rec).reduce((a, b) => a + b, 0);
}
function sumNum(rec: Record<number, number>): number {
  return Object.values(rec).reduce((a, b) => a + b, 0);
}
