/**
 * OpenHands 原生 adapter 契约测试
 *
 * 覆盖验收门：
 *   1. 导入根 conversation：coverage=A，native id=conv_id，可显示消息入库
 *   2. 重复扫描幂等：不新增 revision
 *   3. 内容变更（追加事件文件）生成新 revision
 *   4. 脏事件文件跳过，合法文件仍解析
 *   5. 无有效消息的 conversation 跳过并计数
 *   6. 排除非 event-*.json 文件
 *   7. 内部事件（environment/observation/thinking）排除
 *   8. workspace 不存在时抛出明确错误
 *
 * fixture：在临时目录构建 conversations/<conv_id>/events/event-*.json 结构。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { OpenHandsImporter, resolveOpenHandsWorkspace } from '../src/openhands/index.js';
import type { OpenHandsImportStats } from '../src/openhands/index.js';

const DEVICE = 'mac-test';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

type EventObj = Record<string, unknown>;

interface EventOpts {
  source?: string;
  type?: string;
  content?: string | Array<{ type: string; text?: string }>;
  timestamp?: string;
  workspace?: string;
  modelName?: string;
  apiVersion?: string;
}

/** 构造一个事件对象 */
function event(o: EventOpts = {}): EventObj {
  const msg = o.content !== undefined ? { content: o.content } : undefined;
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: o.timestamp ?? '2026-07-15T10:00:00.000Z',
    source: o.source ?? 'user',
    type: o.type ?? 'MessageAction',
    ...(o.workspace ? { workspace: o.workspace } : {}),
    ...(o.modelName ? { llm_metadata: { model_name: o.modelName } } : {}),
    ...(o.apiVersion ? { api_version: o.apiVersion } : {}),
    ...(msg ? { message: msg } : {}),
  };
}

/** 写一个 conversation 的 events */
function writeEvents(
  workspacePath: string,
  convId: string,
  events: EventObj[],
  filenames?: string[],
): string {
  const dir = path.join(workspacePath, 'conversations', convId, 'events');
  fs.mkdirSync(dir, { recursive: true });
  const names = filenames ?? events.map((_, i) => `event-${String(i).padStart(4, '0')}.json`);
  events.forEach((e, i) => {
    fs.writeFileSync(path.join(dir, names[i] ?? `event-${i}.json`), JSON.stringify(e), 'utf8');
  });
  return dir;
}

const CONV_ID = 'conv-aaa-111';
const CWD = '/Users/zoran/Documents/projects/yondermesh';

/** 典型 conversation：user + agent + 内部事件 */
function typicalEvents(convId: string): EventObj[] {
  return [
    event({ source: 'user', content: 'hello openhands', timestamp: '2026-07-15T10:00:00.000Z', workspace: CWD, modelName: 'anthropic/glm-5.2', apiVersion: '0.1.0' }),
    // 内部事件（environment observation，排除）
    event({ source: 'environment', type: 'ObservationAction', content: 'cmd output', timestamp: '2026-07-15T10:00:30.000Z' }),
    // agent 含 thinking 块 + text 块（只取 text）
    event({
      source: 'agent',
      type: 'MessageAction',
      timestamp: '2026-07-15T10:01:00.000Z',
      content: [
        { type: 'thinking', text: 'secret reasoning' },
        { type: 'text', text: 'hi from agent' },
      ],
    }),
  ];
}

// ─── 测试体 ──────────────────────────────────────────────────────────────────

