/**
 * applier.test.ts — retain 删 session 不能留下孤儿行
 *
 * 背景（线上实测）：retain 自己开连接、不带 PRAGMA foreign_keys，
 * `DELETE FROM sessions` 既不级联也不报错，于是留下 32938 条孤儿 messages
 * （session 已不存在 → 任何查询都看不见 → 纯占空间，且让 FTS 一致性检查失真）。
 *
 * 验收门：
 *   R1. SL2 压缩重复 session 后，messages / session_revisions 无孤儿
 *   R2. 子表里被删的 session 行一条不留
 *   R3. 不误删非目标 session 的数据
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../store/index.js';
import { apply } from './applier.js';
import { DEFAULT_POLICY } from './policy.js';

const DEVICE = 'retain-test';

/** 造一个含重复 session 的库（同 cwd + 同首条 user 消息 + 时间相邻 → SL2 重复） */
function makeDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ymesh-retain-'));
  const dbPath = join(dir, 'retain.db');
  const store = new SessionStore(dbPath);
  const inst = store.registerSourceInstance({
    deviceId: DEVICE,
    source: 'claude-code',
    rootPath: '/fake/.claude',
    coverage: 'A',
  });

  const base = Date.now();
  // 消息数要超过 shortMaxMessages(10)，否则会先被 SL1「短问答」归类而进不了 SL2
  const mk = (nativeId: string, offsetMs: number, tail: string) =>
    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: nativeId,
      source: 'claude-code',
      cwd: '/repo/dup',
      projectPath: '/repo/dup',
      startedAt: base + offsetMs,
      fileModifiedAt: base + offsetMs,
      messages: [
        { role: 'user', content: '同一个开场白' },
        { role: 'assistant', content: '同一段回复' },
        ...Array.from({ length: 11 }, (_, k) => ({
          role: (k % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `第 ${k} 轮 ${tail}`,
        })),
      ],
    });

  // 两场时间相邻、首条 user 相同 → 判定重复（保留最新一场）
  mk('dup-a', 0, '第一场的尾巴');
  mk('dup-b', 5 * 60_000, '第二场的尾巴');
  // 一场无关的（不同 cwd / 不同开场白），不应被删
  store.ingestSession({
    deviceId: DEVICE,
    sourceInstanceId: inst.id,
    nativeSessionId: 'keep-me',
    source: 'claude-code',
    cwd: '/repo/other',
    projectPath: '/repo/other',
    startedAt: base,
    fileModifiedAt: base,
    messages: [
      { role: 'user', content: '完全不同的开场白' },
      ...Array.from({ length: 12 }, (_, k) => ({
        role: (k % 2 === 0 ? 'assistant' : 'user') as 'user' | 'assistant',
        content: `无关内容 ${k}`,
      })),
    ],
  });
  store.close();

  return {
    dbPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('retain apply：删 session 不留孤儿', () => {
  it('R1/R2/R3: 压缩重复 session 后子表干净、无辜 session 不受影响', () => {
    const { dbPath, cleanup } = makeDb();
    try {
      const result = apply(dbPath, { ...DEFAULT_POLICY, backupDir: join(tmpdir(), 'ymesh-retain-bak') }, {
        skipBackup: true,
      });
      expect(result.sessionDuplicateCompacted).toBeGreaterThan(0);

      const store = new SessionStore(dbPath);
      try {
        const db = (store as unknown as { db: { prepare: (s: string) => { get: () => unknown } } }).db;
        const orphanMsgs = db.prepare('SELECT count(*) AS n FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)').get() as { n: number };
        const orphanRevs = db.prepare('SELECT count(*) AS n FROM session_revisions WHERE session_id NOT IN (SELECT id FROM sessions)').get() as { n: number };
        expect(orphanMsgs.n).toBe(0);
        expect(orphanRevs.n).toBe(0);

        // 无关 session 还在
        const kept = store.querySessions({}).filter((s) => s.cwd === '/repo/other');
        expect(kept).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      cleanup();
    }
  });
});
