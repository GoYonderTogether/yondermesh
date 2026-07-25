/**
 * build-sync-loud-failure loop 验收测试
 *
 * 验收门（loop §观察反馈）：
 *   1. 调用 sync() 抛出含「尚未实现 / planned」字样的 Error
 *   2. 不产生任何写入副作用（sync() 在触碰 store 前就抛错）
 *   3. start() 配置了 relay_url 时同步也显式失败（不静默成功）
 *
 * 对应 ARCHITECTURE §III.5「Failure is never silent」。
 * sync 整体仍是 planned——本测试只验证“显式失败”，不验证真实同步。
 */

import { describe, it, expect } from 'vitest';
import { SyncAgent } from '../src/sync/agent.js';
import type { SessionStore } from '../src/store/index.js';

/**
 * sync() 抛错前不会触碰 store。用一个探针 fake 记录所有属性访问/方法调用，
 * 断言“零写入副作用”。`touched` 属性本身正常返回数组，其余访问被记录。
 */
function makeProbeStore(): SessionStore & { touched: string[] } {
  const touched: string[] = [];
  const proxy = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'touched') return touched;
      touched.push(String(prop));
      // 方法访问返回 no-op（即使被调用也不产生副作用）
      return () => undefined;
    },
  });
  return proxy as unknown as SessionStore & { touched: string[] };
}

describe('build-sync-loud-failure: sync() 显式失败而非静默', () => {
  it('sync() 抛出含「尚未实现 / planned」字样的 Error', async () => {
    const store = makeProbeStore();
    const agent = new SyncAgent(store, {
      enabled: true,
      relayUrl: 'https://relay.example.invalid/c',
      keyFile: '/tmp/ymesh-test-key.pem',
    });

    // sync() 是 private，通过类型化 cast 直接测契约
    const syncFn = (agent as { sync: () => Promise<void> }).sync;
    await expect(syncFn.call(agent)).rejects.toThrow(/尚未实现|planned/);

    // 零写入副作用：sync() 在触碰 store 前就抛错
    expect(store.touched).toHaveLength(0);
  });

  it('start() 配置了 relay_url 时显式抛 sync 错误（不静默成功）', async () => {
    const store = makeProbeStore();
    const agent = new SyncAgent(store, {
      enabled: true,
      relayUrl: 'https://relay.example.invalid/c',
      keyFile: '/tmp/ymesh-test-key.pem',
    });

    await expect(agent.start()).rejects.toThrow(/尚未实现|planned/);
    // start() 在 sync() 抛错前不会触碰 store
    expect(store.touched).toHaveLength(0);
  });

  it('未配置 relay_url 时 start() 走 warn+return，不触发 sync()', async () => {
    // 未配置 relayUrl 是配置错误，warn 后 return 是原有行为，不在本 loop 改动范围
    const store = makeProbeStore();
    const agent = new SyncAgent(store, {
      enabled: true,
      keyFile: '/tmp/ymesh-test-key.pem',
    });

    await expect(agent.start()).resolves.toBeUndefined();
    // 未触碰 store（warn+return 分支不调 sync）
    expect(store.touched).toHaveLength(0);

    await agent.stop();
  });

  it('错误信息为中文「尚未实现」+ 标注 planned', async () => {
    const store = makeProbeStore();
    const agent = new SyncAgent(store, {
      enabled: true,
      relayUrl: 'https://relay.example.invalid/c',
      keyFile: '/tmp/ymesh-test-key.pem',
    });
    const syncFn = (agent as { sync: () => Promise<void> }).sync;

    let caught: unknown;
    try {
      await syncFn.call(agent);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain('尚未实现');
    expect(String((caught as Error).message)).toContain('planned');
  });
});
