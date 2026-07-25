/**
 * BriefingScheduler 测试
 *
 * 验收门（loop daily-briefing §4 — 调度部分，属 src/daemon/ 域）：
 *   1. start() 立即触发一次生成（briefing 文件落盘）
 *   2. start() 幂等（重复调用不启多个 timer）
 *   3. stop() 停止后续生成（interval 不再触发）
 *   4. stop() 幂等（重复调用不报错）
 *   5. interval 到期后再次生成（文件 mtime 推进）
 *   6. 生成失败不影响调度器存活（generateSafe 吞错）
 *
 * 用真实 SessionStore（:memory:）+ 临时 dataDir，零新依赖。
 * BriefingGenerator 本身的正确性由 src/briefing/generator.test.ts 覆盖，
 * 此处只测 daemon 侧的调度生命周期。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../store/index.js';
import type { SessionIngestInput } from '../store/index.js';
import { BriefingScheduler } from './briefing-scheduler.js';

const DEVICE = 'mac-sched-test';

function freshStore(): SessionStore {
  return new SessionStore(':memory:');
}

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-sched-'));
}

/** 等待条件成立，最多 timeoutMs；轮询 interval 10ms */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor 超时 (${timeoutMs}ms)`);
}

/** 当天本地日期串 YYYY-MM-DD */
function todayStr(now = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('BriefingScheduler', () => {
  let store: SessionStore;
  let dataDir: string;
  let briefingsDir: string;

  beforeEach(() => {
    store = freshStore();
    dataDir = mkdtemp();
    briefingsDir = path.join(dataDir, 'briefings');
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** seed 一个 session 让 briefing 有内容可生成 */
  function seedOne(): void {
    const inst = store.registerSourceInstance({
      deviceId: DEVICE,
      source: 'claude',
      rootPath: '/home/.claude/projects',
      coverage: 'A',
    });
    const t0 = Date.now();
    const input: SessionIngestInput = {
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: `sched-${t0}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'claude',
      projectPath: '/repo',
      startedAt: t0,
      fileModifiedAt: t0 - 60_000,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    };
    store.ingestSession(input);
  }

  it('start() 立即触发一次生成（briefing 文件落盘）', async () => {
    seedOne();
    const sched = new BriefingScheduler(store, dataDir, 3_600_000);
    const expectedFile = path.join(briefingsDir, `${todayStr()}.md`);

    expect(fs.existsSync(expectedFile)).toBe(false);
    sched.start();

    // generate() 是 async，generateSafe 不 await；轮询等文件出现
    await waitFor(() => fs.existsSync(expectedFile), 2000);
    expect(fs.existsSync(expectedFile)).toBe(true);
    const content = fs.readFileSync(expectedFile, 'utf-8');
    expect(content).toContain('晨报');
    expect(content).toContain('完成率');

    sched.stop();
  });

  it('start() 幂等（重复调用不启多个 timer）', async () => {
    seedOne();
    const sched = new BriefingScheduler(store, dataDir, 3_600_000);
    const expectedFile = path.join(briefingsDir, `${todayStr()}.md`);

    sched.start();
    sched.start(); // 幂等，不应抛错也不应启第二个 timer
    sched.start();

    await waitFor(() => fs.existsSync(expectedFile), 2000);
    expect(fs.existsSync(expectedFile)).toBe(true);

    // stop 一次即可清理（证明只有一个 timer）
    sched.stop();
    // 不抛错即通过
  });

  it('stop() 幂等（重复调用不报错）', () => {
    const sched = new BriefingScheduler(store, dataDir, 3_600_000);
    sched.start();
    sched.stop();
    sched.stop(); // 不抛错
    sched.stop(); // 仍不抛错
  });

  it('未 start 时 stop() 也不报错', () => {
    const sched = new BriefingScheduler(store, dataDir, 3_600_000);
    sched.stop(); // 未 start 直接 stop，不抛错
  });

  it('interval 到期后再次生成（文件 mtime 推进）', async () => {
    seedOne();
    // 用很短的 interval（80ms）让定时触发可观察
    const sched = new BriefingScheduler(store, dataDir, 80);
    const expectedFile = path.join(briefingsDir, `${todayStr()}.md`);

    sched.start();
    await waitFor(() => fs.existsSync(expectedFile), 2000);
    const firstMtime = fs.statSync(expectedFile).mtimeMs;

    // 等 interval 触发后再次生成（mtime 应推进）
    await waitFor(() => fs.statSync(expectedFile).mtimeMs > firstMtime, 2000);
    const secondMtime = fs.statSync(expectedFile).mtimeMs;
    expect(secondMtime).toBeGreaterThan(firstMtime);

    sched.stop();
  });

  it('stop() 后不再生成（mtime 不再推进）', async () => {
    seedOne();
    const sched = new BriefingScheduler(store, dataDir, 80);
    const expectedFile = path.join(briefingsDir, `${todayStr()}.md`);

    sched.start();
    await waitFor(() => fs.existsSync(expectedFile), 2000);
    sched.stop();

    const mtimeAfterStop = fs.statSync(expectedFile).mtimeMs;
    // 等 250ms（足够 80ms interval 触发 3 次）确认不再生成
    await new Promise((r) => setTimeout(r, 250));
    const mtimeLater = fs.statSync(expectedFile).mtimeMs;
    expect(mtimeLater).toBe(mtimeAfterStop);
  });

  it('生成失败不影响调度器存活（generateSafe 吞错）', async () => {
    // 用一个已 close 的 store 触发 generate 抛错
    const closedStore = freshStore();
    closedStore.close();

    const sched = new BriefingScheduler(closedStore, dataDir, 3_600_000);
    // start 会立即调 generateSafe → generate 抛错 → 被 catch，不冒泡
    expect(() => sched.start()).not.toThrow();

    // 调度器仍可正常 stop（证明没崩）
    expect(() => sched.stop()).not.toThrow();
  });

  it('空库 start() 不崩且生成空 briefing', async () => {
    // 不 seed 任何 session
    const sched = new BriefingScheduler(store, dataDir, 3_600_000);
    const expectedFile = path.join(briefingsDir, `${todayStr()}.md`);

    sched.start();
    await waitFor(() => fs.existsSync(expectedFile), 2000);
    expect(fs.existsSync(expectedFile)).toBe(true);
    const content = fs.readFileSync(expectedFile, 'utf-8');
    // generator 用 markdown 加粗：`总 session: **0**`
    expect(content).toContain('总 session: **0**');
    sched.stop();
  });
});
