/**
 * Pi Agent 家族原生 adapter 契约测试（Pi / oh-my-pi / gsd-pi，覆盖等级 A）
 *
 * 三 CLI 共享 JSONL v3 树结构格式（每条 entry 有 id + parentId）+ RPC steer，
 * 共享同一 importer，通过配置目录路径区分 source。
 *
 * 覆盖验收门：
 *   1. 根 session：coverage=A source instance，native id=session.id，cwd/最早时间/
 *      model/user+assistant 可显示文本入库
 *   2. 三 flavor（pi/omp/gsd-pi）同次扫描各入库，source 各自归一
 *   3. omp 首行 title 行被排除（不入 entry 树），omp 用合并 model 字符串
 *   4. pi/gsd 用 provider+modelId 分离字段提取 model
 *   5. thinking 块排除；只取 text 块；content 字符串与数组两种形态
 *   6. 重复扫描幂等：不新增 revision
 *   7. 内容变更（追加消息）生成新 revision
 *   8. 脏 JSONL：单行损坏被跳过，合法行仍解析
 *   9. 无有效消息：整 session 跳过并计数
 *  10. 目录排除：非 .jsonl 文件不被扫描
 *  11. native id 回退：缺 session.id → 稳定相对路径
 *  12. extractSession 静态方法：返回中性 session，保留完整 entry 树（id/parentId 拓扑）
 *  13. encodeCwd：/ → -，首尾加 -
 *  14. transferSession：在 flavor 间互转，原样复用 entry，写入目标 flavor 目录
 *  15. gsd 多候选目录探测：spec 目录不存在时回退到旧版目录
 *
 * 真实结构（本机实测，2026-07）：
 *   - 路径：<sessionsDir>/<encoded-cwd>/<ts>_<uuid>.jsonl
 *   - session 行：{ type:"session", version:3, id:<UUID>, timestamp, cwd }
 *   - model_change 行：{ type:"model_change", id, parentId, timestamp,
 *       provider, modelId }            —— pi/gsd：provider + modelId 分离
 *       | { ..., model:"glm/glm-5.2" } —— omp：合并 model 字符串
 *   - message 行：{ type:"message", id, parentId, timestamp,
 *       message:{ role:"user"|"assistant", content:[{type:"text"|"thinking",...}] } }
 *   - 树：每个 entry 的 id + parentId（null=树根）构成会话内分叉树
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import {
  PiImporter,
  PiController,
  resolvePiFlavors,
  resolveFlavorSessionsDir,
  encodeCwd,
  type PiFlavorConfig,
  type PiImportStats,
} from '../src/pi/index.js';

const DEVICE = 'mac-test';
const CWD = '/Users/zoran/Documents/projects/yondermesh';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

/** 一条 JSONL 行（松散结构） */
type Line = Record<string, unknown>;

/** 构造 session 行（根元数据） */
function sessionLine(id: string, opts: { cwd?: string; timestamp?: string } = {}): Line {
  return {
    type: 'session',
    version: 3,
    id,
    timestamp: opts.timestamp ?? '2026-07-15T10:00:00.000Z',
    cwd: opts.cwd ?? CWD,
  };
}

/** model_change 行（pi/gsd：provider + modelId 分离） */
function modelChangePi(
  id: string,
  parentId: string | null,
  opts: { provider?: string; modelId?: string; timestamp?: string } = {},
): Line {
  return {
    type: 'model_change',
    id,
    parentId,
    timestamp: opts.timestamp ?? '2026-07-15T10:00:01.000Z',
    provider: opts.provider ?? 'glm',
    modelId: opts.modelId ?? 'glm-5.2',
  };
}

/** model_change 行（omp：合并 model 字符串） */
function modelChangeOmp(
  id: string,
  parentId: string | null,
  opts: { model?: string; timestamp?: string } = {},
): Line {
  return {
    type: 'model_change',
    id,
    parentId,
    timestamp: opts.timestamp ?? '2026-07-15T10:00:01.000Z',
    model: opts.model ?? 'glm/glm-5.2',
  };
}

