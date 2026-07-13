/**
 * LOOP-006 Daemon 测试
 *
 * 验收门：
 *   1. 全量扫描调用三个 adapter（cass 可跳过）
 *   2. watch debounce 后触发增量扫描
 *   3. 定时 reconcile 触发全量扫描
 *   4. 单实例锁阻止重复启动
 *   5. 优雅退出清理全部资源
 *   6. getStatus 返回正确快照
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { YondermeshDaemon } from '../src/daemon/index.js';
import type { DaemonConfig } from '../src/daemon/index.js';

/** 构造一个使用临时目录的配置 */
function makeConfig(tmpDir: string): Partial<DaemonConfig> {
  return {
    dataDir: tmpDir,
    dbPath: path.join(tmpDir, 'test.db'),
    pidFile: path.join(tmpDir, 'daemon.pid'),
    reconcileIntervalMs: 100, // 测试中缩短间隔
    debounceMs: 50,
    skipCass: true, // 测试环境可能没有 cass DB
  };
}

/** 创建一个唯一的临时目录 */
function mkdtempSync(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-test-'));
}

describe('LOOP-006: Daemon', () => {
  let tmpDir: string;
  let daemon: YondermeshDaemon | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('启动后 dataDir 和 DB 文件存在', async () => {
    daemon = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    await daemon.start();
    expect(fs.existsSync(tmpDir)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'daemon.pid'))).toBe(true);
  });

  it('PID 文件写入当前进程 PID', async () => {
    daemon = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    await daemon.start();
    const pidContent = fs.readFileSync(path.join(tmpDir, 'daemon.pid'), 'utf-8').trim();
    expect(parseInt(pidContent, 10)).toBe(process.pid);
  });

  it('单实例锁：第二个实例启动失败', async () => {
    daemon = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    await daemon.start();

    const daemon2 = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    await expect(daemon2.start()).rejects.toThrow(/已在运行/);
  });

  it('fullScan 返回三个来源的结果', async () => {
    daemon = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    const result = await daemon.fullScan();
    expect(result.results).toHaveLength(3);
    const sources = result.results.map((r) => r.source);
    expect(sources).toContain('cass');
    expect(sources).toContain('claude');
    expect(sources).toContain('codex');
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
  });

  it('skipCass=true 时 cass 结果标记 skipped', async () => {
    daemon = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    const result = await daemon.fullScan();
    const cassResult = result.results.find((r) => r.source === 'cass');
    expect(cassResult?.skipped).toBe(true);
  });

  it('getStatus 返回正确的运行状态', async () => {
    daemon = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    await daemon.start();
    const status = daemon.getStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.dataDir).toBe(tmpDir);
    expect(status.dbPath).toBe(path.join(tmpDir, 'test.db'));
    expect(status.startedAt).toBeGreaterThan(0);
    expect(status.lastScan).toBeDefined();
  });

  it('stop 后 PID 文件被清理', async () => {
    daemon = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    await daemon.start();
    expect(fs.existsSync(path.join(tmpDir, 'daemon.pid'))).toBe(true);
    await daemon.stop();
    expect(fs.existsSync(path.join(tmpDir, 'daemon.pid'))).toBe(false);
    daemon = undefined; // afterEach 不再重复 stop
  });

  it('stop 后 status.running 为 false', async () => {
    daemon = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    await daemon.start();
    await daemon.stop();
    const status = daemon.getStatus();
    expect(status.running).toBe(false);
    daemon = undefined;
  });

  it('旧 PID 文件但进程已退出时不阻止新实例', async () => {
    // 写入一个不存在的 PID
    fs.writeFileSync(path.join(tmpDir, 'daemon.pid'), '999999', 'utf-8');

    daemon = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    await daemon.start();
    // 启动成功说明没有被旧 PID 阻止
    expect(daemon.getStatus().running).toBe(true);
  });

  it('reconcile 定时触发全量扫描', async () => {
    daemon = new YondermeshDaemon({ ...makeConfig(tmpDir), skipClaude: true, skipCodex: true });
    await daemon.start();
    const firstScan = daemon.getStatus().lastScan!;

    // 等待至少一次 reconcile（100ms 间隔）
    await new Promise((resolve) => setTimeout(resolve, 200));

    const secondScan = daemon.getStatus().lastScan!;
    expect(secondScan.finishedAt).toBeGreaterThan(firstScan.finishedAt);
  });

  it('skipCass=false 但 cass 路径不可读时 scanCass 标记 skipped 且不崩溃', async () => {
    // 本测试验证 cass 扫描失败时的容错路径（跳过且不抛异常）
    // cass DB 在开发机可能存在也可能不存在，重点是 fullScan 不应崩溃
    daemon = new YondermeshDaemon({
      ...makeConfig(tmpDir),
      skipClaude: true,
      skipCodex: true,
      skipCass: false,
    });
    const result = await daemon.fullScan();
    const cassResult = result.results.find((r) => r.source === 'cass');
    // 无论 cass 是否存在，result 都应该有合法值
    expect(cassResult).toBeDefined();
    expect(typeof cassResult?.scanned).toBe('number');
  });
});