describe('OpenHands 原生 adapter', () => {
  let tmpWorkspace: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openhands-oh-'));
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  // ── 验收门 1：导入根 conversation ──────────────────────────────────────

  it('导入 conversation：coverage=A，native id=conv_id，可显示消息入库，内部事件排除', () => {
    writeEvents(tmpWorkspace, CONV_ID, typicalEvents(CONV_ID));

    const stats: OpenHandsImportStats = new OpenHandsImporter(store, {
      workspacePath: tmpWorkspace,
      deviceId: DEVICE,
    }).import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0);

    // source instance：coverage=A
    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst).toBeDefined();
    expect(inst!.source).toBe('openhands');
    expect(inst!.coverage).toBe('A');
    expect(inst!.rootPath).toBe(tmpWorkspace);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.topology).toBe('root');
    expect(s.nativeSessionId).toBe(CONV_ID);
    expect(s.source).toBe('openhands');
    expect(s.cwd).toBe(CWD);
    expect(s.model).toBe('anthropic/glm-5.2');
    expect(s.cliVersion).toBe('0.1.0');
    expect(s.startedAt).toBe(Date.parse('2026-07-15T10:00:00.000Z'));

    // 消息：只 user + agent text；environment/observation/thinking 排除
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello openhands'],
      ['assistant', 'hi from agent'],
    ]);
  });

  // ── 验收门 2：重复扫描幂等 ─────────────────────────────────────────────

  it('相同内容重复扫描幂等：不新增 revision，计入 unchanged', () => {
    writeEvents(tmpWorkspace, CONV_ID, typicalEvents(CONV_ID));

    const importer = new OpenHandsImporter(store, { workspacePath: tmpWorkspace, deviceId: DEVICE });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    const second = importer.import();
    expect(second.scanned).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getRevisions(s.id)).toHaveLength(1);
  });

  // ── 验收门 3：内容变更生成新 revision ──────────────────────────────────

  it('内容变更（追加事件文件）生成新 revision', () => {
    const dir = writeEvents(tmpWorkspace, CONV_ID, typicalEvents(CONV_ID));
    const importer = new OpenHandsImporter(store, { workspacePath: tmpWorkspace, deviceId: DEVICE });
    importer.import();

    // 追加一个新 agent 事件
    fs.writeFileSync(
      path.join(dir, 'event-0100.json'),
      JSON.stringify(event({ source: 'agent', type: 'MessageAction', content: 'follow up reply', timestamp: '2026-07-15T10:05:00.000Z' })),
      'utf8',
    );

    const second = importer.import();
    expect(second.updated).toBe(1);

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    const revs = store.getRevisions(s.id);
    expect(revs.map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(store.getMessages(s.id)).toHaveLength(3);
  });

  // ── 验收门 4：脏事件文件跳过 ───────────────────────────────────────────

  it('脏事件文件跳过，合法文件仍解析', () => {
    const dir = path.join(tmpWorkspace, 'conversations', CONV_ID, 'events');
    fs.mkdirSync(dir, { recursive: true });
    const events = typicalEvents(CONV_ID);
    fs.writeFileSync(path.join(dir, 'event-0000.json'), JSON.stringify(events[0]), 'utf8');
    fs.writeFileSync(path.join(dir, 'event-0001.json'), '{ this is not valid json !!!', 'utf8');
    fs.writeFileSync(path.join(dir, 'event-0002.json'), JSON.stringify(events[2]), 'utf8');

    const stats = new OpenHandsImporter(store, { workspacePath: tmpWorkspace, deviceId: DEVICE }).import();

    expect(stats.inserted).toBe(1);
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getMessages(s.id).map((m) => m.content)).toEqual([
      'hello openhands',
      'hi from agent',
    ]);
  });

  // ── 验收门 5：无有效消息 → 跳过并计数 ──────────────────────────────────

  it('无有效消息的 conversation 跳过并计数', () => {
    writeEvents(tmpWorkspace, CONV_ID, [
      event({ source: 'environment', type: 'ObservationAction', content: 'no user/agent' }),
    ]);

    const stats = new OpenHandsImporter(store, { workspacePath: tmpWorkspace, deviceId: DEVICE }).import();
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 验收门 6：排除非 event-*.json 文件 ─────────────────────────────────

  it('排除非 event-*.json 文件', () => {
    const dir = path.join(tmpWorkspace, 'conversations', CONV_ID, 'events');
    fs.mkdirSync(dir, { recursive: true });
    const events = typicalEvents(CONV_ID);
    fs.writeFileSync(path.join(dir, 'event-0000.json'), JSON.stringify(events[0]), 'utf8');
    fs.writeFileSync(path.join(dir, 'event-0002.json'), JSON.stringify(events[2]), 'utf8');
    // 非 event- 前缀
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ foo: 'bar' }), 'utf8');
    // 非 .json
    fs.writeFileSync(path.join(dir, 'event-0001.txt'), 'text', 'utf8');

    const stats = new OpenHandsImporter(store, { workspacePath: tmpWorkspace, deviceId: DEVICE }).import();
    expect(stats.inserted).toBe(1);
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getMessages(s.id)).toHaveLength(2);
  });

  // ── 验收门 7：内部事件（thinking 块）排除 ──────────────────────────────

  it('agent 消息只取 text 块，thinking 块排除', () => {
    writeEvents(tmpWorkspace, CONV_ID, [
      event({ source: 'user', content: 'q' }),
      event({
        source: 'agent',
        content: [
          { type: 'thinking', text: 'internal reasoning' },
          { type: 'text', text: 'visible answer' },
          { type: 'text', text: 'second part' },
        ],
      }),
    ]);

    new OpenHandsImporter(store, { workspacePath: tmpWorkspace, deviceId: DEVICE }).import();
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getMessages(s.id).map((m) => [m.role, m.content])).toEqual([
      ['user', 'q'],
      ['assistant', 'visible answer\nsecond part'],
    ]);
  });

  // ── 验收门 8：workspace 不存在 ─────────────────────────────────────────

  it('workspace 不存在时抛出明确错误，不遗留 running 的 scan_run', () => {
    const importer = new OpenHandsImporter(store, {
      workspacePath: path.join(tmpWorkspace, 'does-not-exist'),
      deviceId: DEVICE,
    });
    expect(() => importer.import()).toThrowError(/openhands|conversations|目录|read/i);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 多 conversation 扫描 ────────────────────────────────────────────────

  it('扫描多个 conversation 目录', () => {
    writeEvents(tmpWorkspace, 'conv-a', [event({ source: 'user', content: 'a' }), event({ source: 'agent', content: 'reply a' })]);
    writeEvents(tmpWorkspace, 'conv-b', [event({ source: 'user', content: 'b' }), event({ source: 'agent', content: 'reply b' })]);

    const stats = new OpenHandsImporter(store, { workspacePath: tmpWorkspace, deviceId: DEVICE }).import();
    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(2);
    const ids = store.querySessions({ deviceId: DEVICE }).map((s) => s.nativeSessionId).sort();
    expect(ids).toEqual(['conv-a', 'conv-b']);
  });

  // ── 默认路径解析 ─────────────────────────────────────────────────────────

  describe('resolveOpenHandsWorkspace', () => {
    it('workspacePath 选项优先', () => {
      expect(resolveOpenHandsWorkspace({ workspacePath: '/explicit/ws' })).toBe('/explicit/ws');
    });

    it('无选项时回退环境变量或默认路径', () => {
      const old = process.env.OPENHANDS_WORKSPACE;
      process.env.OPENHANDS_WORKSPACE = '/env/ws';
      try {
        expect(resolveOpenHandsWorkspace()).toBe('/env/ws');
      } finally {
        if (old === undefined) delete process.env.OPENHANDS_WORKSPACE;
        else process.env.OPENHANDS_WORKSPACE = old;
      }
    });
  });
});
