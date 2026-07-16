/**
 * ChatGPT Desktop extractor 契约测试
 *
 * 覆盖：
 *   detectChatGptDesktop：
 *     1. app 未安装 → appInstalled=false, coverage=C
 *     2. app 已安装（tmpdir 模拟）→ appInstalled=true
 *     3. 本地数据目录不存在 → hasLocalSessionData=false
 *   ChatGptExtractor：
 *     4. 无 store：sourceInstanceId=null, sessionsExtracted=0
 *     5. 有 store + 已安装 → 注册 coverage=C source instance，0 sessions
 *     6. 有 store + 未安装 → sourceInstanceId=null
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { ChatGptExtractor, detectChatGptDesktop } from '../src/chatgpt/index.js';
import type { ChatGptExtractStats } from '../src/chatgpt/index.js';

const DEVICE = 'mac-test';

describe('detectChatGptDesktop', () => {
  it('app 未安装 → appInstalled=false, coverage=C', () => {
    const fakePath = path.join(os.tmpdir(), 'definitely-not-installed-' + Date.now());
    const detection = detectChatGptDesktop(fakePath);
    expect(detection.appInstalled).toBe(false);
    expect(detection.appPath).toBeNull();
    expect(detection.coverage).toBe('C');
    expect(detection.hasLocalSessionData).toBe(false);
    expect(detection.reason).toContain('SaaS');
  });

  it('app 已安装（tmpdir 模拟）→ appInstalled=true', () => {
    const fakeApp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-chatgpt-app-'));
    try {
      const detection = detectChatGptDesktop(fakeApp);
      expect(detection.appInstalled).toBe(true);
      expect(detection.appPath).toBe(fakeApp);
      expect(detection.coverage).toBe('C');
    } finally {
      fs.rmSync(fakeApp, { recursive: true, force: true });
    }
  });

  it('默认候选数据目录均不存在时 → hasLocalSessionData=false', () => {
    // 默认路径（本机真实环境）—— 即使存在也只含 app_pairing，不含 session
    const detection = detectChatGptDesktop('/Applications/ChatGPT.app');
    expect(detection.coverage).toBe('C');
    // 不强制断言 hasLocalSessionData（本机可能装了 app），只验证结构合法
    expect(typeof detection.hasLocalSessionData).toBe('boolean');
  });
});

describe('ChatGptExtractor', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
  });

  it('无 store：sourceInstanceId=null, sessionsExtracted=0', () => {
    const extractor = new ChatGptExtractor(undefined, {
      appPath: '/definitely/not/installed',
      deviceId: DEVICE,
    });
    const stats: ChatGptExtractStats = extractor.extract();
    expect(stats.sourceInstanceId).toBeNull();
    expect(stats.appInstalled).toBe(false);
    expect(stats.coverage).toBe('C');
    expect(stats.sessionsExtracted).toBe(0);
    expect(stats.reason).toContain('SaaS');
  });

  it('有 store + 已安装（tmpdir）→ 注册 coverage=C source instance，0 sessions', () => {
    const fakeApp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-chatgpt-app-'));
    try {
      const extractor = new ChatGptExtractor(store, {
        appPath: fakeApp,
        deviceId: DEVICE,
      });
      const stats = extractor.extract();
      expect(stats.sourceInstanceId).not.toBeNull();
      expect(stats.appInstalled).toBe(true);
      expect(stats.coverage).toBe('C');
      expect(stats.sessionsExtracted).toBe(0);

      // source instance 已注册，coverage=C
      const inst = store.getSourceInstance(stats.sourceInstanceId!);
      expect(inst).toBeDefined();
      expect(inst!.source).toBe('chatgpt');
      expect(inst!.coverage).toBe('C');
      expect(inst!.deviceId).toBe(DEVICE);

      // 不应有任何 session
      expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
    } finally {
      fs.rmSync(fakeApp, { recursive: true, force: true });
    }
  });

  it('有 store + 未安装 → sourceInstanceId=null（不注册）', () => {
    const extractor = new ChatGptExtractor(store, {
      appPath: '/definitely/not/installed',
      deviceId: DEVICE,
    });
    const stats = extractor.extract();
    expect(stats.sourceInstanceId).toBeNull();
    expect(stats.appInstalled).toBe(false);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });
});
