/**
 * Factory Droid 原生 adapter 契约测试
 *
 * 覆盖：
 *   1. 根 session 解析：session_start 元数据 + message 行，native id=id，cwd/version/model 入库
 *   2. thinking/tool_use 块排除，只取 text 块
 *   3. sidecar .settings.json 提供 model
 *   4. 重复扫描幂等
 *   5. 内容变更生成新 revision
 *   6. 脏 JSONL 行跳过
 *   7. 无有效消息跳过
 *   8. native id 回退到文件名
 *   9. wrapper detect / resume args
 *  10. inject hooks content / extensions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import {
  FactoryDroidImporter,
  resolveFactorySessionsPath,
  detectFactoryDroid,
  droidResumeArgs,
  factoryHooksContent,
  buildFactoryExtensions,
  FACTORY_HOME,
} from '../src/factory/index.js';

const DEVICE = 'mac-test';
const SESSION_ID = 'f1a2b3c4-d5e6-7890-abcd-ef1234567890';
const CWD = '/Users/zoran/Documents/projects/demo';

function writeJsonl(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
}

function sessionStart(id: string, cwd: string, version = '0.171.0'): unknown {
  return { type: 'session_start', id, title: 'demo', owner: 'zoran', version, cwd, hostId: 'h1' };
}

function messageLine(role: string, content: unknown, timestamp: string, id = 'm1'): unknown {
  return { type: 'message', id, timestamp, message: { role, content } };
}

describe('Factory Droid 原生 adapter', () => {
  let tmpRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── 验收门 1：根 session 解析 + 元数据 ──────────────────────────────────

  it('导入根 session：native id=session_start.id，cwd/version/model 入库，thinking/tool_use 排除', () => {
    const projectDir = '-Users-zoran-Documents-projects-demo';
    const file = path.join(tmpRoot, projectDir, `${SESSION_ID}.jsonl`);
    writeJsonl(file, [
      sessionStart(SESSION_ID, CWD),
      messageLine('user', [{ type: 'text', text: 'hello factory' }], '2026-07-13T01:00:00.000Z'),
      messageLine('assistant', [
        { type: 'thinking', text: 'internal CoT' }, // 排除
        { type: 'text', text: 'factory reply' },     // 保留
        { type: 'tool_use', name: 'Bash' },          // 排除
      ], '2026-07-13T01:01:00.000Z'),
    ]);
    // sidecar settings.json 提供 model
    fs.writeFileSync(
      file.replace(/\.jsonl$/, '.settings.json'),
      JSON.stringify({ model: 'custom:glm-5.2', providerLock: 'anthropic' }),
      'utf8',
    );

    const stats = new FactoryDroidImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0);

    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst).toBeDefined();
    expect(inst!.source).toBe('factory');
    expect(inst!.coverage).toBe('A');

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.topology).toBe('root');
    expect(s.nativeSessionId).toBe(SESSION_ID);
    expect(s.source).toBe('factory');
    expect(s.cwd).toBe(CWD);
    expect(s.model).toBe('custom:glm-5.2');
    expect(s.cliVersion).toBe('0.171.0');
    expect(s.startedAt).toBe(Date.parse('2026-07-13T01:00:00.000Z'));

    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello factory'],
      ['assistant', 'factory reply'],
    ]);
  });

  // ── 验收门 2：重复扫描幂等 ─────────────────────────────────────────────

  it('相同内容重复扫描幂等：计入 unchanged，不新增 revision', () => {
    const file = path.join(tmpRoot, 'proj', `${SESSION_ID}.jsonl`);
    writeJsonl(file, [
      sessionStart(SESSION_ID, CWD),
      messageLine('user', 'hi', '2026-07-13T01:00:00.000Z'),
      messageLine('assistant', [{ type: 'text', text: 'ok' }], '2026-07-13T01:01:00.000Z'),
    ]);

    const importer = new FactoryDroidImporter(store, { rootPath: tmpRoot, deviceId: DEVICE });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    const second = importer.import();
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getRevisions(s.id)).toHaveLength(1);
  });

  // ── 验收门 3：内容变更生成新 revision ──────────────────────────────────

  it('内容变更（追加 assistant 消息）生成新 revision', () => {
    const file = path.join(tmpRoot, 'proj', `${SESSION_ID}.jsonl`);
    writeJsonl(file, [
      sessionStart(SESSION_ID, CWD),
      messageLine('user', 'hi', '2026-07-13T01:00:00.000Z'),
      messageLine('assistant', [{ type: 'text', text: 'ok' }], '2026-07-13T01:01:00.000Z'),
    ]);

    const importer = new FactoryDroidImporter(store, { rootPath: tmpRoot, deviceId: DEVICE });
    importer.import();

    fs.appendFileSync(file,
      JSON.stringify(messageLine('assistant', [{ type: 'text', text: 'follow up' }], '2026-07-13T02:00:00.000Z', 'm3')) + '\n',
      'utf8');

    const second = importer.import();
    expect(second.updated).toBe(1);

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getRevisions(s.id).map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(store.getMessages(s.id)).toHaveLength(3);
  });

  // ── 验收门 4：脏 JSONL 行跳过 ──────────────────────────────────────────

  it('脏 JSONL：单行损坏被跳过，合法行仍解析', () => {
    const file = path.join(tmpRoot, 'proj', `${SESSION_ID}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = [
      JSON.stringify(sessionStart(SESSION_ID, CWD)),
      '{ this is not valid json !!!',
      JSON.stringify(messageLine('user', 'good', '2026-07-13T01:00:00.000Z')),
    ].join('\n') + '\n';
    fs.writeFileSync(file, body, 'utf8');

    const stats = new FactoryDroidImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    expect(stats.inserted).toBe(1);
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getMessages(s.id).map((m) => m.content)).toEqual(['good']);
  });

  // ── 验收门 5：无有效消息跳过 ───────────────────────────────────────────

  it('无有效消息的 session 被跳过并计入 skipped', () => {
    const file = path.join(tmpRoot, 'proj', `${SESSION_ID}.jsonl`);
    writeJsonl(file, [
      sessionStart(SESSION_ID, CWD),
      // 只有 thinking 块的 assistant，无 text 块
      messageLine('assistant', [{ type: 'thinking', text: 'only thinking' }], '2026-07-13T01:00:00.000Z'),
    ]);

    const stats = new FactoryDroidImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 验收门 6：native id 回退到文件名 ───────────────────────────────────

  it('缺 session_start.id 时用文件名（去 .jsonl）作 native id', () => {
    const file = path.join(tmpRoot, 'proj', `fallback-uuid.jsonl`);
    writeJsonl(file, [
      // session_start 无 id 字段
      { type: 'session_start', title: 'demo', cwd: CWD, version: '0.171.0' },
      messageLine('user', 'hi', '2026-07-13T01:00:00.000Z'),
      messageLine('assistant', [{ type: 'text', text: 'r' }], '2026-07-13T01:01:00.000Z'),
    ]);

    new FactoryDroidImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(s.nativeSessionId).toBe('fallback-uuid');
  });

  // ── 验收门 7：message.content 为字符串时直接取 ─────────────────────────

  it('message.content 为字符串时直接取作正文', () => {
    const file = path.join(tmpRoot, 'proj', `${SESSION_ID}.jsonl`);
    writeJsonl(file, [
      sessionStart(SESSION_ID, CWD),
      { type: 'message', id: 'm1', timestamp: '2026-07-13T01:00:00.000Z', message: { role: 'user', content: 'plain string content' } },
      { type: 'message', id: 'm2', timestamp: '2026-07-13T01:01:00.000Z', message: { role: 'assistant', content: 'string reply' } },
    ]);

    new FactoryDroidImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getMessages(s.id).map((m) => [m.role, m.content])).toEqual([
      ['user', 'plain string content'],
      ['assistant', 'string reply'],
    ]);
  });

  // ── 验收门 8：不可读根目录 ─────────────────────────────────────────────

  it('rootPath 不存在时抛出明确错误', () => {
    const importer = new FactoryDroidImporter(store, {
      rootPath: path.join(tmpRoot, 'does-not-exist'),
      deviceId: DEVICE,
    });
    expect(() => importer.import()).toThrowError(/factory|sessions|目录|read/i);
  });

  // ── 默认路径解析 ───────────────────────────────────────────────────────

  describe('resolveFactorySessionsPath', () => {
    it('rootPath 选项优先', () => {
      expect(resolveFactorySessionsPath({ rootPath: '/explicit/factory' })).toBe('/explicit/factory');
    });

    it('无 rootPath 时回退默认 ~/.factory/sessions', () => {
      expect(resolveFactorySessionsPath()).toBe(path.join(os.homedir(), '.factory', 'sessions'));
    });
  });
});

// ─── wrapper 契约 ────────────────────────────────────────────────────────

describe('Factory Droid wrapper', () => {
  it('detectFactoryDroid 返回结构良好（installed 为 boolean；已安装时 version 为字符串）', () => {
    const d = detectFactoryDroid();
    expect(typeof d.installed).toBe('boolean');
    expect(typeof d.homeExists).toBe('boolean');
    expect(typeof d.sessionsDirExists).toBe('boolean');
    // 若已安装，binary 与 version 必须存在
    if (d.installed) {
      expect(d.binary).toBe('droid');
      expect(typeof d.version).toBe('string');
      expect(d.version!.length).toBeGreaterThan(0);
    }
  });

  it('droidResumeArgs 构造续接参数', () => {
    expect(droidResumeArgs(SESSION_ID)).toEqual(['--resume', SESSION_ID]);
    expect(droidResumeArgs(SESSION_ID, CWD)).toEqual(['--resume', SESSION_ID, '--cwd', CWD]);
  });

  it('FACTORY_HOME 指向 ~/.factory', () => {
    expect(FACTORY_HOME).toBe(path.join(os.homedir(), '.factory'));
  });
});

// ─── inject 契约 ─────────────────────────────────────────────────────────

describe('Factory Droid inject', () => {
  it('factoryHooksContent 生成含 Stop hook 的 JSON', () => {
    const content = factoryHooksContent();
    const parsed = JSON.parse(content) as { hooks: Record<string, unknown[]> };
    expect(parsed.hooks.Stop).toBeDefined();
    expect(parsed.hooks.Stop.length).toBeGreaterThan(0);
  });

  it('buildFactoryExtensions 返回 mcp-server / skill / plugin 三类', () => {
    const exts = buildFactoryExtensions();
    const types = exts.map((e) => e.type);
    expect(types).toContain('mcp-server');
    expect(types).toContain('skill');
    expect(types).toContain('plugin');
    const mcp = exts.find((e) => e.type === 'mcp-server')!;
    expect(mcp.mcp).toBeDefined();
    expect(mcp.mcp!.command).toBe(process.execPath);
  });
});
