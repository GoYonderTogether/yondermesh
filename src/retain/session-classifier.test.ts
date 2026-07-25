/**
 * session-classifier 测试
 *
 * 验收门：
 *   1. SL0：纯噪音 session（>= 80% 消息是已知噪音）→ 归入 noiseSessions
 *   2. SL1：消息数 < 10 且时长 < 5min 的 session → 归入 shortSessions（排除 SL0）
 *   3. SL2：同 cwd+source+首条 user 消息 + 30min 内重复 → 保留最新，其余归入 duplicateSessions
 *   4. 三层互斥：同一 session 不会同时出现在多个分类
 *   5. 空库不崩
 *   6. 没有 user 消息的 session 不参与 SL2 分组
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SessionStore } from '../store/index.js';
import type { SessionIngestInput } from '../store/index.js';
import {
  DEFAULT_POLICY,
  compileNoiseRules,
} from './policy.js';
import { classifySessions } from './session-classifier.js';

// node:sqlite 是实验性内置，vitest/vite 静态解析会误判为裸包 sqlite。
// 用 createRequire 在运行时加载，绕过 vite 预优化（与 SessionStore 一致）
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

let tmpDir: string;
let dbPath: string;
let store: SessionStore;

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-classifier-'));
}

function freshStore(): { store: SessionStore; dbPath: string } {
  tmpDir = mkdtemp();
  dbPath = path.join(tmpDir, 'test.db');
  store = new SessionStore(dbPath);
  return { store, dbPath };
}

function mkSession(opts: {
  device?: string;
  source?: string;
  sourceInstanceId?: string;
  project?: string;
  cwd?: string;
  startedAt: number;
  messages: { role: 'user' | 'assistant' | 'tool' | 'system'; content: string }[];
  nativeId?: string;
  topology?: 'root' | 'subagent';
}): string {
  const input: SessionIngestInput = {
    deviceId: opts.device ?? 'dev-1',
    sourceInstanceId: opts.sourceInstanceId ?? siId,
    nativeSessionId: opts.nativeId ?? `native-${opts.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    source: opts.source ?? 'claude',
    projectPath: opts.project ?? '/repo/test',
    cwd: opts.cwd ?? opts.project ?? '/repo/test',
    startedAt: opts.startedAt,
    messages: opts.messages,
    topology: opts.topology ?? 'root',
  };
  return store.ingestSession(input).sessionId;
}

let siId: string;

beforeEach(() => {
  freshStore();
  // 必须先注册 source_instance，因为 sessions.source_instance_id 有外键约束
  const si = store.registerSourceInstance({
    deviceId: 'dev-1',
    source: 'claude',
    coverage: 'A',
  });
  siId = si.id;
});

afterEach(() => {
  store.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('classifySessions', () => {
  it('空库不崩', () => {
    const db = new DatabaseSync(dbPath);
    try {
      const result = classifySessions(db, DEFAULT_POLICY, compileNoiseRules(DEFAULT_POLICY.noise));
      expect(result.noiseSessions).toHaveLength(0);
      expect(result.shortSessions).toHaveLength(0);
      expect(result.duplicateSessions).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('SL0：纯噪音 session 被识别（80%+ 是已知噪音）', () => {
    // 一个 session 全是 "继续" + "No response requested." 交替
    // 需要每种噪音 content 全库出现 >= 5 次（classifier 的 HAVING c >= 5 阈值）
    const noiseMsgs = [
      { role: 'user' as const, content: '继续' },
      { role: 'assistant' as const, content: 'No response requested.' },
      { role: 'user' as const, content: '继续' },
      { role: 'assistant' as const, content: 'No response requested.' },
      { role: 'user' as const, content: '继续' },
      { role: 'assistant' as const, content: 'No response requested.' },
      { role: 'user' as const, content: '继续' },
      { role: 'assistant' as const, content: 'No response requested.' },
      { role: 'user' as const, content: '继续' },
      { role: 'assistant' as const, content: 'No response requested.' },
    ];
    mkSession({
      startedAt: Date.now() - 60_000,
      messages: noiseMsgs,
    });

    // 对比：一个正常 session（不含噪音）
    mkSession({
      startedAt: Date.now() - 60_000,
      messages: [
        { role: 'user', content: '帮我写一个函数' },
        { role: 'assistant', content: '好的，我帮你写一个函数：...' },
        { role: 'user', content: '完善一下细节' },
        { role: 'assistant', content: '已经完善，请看：...' },
      ],
    });

    const db = new DatabaseSync(dbPath);
    try {
      const result = classifySessions(db, DEFAULT_POLICY, compileNoiseRules(DEFAULT_POLICY.noise));
      expect(result.noiseSessions.length).toBe(1);
      expect(result.noiseSessions[0]!.messageCount).toBeGreaterThanOrEqual(5);
    } finally {
      db.close();
    }
  });

  it('SL1：短问答 session 被识别（< 10 消息 且 < 5min）', () => {
    // 短问答 session：4 条消息，时长 1 分钟
    mkSession({
      startedAt: Date.now() - 60_000,
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮你的吗？' },
        { role: 'user', content: '没事了' },
        { role: 'assistant', content: '好的' },
      ],
    });

    // 长 session（排除）
    mkSession({
      startedAt: Date.now() - 60 * 60 * 1000,
      messages: Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `message ${i}`,
      })),
    });

    const db = new DatabaseSync(dbPath);
    try {
      const result = classifySessions(db, DEFAULT_POLICY, compileNoiseRules(DEFAULT_POLICY.noise));
      expect(result.shortSessions.length).toBe(1);
      expect(result.shortSessions[0]!.messageCount).toBeLessThan(10);
    } finally {
      db.close();
    }
  });

  it('SL2：重复 session 被识别（同 cwd+source+首条 user 消息，30min 内）', () => {
    const cwd = '/repo/test';
    const firstUserMsg = '帮我重构这段代码';
    const baseTime = Date.now();

    // 三个 session，相同 cwd/source/首条 user 消息，都在 30 分钟内
    mkSession({
      cwd,
      startedAt: baseTime - 25 * 60 * 1000,
      messages: [
        { role: 'user', content: firstUserMsg },
        { role: 'assistant', content: '我尝试了方案 A' },
      ],
    });
    mkSession({
      cwd,
      startedAt: baseTime - 20 * 60 * 1000,
      messages: [
        { role: 'user', content: firstUserMsg },
        { role: 'assistant', content: '我尝试了方案 B' },
      ],
    });
    mkSession({
      cwd,
      startedAt: baseTime - 5 * 60 * 1000,
      messages: [
        { role: 'user', content: firstUserMsg },
        { role: 'assistant', content: '我尝试了方案 C' },
      ],
    });

    const db = new DatabaseSync(dbPath);
    try {
      const result = classifySessions(db, DEFAULT_POLICY, compileNoiseRules(DEFAULT_POLICY.noise));
      // 应有 2 个被标为重复（保留最新的）
      expect(result.duplicateSessions.length).toBe(2);
    } finally {
      db.close();
    }
  });

  it('SL0/SL1/SL2 互斥：同一 session 不会出现在多个分类中', () => {
    // 一个既是纯噪音又是短会话的 session（SL0 优先）
    mkSession({
      startedAt: Date.now() - 60_000,
      messages: [
        { role: 'user', content: '继续' },
        { role: 'assistant', content: 'No response requested.' },
        { role: 'user', content: '继续' },
        { role: 'assistant', content: 'No response requested.' },
      ],
    });

    const db = new DatabaseSync(dbPath);
    try {
      const result = classifySessions(db, DEFAULT_POLICY, compileNoiseRules(DEFAULT_POLICY.noise));
      const allIds = [
        ...result.noiseSessions.map((s) => s.id),
        ...result.shortSessions.map((s) => s.id),
        ...result.duplicateSessions.map((s) => s.id),
      ];
      const unique = new Set(allIds);
      expect(unique.size).toBe(allIds.length);
    } finally {
      db.close();
    }
  });

  it('SL2 超出时间窗的不算重复', () => {
    const cwd = '/repo/old-test';
    const firstUserMsg = '帮我做这件事';
    const baseTime = Date.now();

    // 一个最近的 session
    mkSession({
      cwd,
      startedAt: baseTime - 5 * 60 * 1000,
      messages: [
        { role: 'user', content: firstUserMsg },
        { role: 'assistant', content: 'recent' },
      ],
    });

    // 一个超出 30min 时间窗的旧 session（不算重复）
    mkSession({
      cwd,
      startedAt: baseTime - 2 * 60 * 60 * 1000, // 2 小时前
      messages: [
        { role: 'user', content: firstUserMsg },
        { role: 'assistant', content: 'old' },
      ],
    });

    const db = new DatabaseSync(dbPath);
    try {
      const result = classifySessions(db, DEFAULT_POLICY, compileNoiseRules(DEFAULT_POLICY.noise));
      expect(result.duplicateSessions.length).toBe(0);
    } finally {
      db.close();
    }
  });
});