/** omp 首行 title 行（应被排除，不入 entry 树） */
function titleLine(title = 'test session'): Line {
  return { type: 'title', v: 1, title, updatedAt: '2026-07-15T10:00:00.000Z', pad: 'x' };
}

interface MessageOpts {
  role: 'user' | 'assistant';
  /** 文本块（自动 type:text）；或显式传 blocks */
  text?: string;
  blocks?: Array<{ type: string; text?: string }>;
  timestamp?: string;
  parentId?: string | null;
  id?: string;
  /** message 内嵌 model（更准确，按轮次） */
  model?: string;
}

/** 构造 message 行 */
function message(o: MessageOpts): Line {
  const content =
    o.blocks !== undefined
      ? o.blocks
      : [{ type: 'text', text: o.text ?? '' }];
  const msg: Record<string, unknown> = { role: o.role, content };
  if (o.model) msg.model = o.model;
  return {
    type: 'message',
    id: o.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    parentId: o.parentId ?? null,
    timestamp: o.timestamp ?? '2026-07-15T10:00:10.000Z',
    message: msg,
  };
}

/** thinking_level_change 行（内部，不入消息但入 entry 树） */
function thinkingLevelChange(id: string, parentId: string | null): Line {
  return {
    type: 'thinking_level_change',
    id,
    parentId,
    timestamp: '2026-07-15T10:00:05.000Z',
    thinkingLevel: 'high',
  };
}

