/**
 * Amp importer 契约测试
 *
 * 覆盖：
 *   parseAmpExport：
 *     1. v5 thread JSON：提取 user/assistant 消息 + projectPath（file:// 还原）+ agentMode
 *     2. 缺 id → null
 *     3. content 为字符串的回退
 *     4. 非 text 块排除 / system·tool 角色排除
 *   parseAmpThreadLog：
 *     5. NDJSON：earliest @timestamp + message_added 计数
 *   AmpImporter（注入 fake runner）：
 *     6. auth 可用：list + export → coverage=B，session 入库
 *     7. auth 失败 + 无日志 → coverage=C，0 sessions
 *     8. auth 失败 + 日志发现 id，但 export 也失败 → skipped
 *     9. 空消息 thread 跳过
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { AmpImporter, parseAmpExport, parseAmpThreadLog, AMP_AUTH_HELPER } from '../src/amp/index.js';
import type { AmpCommandRunner, AmpImportStats } from '../src/amp/index.js';

const DEVICE = 'mac-test';

const AMP_V5_FIXTURE = {
  v: 5,
  id: 'T-abc123',
  created: 1721000000000,
  env: {
    initial: {
      trees: [{ uri: 'file:///Users/test/proj', displayName: 'proj' }],
    },
  },
  agentMode: 'medium',
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello amp' }],
      meta: { sentAt: 1721000001000 },
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi back' }],
      meta: { sentAt: 1721000002000 },
    },
    // system / tool 角色排除
    { role: 'system', content: [{ type: 'text', text: 'sys prompt' }] },
    { role: 'tool', content: [{ type: 'text', text: 'tool result' }] },
    // 非 text 块排除
    { role: 'user', content: [{ type: 'image', text: 'should-skip' }] },
  ],
};

describe('parseAmpExport', () => {
  it('v5 thread JSON：消息 + projectPath + agentMode', () => {
    const parsed = parseAmpExport(AMP_V5_FIXTURE);
    expect(parsed).not.toBeNull();
    expect(parsed!.nativeId).toBe('T-abc123');
    expect(parsed!.startedAt).toBe(1721000000000);
    expect(parsed!.projectPath).toBe('/Users/test/proj');
    expect(parsed!.displayName).toBe('proj');
    expect(parsed!.agentMode).toBe('medium');
    expect(parsed!.messages).toEqual([
      { role: 'user', content: 'hello amp', timestamp: 1721000001000 },
      { role: 'assistant', content: 'hi back', timestamp: 1721000002000 },
    ]);
  });

  it('缺 id → null', () => {
    expect(parseAmpExport({ v: 5, messages: [] })).toBeNull();
  });

  it('content 为字符串时回退提取', () => {
    const parsed = parseAmpExport({
      id: 'T-str',
      messages: [{ role: 'user', content: 'plain string content' }],
    });
    expect(parsed!.messages).toEqual([{ role: 'user', content: 'plain string content' }]);
  });
});

describe('parseAmpThreadLog', () => {
  it('NDJSON：earliest @timestamp + message_added 计数', () => {
    const raw = [
      '{"@timestamp":"2026-07-14T10:00:00.000Z","type":"message_added","role":"user","seq":1}',
      '{"@timestamp":"2026-07-14T10:00:01.000Z","type":"message_added","role":"assistant","seq":2}',
      'not-json-line',
      '{"@timestamp":"2026-07-14T09:59:00.000Z","type":"other_event"}',
    ].join('\n');
    const result = parseAmpThreadLog(raw, 'T-log1');
    expect(result.nativeId).toBe('T-log1');
    expect(result.startedAt).toBe(Date.parse('2026-07-14T09:59:00.000Z'));
    expect(result.messageCount).toBe(2);
  });
});

describe('AmpImporter', () => {
  let tmpConfig: string;
  let tmpCache: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-cfg-'));
    tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-cache-'));
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpConfig, { recursive: true, force: true });
    fs.rmSync(tmpCache, { recursive: true, force: true });
  });

  it('auth 可用：list + export → coverage=B，session 入库', () => {
    const runner: AmpCommandRunner = {
      run(args: string[]) {
        if (args.join(' ') === 'threads list --json') {
          return { stdout: JSON.stringify([{ id: 'T-abc123' }]), status: 0 };
        }
        if (args[0] === 'threads' && args[1] === 'export' && args[2] === 'T-abc123') {
          return { stdout: JSON.stringify(AMP_V5_FIXTURE), status: 0 };
        }
        return { stdout: '', status: 1 };
      },
    };

    const stats: AmpImportStats = new AmpImporter(store, {
      runner,
      deviceId: DEVICE,
      configDir: tmpConfig,
      cacheDir: tmpCache,
    }).import();

    expect(stats.authAvailable).toBe(true);
    expect(stats.coverage).toBe('B');
    expect(stats.threadsSeen).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.source).toBe('amp');
    expect(s.nativeSessionId).toBe('T-abc123');
    expect(s.projectPath).toBe('/Users/test/proj');
    expect(s.entrySource).toBe('cloud');
    expect(s.threadSource).toBe('medium');
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello amp'],
      ['assistant', 'hi back'],
    ]);
  });

  it('auth 失败 + 无日志 → coverage=C，0 sessions', () => {
    const runner: AmpCommandRunner = {
      run: () => ({ stdout: '', status: 1 }),
    };

    const stats = new AmpImporter(store, {
      runner,
      deviceId: DEVICE,
      configDir: tmpConfig,
      cacheDir: tmpCache,
    }).import();

    expect(stats.authAvailable).toBe(false);
    expect(stats.coverage).toBe('C');
    expect(stats.threadsSeen).toBe(0);
    expect(stats.inserted).toBe(0);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  it('auth 失败 + 日志发现 id，但 export 也失败 → skipped', () => {
    // 在 cache 目录造一个 thread 日志文件
    const logsDir = path.join(tmpCache, 'logs', 'threads');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'T-fromlog.log'), '', 'utf8');

    const runner: AmpCommandRunner = {
      run: () => ({ stdout: '', status: 1 }),
    };

    const stats = new AmpImporter(store, {
      runner,
      deviceId: DEVICE,
      configDir: tmpConfig,
      cacheDir: tmpCache,
    }).import();

    expect(stats.authAvailable).toBe(false);
    expect(stats.coverage).toBe('C');
    expect(stats.threadsSeen).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  it('空消息 thread 跳过（export 返回无消息的 thread）', () => {
    const runner: AmpCommandRunner = {
      run(args: string[]) {
        if (args.join(' ') === 'threads list --json') {
          return { stdout: JSON.stringify([{ id: 'T-empty' }]), status: 0 };
        }
        if (args[0] === 'threads' && args[1] === 'export' && args[2] === 'T-empty') {
          return {
            stdout: JSON.stringify({ id: 'T-empty', v: 5, messages: [] }),
            status: 0,
          };
        }
        return { stdout: '', status: 1 };
      },
    };

    const stats = new AmpImporter(store, {
      runner,
      deviceId: DEVICE,
      configDir: tmpConfig,
      cacheDir: tmpCache,
    }).import();

    expect(stats.authAvailable).toBe(true);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  it('AMP_AUTH_HELPER 包含登录提示', () => {
    expect(AMP_AUTH_HELPER.loginCommand).toBe('amp login');
    expect(AMP_AUTH_HELPER.hint).toContain('amp login');
  });
});
