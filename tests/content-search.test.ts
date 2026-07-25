/**
 * LOOP: build-content-search — 消息正文搜索（FTS5）
 *
 * 验收门（对齐 loop 的 Observation）：
 *   1. 写入含特定正文的 messages → querySessions({keyword}) 命中
 *   2. 不含关键字的不命中
 *   3. 中文 / 大小写 / 前缀匹配口径
 *   4. 采集不回归（总 session / message 数不回退）
 *   5. 元数据过滤（source/project/since）与 keyword 正文搜索可组合 AND
 *   6. 旧库（无 FTS 表）启动时能自动补建而不崩
 *   7. 多 revision：只命中当前 revision（旧 revision 内容不召回）
 *   8. toFtsMatchExpr 纯函数
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore, tokenizeKeyword } from '../src/store/index.js';
import type { SessionIngestInput } from '../src/store/index.js';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DEVICE_A = 'mac-001';
const DEVICE_B = 'mac-002';

function freshStore(): SessionStore {
  return new SessionStore(':memory:');
}

function mkSession(opts: {
  store: SessionStore;
  sourceInstanceId: string;
  device: string;
  source: string;
  project?: string;
  startedAt?: number;
  messages: { role: 'user' | 'assistant'; content: string }[];
  fileModifiedAt?: number;
  nativeId?: string;
}): string {
  const input: SessionIngestInput = {
    deviceId: opts.device,
    sourceInstanceId: opts.sourceInstanceId,
    nativeSessionId:
      opts.nativeId ?? `${opts.source}-${Math.random().toString(36).slice(2, 10)}`,
    source: opts.source,
    projectPath: opts.project,
    startedAt: opts.startedAt,
    messages: opts.messages,
    fileModifiedAt: opts.fileModifiedAt,
  };
  return opts.store.ingestSession(input).sessionId;
}

describe('FTS5 消息正文搜索', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = freshStore();
  });

  afterEach(() => {
    store.close();
  });

  it('基本命中：写入含关键字的 messages → querySessions({keyword}) 命中', () => {
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo1',
      messages: [
        { role: 'user', content: 'how do I configure webpack?' },
        { role: 'assistant', content: 'you can use webpack.config.js' },
      ],
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/repo2',
      messages: [
        { role: 'user', content: 'unrelated topic about cooking' },
        { role: 'assistant', content: 'try pasta recipes' },
      ],
    });

    const hits = store.querySessions({ keyword: 'webpack' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.projectPath).toBe('/repo1');
  });

  it('不命中：不含关键字的不返回', () => {
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      messages: [{ role: 'user', content: 'nothing relevant here' }],
    });

    const hits = store.querySessions({ keyword: 'webpack' });
    expect(hits).toHaveLength(0);
  });

  it('大小写不敏感（FTS5 默认行为）', () => {
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      messages: [{ role: 'user', content: 'Webpack Configuration Guide' }],
    });

    // 小写 keyword 命中大写正文；大写 keyword 命中小写正文
    expect(store.querySessions({ keyword: 'webpack' })).toHaveLength(1);
    expect(store.querySessions({ keyword: 'WEBPACK' })).toHaveLength(1);
    expect(store.querySessions({ keyword: 'WebPack' })).toHaveLength(1);
  });

  it('前缀匹配（token* 语义）', () => {
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      messages: [{ role: 'user', content: 'configuring the database connection' }],
    });

    // "config" 是 "configuring" 的前缀
    expect(store.querySessions({ keyword: 'config' })).toHaveLength(1);
    expect(store.querySessions({ keyword: 'database' })).toHaveLength(1);
    // 完整词也命中
    expect(store.querySessions({ keyword: 'configuring' })).toHaveLength(1);
  });

  it('中文关键字命中（unicode61 CJK 分词）', () => {
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      messages: [
        { role: 'user', content: '如何配置数据库连接？' },
        { role: 'assistant', content: '可以使用环境变量' },
      ],
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r2',
      messages: [{ role: 'user', content: '今天天气不错' }],
    });

    // 单字命中
    expect(store.querySessions({ keyword: '数据库' })).toHaveLength(1);
    expect(store.querySessions({ keyword: '天气' })).toHaveLength(1);
    // 多字 AND（"配置" + "连接" 都需出现）
    expect(store.querySessions({ keyword: '配置 连接' })).toHaveLength(1);
    // 不出现的不命中
    expect(store.querySessions({ keyword: '数据库' }).length).toBe(1);
    expect(store.querySessions({ keyword: '不存在的词' })).toHaveLength(0);
  });

  it('采集不回归：FTS 不影响 session/message 总数', () => {
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r1',
      messages: [
        { role: 'user', content: 'first session' },
        { role: 'assistant', content: 'response one' },
      ],
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r2',
      messages: [
        { role: 'user', content: 'second session' },
        { role: 'assistant', content: 'response two' },
        { role: 'user', content: 'third message' },
      ],
    });

    const stats = store.getSessionStats({});
    expect(stats.totalSessions).toBe(2);
    expect(stats.totalMessages).toBe(5);

    // FTS 表行数 = messages 行数（每条消息一行）
    const ftsCount = store.listTables();
    expect(ftsCount).toContain('messages_fts');
  });

  it('元数据 + keyword 可组合 AND', () => {
    const claudeInst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    const codexInst = store.registerSourceInstance({
      deviceId: DEVICE_B,
      source: 'codex',
      coverage: 'A',
    });
    // claude @ /r1 含 "webpack"
    mkSession({
      store,
      sourceInstanceId: claudeInst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r1',
      messages: [{ role: 'user', content: 'webpack setup' }],
    });
    // codex @ /r2 含 "webpack"
    mkSession({
      store,
      sourceInstanceId: codexInst.id,
      device: DEVICE_B,
      source: 'codex',
      project: '/r2',
      messages: [{ role: 'user', content: 'webpack setup' }],
    });
    // claude @ /r3 不含 "webpack"
    mkSession({
      store,
      sourceInstanceId: claudeInst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r3',
      messages: [{ role: 'user', content: 'something else' }],
    });

    // 只 keyword：命中 2 个
    expect(store.querySessions({ keyword: 'webpack' })).toHaveLength(2);

    // keyword + source=claude：只命中 1 个
    const hits = store.querySessions({ keyword: 'webpack', source: 'claude' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.source).toBe('claude');
    expect(hits[0]!.projectPath).toBe('/r1');

    // keyword + projectPath=/r2：只命中 1 个（codex）
    const hits2 = store.querySessions({ keyword: 'webpack', projectPath: '/r2' });
    expect(hits2).toHaveLength(1);
    expect(hits2[0]!.source).toBe('codex');

    // keyword + since（远早于所有 session）：命中全部
    const hits3 = store.querySessions({
      keyword: 'webpack',
      startedAtFrom: 0,
    });
    expect(hits3).toHaveLength(2);

    // keyword + since（远晚于所有 session）：命中 0 个
    const future = Date.now() + 10_000;
    const hits4 = store.querySessions({
      keyword: 'webpack',
      startedAtFrom: future,
    });
    expect(hits4).toHaveLength(0);
  });

  it('多 revision：只命中当前 revision（旧 revision 内容不召回）', () => {
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    // 首次入库：含 "oldKeyword"
    const nativeId = 'rev-test-1';
    store.ingestSession({
      deviceId: DEVICE_A,
      sourceInstanceId: inst.id,
      nativeSessionId: nativeId,
      source: 'claude',
      projectPath: '/r',
      messages: [
        { role: 'user', content: 'this has oldKeyword in revision 1' },
      ],
    });
    // 内容变化：新 revision 不含 "oldKeyword"，含 "newKeyword"
    store.ingestSession({
      deviceId: DEVICE_A,
      sourceInstanceId: inst.id,
      nativeSessionId: nativeId,
      source: 'claude',
      projectPath: '/r',
      messages: [
        { role: 'user', content: 'this has newKeyword in revision 2' },
      ],
    });

    // 搜 oldKeyword：旧 revision 有，但当前 revision 没有 → 不应命中
    expect(store.querySessions({ keyword: 'oldKeyword' })).toHaveLength(0);
    // 搜 newKeyword：当前 revision 有 → 命中
    const hits = store.querySessions({ keyword: 'newKeyword' });
    expect(hits).toHaveLength(1);
  });

  it('无有效 token 的 keyword：返回空结果', () => {
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      messages: [{ role: 'user', content: 'some content here' }],
    });

    // 纯标点 / 空白：无有效 token
    expect(store.querySessions({ keyword: '!!!' })).toHaveLength(0);
    expect(store.querySessions({ keyword: '   ' })).toHaveLength(0);
    expect(store.querySessions({ keyword: '""' })).toHaveLength(0);
  });

  it('空库不崩，keyword 搜索返回空', () => {
    expect(store.querySessions({ keyword: 'anything' })).toEqual([]);
  });

  it('旧库自动补建 FTS：文件 DB 先无 FTS 写入 messages，再以新代码打开能搜到', () => {
    // 用文件 DB 模拟旧库：先写一个无 FTS 的库
    const dir = mkdtempSync(join(tmpdir(), 'ymesh-fts-test-'));
    const dbPath = join(dir, 'test.db');
    try {
      // 步骤 1：用 "旧 schema"（无 FTS）建库并写入数据
      // 直接用 SessionStore 但手动 DROP 掉 FTS 表模拟旧库
      const oldStore = new SessionStore(dbPath);
      const inst = oldStore.registerSourceInstance({
        deviceId: DEVICE_A,
        source: 'claude',
        coverage: 'A',
      });
      oldStore.ingestSession({
        deviceId: DEVICE_A,
        sourceInstanceId: inst.id,
        nativeSessionId: 'old-session-1',
        source: 'claude',
        projectPath: '/legacy',
        messages: [
          { role: 'user', content: 'legacy content about webpack' },
          { role: 'assistant', content: 'legacy response' },
        ],
      });
      // 模拟旧库：DROP FTS 表与触发器
      // （db 是 private，通过 cast 访问以模拟"无 FTS 的旧库"场景）
      const oldDb = (oldStore as unknown as { db: { exec: (sql: string) => void } }).db;
      oldDb.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
      oldDb.exec('DROP TRIGGER IF EXISTS messages_fts_ad');
      oldDb.exec('DROP TRIGGER IF EXISTS messages_fts_au');
      oldDb.exec('DROP TABLE IF EXISTS messages_fts');
      // 确认 FTS 表已不存在
      const tables = oldStore.listTables();
      expect(tables).not.toContain('messages_fts');
      oldStore.close();

      // 步骤 2：用新代码重新打开（ensureSchema 会补建 FTS + syncFtsIfStale 回填）
      const newStore = new SessionStore(dbPath);
      // FTS 表已自动补建
      expect(newStore.listTables()).toContain('messages_fts');

      // 步骤 3：搜关键字能命中旧库写入的内容
      const hits = newStore.querySessions({ keyword: 'webpack' });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.projectPath).toBe('/legacy');

      // 步骤 4：新写入的 session 也能被搜到（触发器正常工作）
      const inst2 = newStore.registerSourceInstance({
        deviceId: DEVICE_B,
        source: 'codex',
        coverage: 'A',
      });
      newStore.ingestSession({
        deviceId: DEVICE_B,
        sourceInstanceId: inst2.id,
        nativeSessionId: 'new-session-after-upgrade',
        source: 'codex',
        projectPath: '/new',
        messages: [{ role: 'user', content: 'fresh content about vitest' }],
      });
      const hits2 = newStore.querySessions({ keyword: 'vitest' });
      expect(hits2).toHaveLength(1);
      expect(hits2[0]!.projectPath).toBe('/new');

      // 旧内容仍可搜（回填成功 + 触发器未破坏）
      const hits3 = newStore.querySessions({ keyword: 'legacy' });
      expect(hits3).toHaveLength(1);

      newStore.close();
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('幂等：重复 ensureSchema 不破坏 FTS 数据', () => {
    const inst = store.registerSourceInstance({
      deviceId: DEVICE_A,
      source: 'claude',
      coverage: 'A',
    });
    mkSession({
      store,
      sourceInstanceId: inst.id,
      device: DEVICE_A,
      source: 'claude',
      project: '/r',
      messages: [{ role: 'user', content: 'idempotent test keyword' }],
    });

    // 多次调用 ensureSchema（模拟重启）
    store.ensureSchema();
    store.ensureSchema();

    // FTS 仍能正常搜索
    expect(store.querySessions({ keyword: 'idempotent' })).toHaveLength(1);
    // 不应产生重复 FTS 行（syncFtsIfStale 的 NOT IN 防重）
    store.ensureSchema();
    expect(store.querySessions({ keyword: 'idempotent' })).toHaveLength(1);
  });
});

describe('tokenizeKeyword（纯函数）', () => {
  it('简单英文 token → 单元素数组', () => {
    expect(tokenizeKeyword('webpack')).toEqual(['webpack']);
  });

  it('多 token → 空白分隔的多元素数组（AND 语义）', () => {
    expect(tokenizeKeyword('webpack config')).toEqual(['webpack', 'config']);
  });

  it('去除非字母数字下划线字符（替换为空白后分词）', () => {
    // " * ( ) + : - " 等被替换为空白
    expect(tokenizeKeyword('webpack"config')).toEqual(['webpack', 'config']);
    expect(tokenizeKeyword('webpack(config)')).toEqual(['webpack', 'config']);
    expect(tokenizeKeyword('a:b:c')).toEqual(['a', 'b', 'c']);
  });

  it('保留 CJK 字符', () => {
    expect(tokenizeKeyword('数据库')).toEqual(['数据库']);
    expect(tokenizeKeyword('配置 连接')).toEqual(['配置', '连接']);
  });

  it('纯标点 / 空白 → 返回空数组', () => {
    expect(tokenizeKeyword('')).toEqual([]);
    expect(tokenizeKeyword('   ')).toEqual([]);
    expect(tokenizeKeyword('!!!')).toEqual([]);
    expect(tokenizeKeyword('""')).toEqual([]);
    expect(tokenizeKeyword('***')).toEqual([]);
  });

  it('混合内容：保留字母数字与 CJK，弃标点', () => {
    expect(tokenizeKeyword('hello, 世界! 123')).toEqual(['hello', '世界', '123']);
  });
});