/** 写一个 JSONL session 文件到 <root>/<encoded-cwd>/<filename> */
function writeSession(rootPath: string, filename: string, lines: Line[], cwd = CWD): string {
  const dir = path.join(rootPath, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

/** 写一个 JSONL 文件到任意子目录（用于测试相对路径回退） */
function writeSessionAt(filePath: string, lines: Line[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

const ROOT_ID = '019e2a40-2e0a-7143-8fc5-781f315a442c';

/** 构造指向 tmp 的 flavor 配置（不依赖真实 home） */
function makeFlavors(tmpHome: string): PiFlavorConfig[] {
  return [
    {
      source: 'pi',
      cli: 'pi',
      configDir: path.join(tmpHome, '.pi', 'agent'),
      sessionsDirs: [path.join(tmpHome, '.pi', 'agent', 'sessions')],
      glmModelArg: '--model glm/glm-5.2',
      sessionsDir: null,
    },
    {
      source: 'omp',
      cli: 'omp',
      configDir: path.join(tmpHome, '.omp', 'agent'),
      sessionsDirs: [path.join(tmpHome, '.omp', 'agent', 'sessions')],
      glmModelArg: '--model glm/glm-5.2',
      sessionsDir: null,
    },
    {
      source: 'gsd-pi',
      cli: 'gsd',
      configDir: path.join(tmpHome, '.gsd', 'agent'),
      sessionsDirs: [
        path.join(tmpHome, '.gsd', 'agent', 'sessions'),
        path.join(tmpHome, '.gsd', 'sessions'), // 旧版 gsd 兼容
      ],
      glmModelArg: '--model glm-5.2',
      sessionsDir: null,
    },
  ];
}

// ─── 测试体 ──────────────────────────────────────────────────────────────────

describe('Pi Agent 家族原生 adapter', () => {
  let tmpHome: string;
  let store: SessionStore;
  let flavors: PiFlavorConfig[];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-home-'));
    flavors = makeFlavors(tmpHome);
    // 预建 sessions 目录
    for (const f of flavors) {
      fs.mkdirSync(f.sessionsDirs[0]!, { recursive: true });
    }
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── 验收门 1：根 session + coverage=A + model + 可显示消息 ───────────────

  it('导入根 session：coverage=A source instance，native id=session.id，cwd/最早时间/model/user+assistant 可显示文本入库', () => {
    const piFlavor = flavors[0]!;
    const root = piFlavor.sessionsDirs[0]!;
    writeSession(root, `2026-07-15T10-00-00-${ROOT_ID}.jsonl`, [
      sessionLine(ROOT_ID, { timestamp: '2026-07-15T10:00:00.000Z' }),
      modelChangePi('mc1', null, { timestamp: '2026-07-15T10:00:01.000Z' }),
      thinkingLevelChange('tc1', 'mc1'),
      message({ role: 'user', text: 'hello pi', parentId: 'mc1', timestamp: '2026-07-15T10:00:10.000Z' }),
      message({
        role: 'assistant',
        parentId: 'm1',
        timestamp: '2026-07-15T10:00:20.000Z',
        blocks: [
          { type: 'thinking', text: 'secret chain of thought' }, // 必须排除
          { type: 'text', text: 'pi reply' },
        ],
      }),
    ]);

    const stats: PiImportStats = new PiImporter(store, {
      flavors,
      deviceId: DEVICE,
    }).import('pi');

    // 统计：扫描 1，新增 1
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.flavors).toHaveLength(1);
    expect(stats.flavors[0]!.source).toBe('pi');

    // source instance：coverage=A，source=pi
    const inst = store.getSourceInstance(stats.flavors[0]!.sourceInstanceId);
    expect(inst).toBeDefined();
    expect(inst!.source).toBe('pi');
    expect(inst!.coverage).toBe('A');
    expect(inst!.rootPath).toBe(root);

    // session：topology=root，native id=session.id，cwd，model
    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.topology).toBe('root');
    expect(s.nativeSessionId).toBe(ROOT_ID);
    expect(s.source).toBe('pi');
    expect(s.cwd).toBe(CWD);
    expect(s.projectPath).toBe(CWD);
    // 最早时间 = session 行 timestamp（10:00:00 早于所有其他行）
    expect(s.startedAt).toBe(Date.parse('2026-07-15T10:00:00.000Z'));
    // model 从 model_change 的 provider+modelId 提取
    expect(s.model).toBe('glm/glm-5.2');
    // cliVersion 来自 version 字段
    expect(s.cliVersion).toBe('v3');

    // 消息：只有可显示文本；thinking 排除
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello pi'],
      ['assistant', 'pi reply'],
    ]);
    expect(msgs[0]!.timestamp).toBe(Date.parse('2026-07-15T10:00:10.000Z'));

    // scan_run completed
    const run = store.getScanRun(stats.flavors[0]!.scanRunId);
    expect(run.status).toBe('completed');
    expect(run.sessionsSeen).toBe(1);
    expect(run.sessionsNew).toBe(1);
    expect(run.endedAt).toBeGreaterThan(0);
  });

  // ── 验收门 2：三 flavor 同次扫描各自入库，source 归一 ─────────────────────

  it('三 flavor（pi/omp/gsd-pi）同次扫描：各自入库，source 各自归一', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    const ompRoot = flavors[1]!.sessionsDirs[0]!;
    const gsdRoot = flavors[2]!.sessionsDirs[0]!;

    writeSession(piRoot, `2026-07-15T10-00-00-pi.jsonl`, [
      sessionLine('aaaaaaaa-0000-0000-0000-000000000001', { cwd: CWD }),
      modelChangePi('mc1', null),
      message({ role: 'user', text: 'pi msg', parentId: 'mc1' }),
    ]);
    writeSession(ompRoot, `2026-07-15T10-00-00-omp.jsonl`, [
      titleLine('omp session'), // title 行被排除
      sessionLine('bbbbbbbb-0000-0000-0000-000000000002', { cwd: CWD }),
      modelChangeOmp('mc1', null),
      message({ role: 'user', text: 'omp msg', parentId: 'mc1' }),
    ]);
    writeSession(gsdRoot, `2026-07-15T10-00-00-gsd.jsonl`, [
      sessionLine('cccccccc-0000-0000-0000-000000000003', { cwd: CWD }),
      modelChangePi('mc1', null, { provider: 'glm', modelId: 'glm-5.2' }),
      message({ role: 'user', text: 'gsd msg', parentId: 'mc1' }),
    ]);

    const stats = new PiImporter(store, { flavors, deviceId: DEVICE }).import();

    expect(stats.scanned).toBe(3);
    expect(stats.inserted).toBe(3);
    expect(stats.flavors).toHaveLength(3);

    const sessions = store.querySessions({ deviceId: DEVICE, limit: 100 });
    expect(sessions).toHaveLength(3);
    const sources = sessions.map((s) => s.source).sort();
    expect(sources).toEqual(['gsd-pi', 'omp', 'pi']);

    // 各 source 的消息正确
    const pi = sessions.find((s) => s.source === 'pi')!;
    const omp = sessions.find((s) => s.source === 'omp')!;
    const gsd = sessions.find((s) => s.source === 'gsd-pi')!;
    expect(store.getMessages(pi.id).map((m) => m.content)).toEqual(['pi msg']);
    expect(store.getMessages(omp.id).map((m) => m.content)).toEqual(['omp msg']);
    expect(store.getMessages(gsd.id).map((m) => m.content)).toEqual(['gsd msg']);
  });

  // ── 验收门 3：omp title 行排除 + omp 合并 model 字符串 ────────────────────

  it('omp：title 行被排除（不入 entry 树），model 用合并 model 字符串', () => {
    const ompRoot = flavors[1]!.sessionsDirs[0]!;
    const file = writeSession(ompRoot, `2026-07-15T10-00-00-omp-title.jsonl`, [
      titleLine('omp titled'),
      sessionLine(ROOT_ID, { cwd: CWD }),
      modelChangeOmp('mc1', null, { model: 'glm/glm-5.2' }),
      message({ role: 'user', text: 'hi', parentId: 'mc1' }),
    ]);

    const stats = new PiImporter(store, { flavors, deviceId: DEVICE }).import('omp');
    expect(stats.inserted).toBe(1);

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(s.model).toBe('glm/glm-5.2');

    // extractSession 静态方法：entry 树不含 title 行
    const neutral = PiImporter.extractSession(file, 'omp');
    expect(neutral).not.toBeNull();
    const types = neutral!.entries.map((e) => e.type);
    expect(types).not.toContain('title');
    expect(types).toContain('session');
    expect(types).toContain('model_change');
    expect(types).toContain('message');
  });

  // ── 验收门 4：pi/gsd 用 provider+modelId 提取 model ───────────────────────

  it('pi/gsd：model 从 model_change 的 provider+modelId 分离字段提取', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    writeSession(piRoot, `2026-07-15T10-00-00-pi-model.jsonl`, [
      sessionLine(ROOT_ID, { cwd: CWD }),
      modelChangePi('mc1', null, { provider: 'glm', modelId: 'glm-5.2' }),
      message({ role: 'user', text: 'hi', parentId: 'mc1' }),
    ]);

    new PiImporter(store, { flavors, deviceId: DEVICE }).import('pi');
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(s.model).toBe('glm/glm-5.2');
  });

  // ── 验收门 5：thinking 排除 + content 字符串/数组两种形态 ─────────────────

  it('thinking 块排除；content 字符串与数组两种形态都能提取', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    writeSession(piRoot, `2026-07-15T10-00-00-blocks.jsonl`, [
      sessionLine(ROOT_ID, { cwd: CWD }),
      modelChangePi('mc1', null),
      // content 为字符串
      message({
        role: 'user',
        parentId: 'mc1',
        text: 'string content',
        timestamp: '2026-07-15T10:00:10.000Z',
      }),
      // content 为数组：含 thinking（排除）+ text（保留）
      message({
        role: 'assistant',
        parentId: 'm1',
        timestamp: '2026-07-15T10:00:20.000Z',
        blocks: [
          { type: 'thinking', text: 'hidden' },
          { type: 'text', text: 'visible reply' },
        ],
      }),
    ]);

    new PiImporter(store, { flavors, deviceId: DEVICE }).import('pi');
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getMessages(s.id).map((m) => [m.role, m.content])).toEqual([
      ['user', 'string content'],
      ['assistant', 'visible reply'],
    ]);
  });

  // ── 验收门 6：重复扫描幂等 ───────────────────────────────────────────────

  it('重复扫描幂等：不新增 revision，stats.unchanged=1', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    writeSession(piRoot, `2026-07-15T10-00-00-idem.jsonl`, [
      sessionLine(ROOT_ID, { cwd: CWD }),
      modelChangePi('mc1', null),
      message({ role: 'user', text: 'stable', parentId: 'mc1' }),
      message({ role: 'assistant', text: 'reply', parentId: 'm1' }),
    ]);

    const importer = new PiImporter(store, { flavors, deviceId: DEVICE });
    const first = importer.import('pi');
    expect(first.inserted).toBe(1);
    expect(first.unchanged).toBe(0);

    const second = importer.import('pi');
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getRevisions(s.id)).toHaveLength(1);
  });

  // ── 验收门 7：内容变更生成新 revision ────────────────────────────────────

  it('内容变更（追加消息）生成新 revision', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    const file = writeSession(piRoot, `2026-07-15T10-00-00-rev.jsonl`, [
      sessionLine(ROOT_ID, { cwd: CWD }),
      modelChangePi('mc1', null),
      message({ role: 'user', text: 'first', parentId: 'mc1' }),
    ]);

    const importer = new PiImporter(store, { flavors, deviceId: DEVICE });
    importer.import('pi');
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getRevisions(s.id)).toHaveLength(1);

    // 追加一条 assistant 消息（内容变化）
    fs.writeFileSync(
      file,
      [
        JSON.stringify(sessionLine(ROOT_ID, { cwd: CWD })),
        JSON.stringify(modelChangePi('mc1', null)),
        JSON.stringify(message({ role: 'user', text: 'first', parentId: 'mc1' })),
        JSON.stringify(message({ role: 'assistant', text: 'second reply', parentId: 'm1' })),
      ].join('\n') + '\n',
      'utf8',
    );

    const second = importer.import('pi');
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(0);

    expect(store.getRevisions(s.id)).toHaveLength(2);
    expect(store.getMessages(s.id).map((m) => m.content)).toEqual(['first', 'second reply']);
  });

  // ── 验收门 8：脏 JSONL 行跳过 ────────────────────────────────────────────

  it('脏 JSONL：单行损坏被跳过，合法行仍解析', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    const dir = path.join(piRoot, encodeCwd(CWD));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '2026-07-15T10-00-00-dirty.jsonl');
    // 第 2 行是损坏 JSON
    fs.writeFileSync(
      file,
      [
        JSON.stringify(sessionLine(ROOT_ID, { cwd: CWD })),
        '{ this is not valid json',
        JSON.stringify(modelChangePi('mc1', null)),
        JSON.stringify(message({ role: 'user', text: 'after dirty', parentId: 'mc1' })),
      ].join('\n') + '\n',
      'utf8',
    );

    const stats = new PiImporter(store, { flavors, deviceId: DEVICE }).import('pi');
    expect(stats.inserted).toBe(1);
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    // 损坏行跳过，合法消息入库
    expect(store.getMessages(s.id).map((m) => m.content)).toEqual(['after dirty']);
  });

  // ── 验收门 9：无有效消息跳过 ─────────────────────────────────────────────

  it('无有效消息：整 session 跳过并计数', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    writeSession(piRoot, `2026-07-15T10-00-00-nomsg.jsonl`, [
      sessionLine(ROOT_ID, { cwd: CWD }),
      modelChangePi('mc1', null),
      thinkingLevelChange('tc1', 'mc1'),
      // 只有 thinking 块（无可显示文本）
      message({
        role: 'assistant',
        parentId: 'mc1',
        blocks: [{ type: 'thinking', text: 'only thinking' }],
      }),
    ]);

    const stats = new PiImporter(store, { flavors, deviceId: DEVICE }).import('pi');
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 验收门 10：非 .jsonl 文件不扫描 ──────────────────────────────────────

  it('目录排除：非 .jsonl 文件不被扫描', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    const dir = path.join(piRoot, encodeCwd(CWD));
    fs.mkdirSync(dir, { recursive: true });
    // .jsonl 文件（应扫描）
    writeSession(piRoot, `2026-07-15T10-00-00-real.jsonl`, [
      sessionLine(ROOT_ID, { cwd: CWD }),
      modelChangePi('mc1', null),
      message({ role: 'user', text: 'real', parentId: 'mc1' }),
    ]);
    // 非 .jsonl 文件（应忽略）
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'some notes\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'config.json'), '{"a":1}\n', 'utf8');

    const stats = new PiImporter(store, { flavors, deviceId: DEVICE }).import('pi');
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
  });

  // ── 验收门 11：native id 回退到相对路径 ──────────────────────────────────

  it('native id 回退：缺 session.id → 稳定相对路径', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    const dir = path.join(piRoot, encodeCwd(CWD));
    fs.mkdirSync(dir, { recursive: true });
    const filename = '2026-07-15T10-00-00-noid.jsonl';
    fs.writeFileSync(
      path.join(dir, filename),
      [
        // session 行缺 id
        JSON.stringify({ type: 'session', version: 3, timestamp: '2026-07-15T10:00:00.000Z', cwd: CWD }),
        JSON.stringify(modelChangePi('mc1', null)),
        JSON.stringify(message({ role: 'user', text: 'no id', parentId: 'mc1' })),
      ].join('\n') + '\n',
      'utf8',
    );

    new PiImporter(store, { flavors, deviceId: DEVICE }).import('pi');
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    // native id 回退为相对 rootPath 的 posix 路径
    expect(s.nativeSessionId).toBe(`${encodeCwd(CWD)}/${filename}`);
  });

  // ── 验收门 12：extractSession 静态方法保留 entry 树拓扑 ───────────────────

  it('extractSession 静态方法：返回中性 session，保留完整 entry 树（id/parentId 拓扑）', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    const file = writeSession(piRoot, `2026-07-15T10-00-00-tree.jsonl`, [
      sessionLine(ROOT_ID, { cwd: CWD }),
      modelChangePi('mc1', null), // parentId=null → 树根
      message({ id: 'm1', role: 'user', text: 'q', parentId: 'mc1', timestamp: '2026-07-15T10:00:10.000Z' }),
      message({ id: 'm2', role: 'assistant', text: 'a', parentId: 'm1', timestamp: '2026-07-15T10:00:20.000Z' }),
    ]);

    const neutral = PiImporter.extractSession(file, 'pi');
    expect(neutral).not.toBeNull();
    expect(neutral!.source).toBe('pi');
    expect(neutral!.nativeId).toBe(ROOT_ID);
    expect(neutral!.cwd).toBe(CWD);
    expect(neutral!.filePath).toBe(file);

    // entry 树：4 个 entry（session + model_change + 2 message），title 无
    expect(neutral!.entries).toHaveLength(4);
    const mc = neutral!.entries.find((e) => e.type === 'model_change')!;
    expect(mc.id).toBe('mc1');
    expect(mc.parentId).toBeNull(); // 树根
    const m1 = neutral!.entries.find((e) => e.id === 'm1')!;
    expect(m1.parentId).toBe('mc1');
    const m2 = neutral!.entries.find((e) => e.id === 'm2')!;
    expect(m2.parentId).toBe('m1');

    // 线性消息只含可显示文本
    expect(neutral!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'q'],
      ['assistant', 'a'],
    ]);
  });

  // ── 验收门 13：encodeCwd 规则 ────────────────────────────────────────────

  it('encodeCwd：去掉前导 /，剩余 / 替换为 -，首尾各加 --（与本机真实 Pi 目录名一致）', () => {
    // 与本机 ~/.pi/agent/sessions/ 真实目录名校验
    expect(encodeCwd('/private/tmp')).toBe('--private-tmp--');
    expect(encodeCwd('/Users/zoran/Documents/projects/yondermesh')).toBe(
      '--Users-zoran-Documents-projects-yondermesh--',
    );
    expect(encodeCwd('/private/tmp/omp-test')).toBe('--private-tmp-omp-test--');
    // 边界：仅根 /
    expect(encodeCwd('/')).toBe('----');
  });

  // ── 验收门 14：transferSession 在 flavor 间互转 ──────────────────────────

  it('transferSession：pi → omp 互转，原样复用 entry，写入目标 flavor 目录', async () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    writeSession(piRoot, `2026-07-15T10-00-00-transfer.jsonl`, [
      sessionLine(ROOT_ID, { cwd: CWD }),
      modelChangePi('mc1', null),
      message({ id: 'm1', role: 'user', text: 'transfer me', parentId: 'mc1', timestamp: '2026-07-15T10:00:10.000Z' }),
      message({ id: 'm2', role: 'assistant', text: 'ok', parentId: 'm1', timestamp: '2026-07-15T10:00:20.000Z' }),
    ]);

    const ctl = new PiController({ flavors });
    const result = await ctl.transferSession(ROOT_ID, 'omp', { sourceCli: 'pi' });

    expect(result.targetSource).toBe('omp');
    expect(result.targetCli).toBe('omp');
    expect(result.sessionId).toBe(ROOT_ID);
    expect(result.entryCount).toBe(4); // session + model_change + 2 message

    // 文件写入 omp 的 sessions 目录，在 encoded-cwd 子目录下
    const ompRoot = flavors[1]!.sessionsDirs[0]!;
    expect(result.targetFilePath.startsWith(ompRoot)).toBe(true);
    expect(result.targetFilePath).toContain(encodeCwd(CWD));
    expect(fs.existsSync(result.targetFilePath)).toBe(true);

    // 目标文件可被 extractSession 重新解析，entry 树拓扑保留
    const neutral = PiImporter.extractSession(result.targetFilePath, 'omp');
    expect(neutral).not.toBeNull();
    expect(neutral!.nativeId).toBe(ROOT_ID);
    expect(neutral!.entries).toHaveLength(4);
    const m2 = neutral!.entries.find((e) => e.id === 'm2')!;
    expect(m2.parentId).toBe('m1');

    // 消息内容保留
    expect(neutral!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'transfer me'],
      ['assistant', 'ok'],
    ]);
  });

  // ── 验收门 15：gsd 多候选目录探测 ────────────────────────────────────────

  it('gsd 多候选目录探测：spec 目录不存在时回退到旧版目录', () => {
    // 删除 spec 目录，只保留旧版目录
    const gsdFlavor = flavors[2]!;
    fs.rmSync(gsdFlavor.sessionsDirs[0]!, { recursive: true, force: true });
    fs.mkdirSync(gsdFlavor.sessionsDirs[1]!, { recursive: true }); // 旧版 ~/.gsd/sessions/

    // resolveFlavorSessionsDir 应选中第二个候选
    const resolved = resolveFlavorSessionsDir(gsdFlavor);
    expect(resolved).toBe(gsdFlavor.sessionsDirs[1]);

    // 在旧版目录写入 session，importer 应能扫到
    writeSessionAt(
      path.join(gsdFlavor.sessionsDirs[1]!, encodeCwd(CWD), `2026-07-15T10-00-00-gsd-fallback.jsonl`),
      [
        sessionLine('dddddddd-0000-0000-0000-000000000004', { cwd: CWD }),
        modelChangePi('mc1', null),
        message({ role: 'user', text: 'gsd fallback', parentId: 'mc1' }),
      ],
    );

    const stats = new PiImporter(store, { flavors, deviceId: DEVICE }).import('gsd-pi');
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(s.source).toBe('gsd-pi');
    expect(store.getMessages(s.id).map((m) => m.content)).toEqual(['gsd fallback']);
  });

  // ── 验收门 16：目录不存在时仍注册 source instance 但跳过 scan_run ─────────

  it('sessions 目录不存在：仍注册 source instance（coverage=A），跳过 scan_run', () => {
    // 删除全部 sessions 目录
    for (const f of flavors) {
      fs.rmSync(f.sessionsDirs[0]!, { recursive: true, force: true });
    }

    const stats = new PiImporter(store, { flavors, deviceId: DEVICE }).import();
    expect(stats.scanned).toBe(0);
    expect(stats.inserted).toBe(0);
    // 三个 flavor 都注册了 source instance
    expect(stats.flavors).toHaveLength(3);
    for (const f of stats.flavors) {
      expect(f.sessionsDir).toBeNull();
      expect(f.sourceInstanceId).not.toBe('');
      const inst = store.getSourceInstance(f.sourceInstanceId);
      expect(inst).toBeDefined();
      expect(inst!.coverage).toBe('A');
      expect(f.scanRunId).toBe(0); // 未启动 scan_run
    }
  });

  // ── 验收门 17：only 过滤按 source 或 cli ─────────────────────────────────

  it('only 过滤：按 source（pi）或 cli（omp）都能限定单 flavor', () => {
    const piRoot = flavors[0]!.sessionsDirs[0]!;
    const ompRoot = flavors[1]!.sessionsDirs[0]!;
    writeSession(piRoot, `2026-07-15T10-00-00-a.jsonl`, [
      sessionLine('aaaaaaaa-0000-0000-0000-000000000011', { cwd: CWD }),
      modelChangePi('mc1', null),
      message({ role: 'user', text: 'pi', parentId: 'mc1' }),
    ]);
    writeSession(ompRoot, `2026-07-15T10-00-00-b.jsonl`, [
      sessionLine('bbbbbbbb-0000-0000-0000-000000000022', { cwd: CWD }),
      modelChangeOmp('mc1', null),
      message({ role: 'user', text: 'omp', parentId: 'mc1' }),
    ]);

    // 按 source 过滤
    const bySource = new PiImporter(store, { flavors, deviceId: DEVICE }).import('pi');
    expect(bySource.flavors).toHaveLength(1);
    expect(bySource.flavors[0]!.source).toBe('pi');

    // 按 cli 过滤
    const store2 = new SessionStore(':memory:');
    try {
      const byCli = new PiImporter(store2, { flavors, deviceId: DEVICE }).import('omp');
      expect(byCli.flavors).toHaveLength(1);
      expect(byCli.flavors[0]!.cli).toBe('omp');
    } finally {
      store2.close();
    }
  });
});

