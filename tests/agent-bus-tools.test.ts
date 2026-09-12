/**
 * 4 个职能工具测试：observe / orchestrate / workspace（message 在 agent-message.test.ts）
 *
 * 覆盖收敛后的关键语义：
 *   1. observe 的 filter 是「查询的一部分」（角色/长度/关键词/时间）
 *   2. observe 的 scope 各自能拿到东西，且不炸
 *   3. observe tree 对「多个上级」如实呈现，不假装唯一父
 *   4. workspace 的增删改查 + status 只认目录边界（/a/bc 不命中 /a/b）
 *   5. orchestrate 的 prior / await / stop / 异构 discuss 警告
 *   6. situation 情境包：不出错、带上自己位置
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionStore } from '../src/store/index.js';
import { MailboxCore } from '../src/mailbox/core.js';
import { observe, parseWhen, messageMatches, pickFilter } from '../src/mcp/observe.js';
import { orchestrate } from '../src/mcp/orchestrate.js';
import { workspace } from '../src/mcp/workspace.js';
import { buildSituation } from '../src/mcp/situation.js';

const DEVICE = 'agent-bus-test';

function makeEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ymesh-bus-'));
  const dbPath = join(dataDir, 'test.db');
  const store = new SessionStore(dbPath);
  const core = new MailboxCore(dbPath, dataDir);
  const inst = store.registerSourceInstance({
    deviceId: DEVICE,
    source: 'claude',
    rootPath: '/fake/.claude',
    coverage: 'A',
  });

  const addSession = (
    nativeId: string,
    cwd: string,
    msgs: Array<{ role: string; content: string }>,
  ): string => {
    store.ingestSession({
      deviceId: DEVICE,
      sourceInstanceId: inst.id,
      nativeSessionId: nativeId,
      source: 'claude',
      cwd,
      projectPath: cwd,
      startedAt: Date.now() - 60_000,
      lastSeenAt: Date.now(),
      fileModifiedAt: Date.now(),
      messages: msgs.map((m, i) => ({ ...m, timestamp: Date.now() - 1000 + i })),
    } as never);
    return store.querySessions({ source: 'claude' } as never).find(
      (s) => s.nativeSessionId === nativeId,
    )!.id;
  };

  return {
    store,
    core,
    addSession,
    cleanup: () => {
      core.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const LONG = '这是一段足够长的需求描述'.repeat(20); // 240 字，>200

describe('observe 1. filter 是查询的一部分', () => {
  it('parseWhen 支持 7d / 24h / 30m / ISO', () => {
    const d = parseWhen('7d')!;
    expect(Date.now() - d).toBeGreaterThan(6.9 * 86400_000);
    expect(parseWhen('30m')).toBeDefined();
    expect(parseWhen('2020-01-01T00:00:00Z')).toBe(Date.parse('2020-01-01T00:00:00Z'));
    expect(parseWhen(undefined)).toBeUndefined();
  });

  it('messageMatches：角色 / 长度 / 关键词', () => {
    const now = Date.now();
    expect(messageMatches('user', 'hi', { roles: ['user'] }, now)).toBe(true);
    expect(messageMatches('tool', 'hi', { roles: ['user'] }, now)).toBe(false);
    expect(messageMatches('tool', 'hi', { exclude: ['tool'] }, now)).toBe(false);
    expect(messageMatches('user', '短', { minLength: 100 }, now)).toBe(false);
    expect(messageMatches('user', LONG, { minLength: 100 }, now)).toBe(true);
    expect(messageMatches('user', 'Hello World', { keyword: 'hello' }, now)).toBe(true);
  });

  it('pickFilter 从工具参数里挑出 filter（有就返回，没有就 undefined）', () => {
    expect(pickFilter({})).toBeUndefined();
    const f = pickFilter({ roles: ['user'], min_length: 200, keyword: 'x' });
    expect(f).toEqual({ roles: ['user'], minLength: 200, keyword: 'x' });
  });
});

describe('observe 2. scope 各自可用', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => env.cleanup());

  it('scope=project，只要长需求 → 命中数按 filter 收紧', async () => {
    env.addSession('s1', '/proj/a', [
      { role: 'user', content: '短需求' },
      { role: 'user', content: LONG },
      { role: 'assistant', content: LONG },
      { role: 'tool', content: 'tool noise' },
    ]);

    const all = await observe({ store: env.store }, { scope: 'project', target: '/proj/a', shape: 'list' });
    const filtered = await observe(
      { store: env.store },
      { scope: 'project', target: '/proj/a', shape: 'list', filter: { roles: ['user'], minLength: 200 } },
    );
    expect(all.ok).toBe(true);
    expect(filtered.ok).toBe(true);
    // 筛完只剩 1 条（长的那条 user），但会话数不变
    expect(all.text).toContain('4 条');
    expect(filtered.text).toContain('1 条');
    expect(filtered.text).toContain('筛选：只要角色 user · ≥200 字');
  });

  it('scope=session，roles 白名单把工具链排掉', async () => {
    const id = env.addSession('s2', '/proj/b', [
      { role: 'user', content: '需求' },
      { role: 'tool', content: '工具调用' },
      { role: 'assistant', content: '回复' },
    ]);
    const r = await observe(
      { store: env.store },
      { scope: 'session', target: id, shape: 'detail', filter: { roles: ['user', 'assistant'] } },
    );
    expect(r.text).toContain('命中 2 条');
    expect(r.text).not.toContain('工具调用');
  });

  it('scope=global / active 都能出东西', async () => {
    env.addSession('s3', '/proj/c', [{ role: 'user', content: 'x' }]);
    const g = await observe({ store: env.store }, { scope: 'global' });
    const a = await observe({ store: env.store }, { scope: 'active' });
    expect(g.ok).toBe(true);
    expect(g.text).toContain('本机会话总览');
    expect(a.ok).toBe(true);
  });
});

describe('observe 3. tree 方向正确 + 上下级渲染', () => {
  // 方向约定（实测确认）：spawned_by = from(**子**) → to(**父**)。
  // 之前我把方向读反了，导致「3 个下属」被渲染成「3 个上级」。
  it('子会话能查到父，父会话能查到子（方向不反）', async () => {
    const env = makeEnv();
    try {
      const parent = env.addSession('parent-native', '/proj/t', [{ role: 'user', content: 'x' }]);
      const c1 = env.addSession('c1-native', '/proj/t', [{ role: 'user', content: 'y' }]);
      const c2 = env.addSession('c2-native', '/proj/t', [{ role: 'user', content: 'z' }]);
      for (const c of [c1, c2]) {
        // 子 → 父
        env.store.addRelationship({ fromSessionId: c, toSessionId: parent, relationType: 'spawned_by' });
      }

      const asParent = await observe({ store: env.store }, { scope: 'tree', target: parent });
      expect(asParent.text).toContain('起了 2 个下属');
      expect(asParent.text).toContain('无上级（这是个 root）'); // 父自己不挂在上层
      expect(asParent.text).not.toContain('个上层');

      const asChild = await observe({ store: env.store }, { scope: 'tree', target: c1 });
      expect(asChild.text).toContain('由');
      expect(asChild.text).toContain('发起');
      expect(asChild.text).toContain('没有下属');
    } finally {
      env.cleanup();
    }
  });

  it('挂在多个上层之下时（嵌套子代理）如实列出', async () => {
    const env = makeEnv();
    try {
      const child = env.addSession('child', '/proj/t', [{ role: 'user', content: 'x' }]);
      for (const p of ['p1-native', 'p2-native', 'p3-native']) {
        const pid = env.addSession(p, '/proj/t', [{ role: 'user', content: 'y' }]);
        // 子 → 父
        env.store.addRelationship({ fromSessionId: child, toSessionId: pid, relationType: 'spawned_by' });
      }
      const r = await observe({ store: env.store }, { scope: 'tree', target: child });
      expect(r.text).toContain('3 个上层');
    } finally {
      env.cleanup();
    }
  });

  it('没有上级时说「这是个 root」', async () => {
    const env = makeEnv();
    try {
      const id = env.addSession('solo', '/proj/s', [{ role: 'user', content: 'x' }]);
      const r = await observe({ store: env.store }, { scope: 'tree', target: id });
      expect(r.text).toContain('无上级');
    } finally {
      env.cleanup();
    }
  });
});

describe('workspace 4. 增删改查 + 目录边界', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => env.cleanup());

  it('add → list → update → remove', () => {
    expect(workspace(env.store, { action: 'list' }).text).toContain('还没有标记');
    const add = workspace(env.store, {
      action: 'add',
      path: '/Users/x/Obsidian Vault',
      label: '笔记库',
      group: '个人',
    });
    expect(add.ok).toBe(true);
    expect(add.text).toContain('已标记');

    const list = workspace(env.store, { action: 'list' });
    expect(list.text).toContain('笔记库');
    expect(list.text).toContain('【个人】');

    workspace(env.store, { action: 'update', path: '/Users/x/Obsidian Vault', note: '管 3 个项目' });
    expect(workspace(env.store, { action: 'list' }).text).toContain('管 3 个项目');

    expect(workspace(env.store, { action: 'remove', path: '/Users/x/Obsidian Vault' }).ok).toBe(true);
    expect(workspace(env.store, { action: 'list' }).text).toContain('还没有标记');
  });

  it('拒绝相对路径（避免标记出乱七八糟的 key）', () => {
    const r = workspace(env.store, { action: 'add', path: 'relative/path', label: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not absolute');
  });

  it('status：只统计在标记目录**之下**的会话（/a/bc 不该命中 /a/b）', () => {
    env.addSession('in', '/Users/x/proj', [{ role: 'user', content: 'x' }]);
    env.addSession('out', '/Users/x/proj-sibling', [{ role: 'user', content: 'y' }]);
    workspace(env.store, { action: 'add', path: '/Users/x/proj', label: '真正的项目' });

    const r = workspace(env.store, { action: 'status' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('真正的项目');
    expect(r.text).toContain('1 个会话在跑');
    // 兄弟目录 /Users/x/proj-sibling 不能被算进 /Users/x/proj
    const marked = (r.data as Array<{ sessions: unknown[] }>)[0];
    expect(marked.sessions).toHaveLength(1);
  });

  it('status 会提示未标记但活跃的目录', () => {
    env.addSession('u1', '/Users/x/unmarked', [{ role: 'user', content: 'x' }]);
    const r = workspace(env.store, { action: 'status' });
    expect(r.text).toContain('未标记但活跃的目录');
    expect(r.text).toContain('/Users/x/unmarked');
  });
});

describe('orchestrate 5. 各 action', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => env.cleanup());

  it('stop 明确说「不支持」，不假装成功', async () => {
    const id = env.addSession('s', '/p', [{ role: 'user', content: 'x' }]);
    const r = await orchestrate({ store: env.store, core: env.core }, { action: 'stop', target: id });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('不持有');
    expect(r.hint).toContain('句柄池');
  });

  it('await：报告还在跑还是已停', async () => {
    const id = env.addSession('s', '/p', [{ role: 'user', content: '需求' }, { role: 'assistant', content: '回复' }]);
    const r = await orchestrate({ store: env.store, core: env.core }, { action: 'await', target: id });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('还在跑');
    expect(r.text).toContain('回复');
  });

  it('prior：没找到时明确说「可能是新问题」', async () => {
    env.addSession('s', '/p', [{ role: 'user', content: '无关内容' }]);
    const r = await orchestrate(
      { store: env.store, core: env.core },
      { action: 'prior', query: 'zzzzz-完全不可能命中的词' },
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain('新问题');
  });

  it('discuss：少于 2 个参与方直接拒绝', async () => {
    const r = await orchestrate(
      { store: env.store, core: env.core },
      { action: 'discuss', to: ['a'], brief: 'x' },
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain('至少需要 2 个');
  });

  it('spawn：没给 cli 时明确提示要 cli + cwd', async () => {
    const r = await orchestrate(
      { store: env.store, core: env.core },
      { action: 'spawn', brief: '干活' },
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain('config.cli');
    expect(r.hint).toContain('cwd');
  });

  it('handoff：找不到会话时给明确错误', async () => {
    const r = await orchestrate(
      { store: env.store, core: env.core },
      { action: 'handoff', target: '不存在' },
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain('找不到会话');
  });
});

describe('situation 6. 情境包', () => {
  it('无 selfId 时只给全局，不炸', () => {
    const env = makeEnv();
    try {
      env.addSession('s', '/p', [{ role: 'user', content: 'x' }]);
      const sit = buildSituation(env.store, null);
      expect(sit.present).toBeGreaterThan(0);
      expect(sit.text).toContain('现状');
      expect(sit.me).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it('有 selfId 时带上「你的位置」与「同项目还有谁」', () => {
    const env = makeEnv();
    try {
      const me = env.addSession('me', '/proj/shared', [{ role: 'user', content: 'x' }]);
      env.addSession('peer', '/proj/shared', [{ role: 'user', content: 'y' }]);
      const sit = buildSituation(env.store, me);
      expect(sit.me?.sessionId).toBe(me);
      expect(sit.text).toContain('你：claude');
      expect(sit.text).toContain('同项目还有');
    } finally {
      env.cleanup();
    }
  });

  it('topology 与关系表冲突时如实标明，不自相矛盾', () => {
    const env = makeEnv();
    try {
      const p = env.addSession('parent', '/proj/x', [{ role: 'user', content: 'x' }]);
      const c = env.addSession('child', '/proj/x', [{ role: 'user', content: 'y' }]);
      // 方向：子(c) → 父(p)
      env.store.addRelationship({ fromSessionId: c, toSessionId: p, relationType: 'spawned_by' });
      const sit = buildSituation(env.store, c);
      // c 的 topology 是 root 但有父 → 必须标出不一致
      expect(sit.text).toContain('不一致');
    } finally {
      env.cleanup();
    }
  });
});