// ─── resolvePiFlavors / resolveFlavorSessionsDir 单元测试 ─────────────────────

describe('Pi flavor 解析', () => {
  it('resolvePiFlavors 返回三个 flavor（pi/omp/gsd-pi），gsd 有两个候选目录', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-resolve-'));
    try {
      const flavors = resolvePiFlavors(tmpHome);
      expect(flavors).toHaveLength(3);
      expect(flavors.map((f) => f.source)).toEqual(['pi', 'omp', 'gsd-pi']);
      expect(flavors.map((f) => f.cli)).toEqual(['pi', 'omp', 'gsd']);

      // gsd 有两个候选目录（spec + 旧版兼容）
      const gsd = flavors.find((f) => f.source === 'gsd-pi')!;
      expect(gsd.sessionsDirs).toHaveLength(2);
      expect(gsd.sessionsDirs[0]).toBe(path.join(tmpHome, '.gsd', 'agent', 'sessions'));
      expect(gsd.sessionsDirs[1]).toBe(path.join(tmpHome, '.gsd', 'sessions'));

      // glmModelArg 各自不同
      expect(flavors[0]!.glmModelArg).toBe('--model glm/glm-5.2');
      expect(flavors[1]!.glmModelArg).toBe('--model glm/glm-5.2');
      expect(flavors[2]!.glmModelArg).toBe('--model glm-5.2');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('resolveFlavorSessionsDir：目录全不存在返回 null，首个存在者生效', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-resolve2-'));
    try {
      const flavors = resolvePiFlavors(tmpHome);
      // 全不存在
      for (const f of flavors) {
        expect(resolveFlavorSessionsDir(f)).toBeNull();
      }
      // 创建 gsd 旧版目录（第二个候选），应被选中
      const gsd = flavors.find((f) => f.source === 'gsd-pi')!;
      fs.mkdirSync(gsd.sessionsDirs[1]!, { recursive: true });
      expect(resolveFlavorSessionsDir(gsd)).toBe(gsd.sessionsDirs[1]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
