/**
 * Vibe 原生 adapter 契约测试
 *
 * 覆盖：
 *   1. 根 session 目录解析：meta.json + messages.jsonl，native id=session_id，cwd/tokens
 *   2. subagent 拓扑：parent_session_id → subagent + spawned_by 关系
 *   3. injected=true 排除（系统注入上下文）
 *   4. reasoning_content 不入库（思维链）
 *   5. 重复扫描幂等
 *   6. 无效目录跳过
 *   7. native id 回退到目录名
 *   8. wrapper detect / resume args
 *   9. mcp-toml-array 策略 mount/unmount/isMounted
 *  10. inject hooks content / extensions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import {
  VibeImporter,
  resolveVibeSessionsPath,
  detectVibe,
  vibeResumeArgs,
  vibeHooksContent,
  buildVibeExtensions,
  VIBE_HOME,
} from '../src/vibe/index.js';
import { mcpTomlArrayStrategy } from '../src/mount/strategies.js';
import type { Extension } from '../src/mount/types.js';

const DEVICE = 'mac-test';
const ROOT_SESSION_ID = 'vibe-root-0001';
const SUB_SESSION_ID = 'vibe-sub-0002';
const CWD = '/Users/zoran/Documents/projects/demo';

function makeSessionDir(root: string, dirName: string): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMeta(dir: string, meta: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
}

function writeMessages(dir: string, lines: unknown[]): void {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), body, 'utf8');
}

function rootMeta(): Record<string, unknown> {
  return {
    session_id: ROOT_SESSION_ID,
    parent_session_id: null,
    start_time: '2026-07-13T01:00:00Z',
    end_time: null,
    environment: { working_directory: CWD },
    title: 'root session',
    stats: { session_prompt_tokens: 100, session_completion_tokens: 50, context_tokens: 200, steps: 2 },
  };
}

describe('Vibe 原生 adapter', () => {
  let tmpRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-test-'));
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── 验收门 1：根 session 目录解析 ──────────────────────────────────────

  it('导入根 session：native id=meta.session_id，cwd/tokens/title 入库，reasoning_content 排除', () => {
    const dir = makeSessionDir(tmpRoot, 'session_20260713_010000_a1b2c3d4');
    writeMeta(dir, rootMeta());
    writeMessages(dir, [
      { role: 'user', content: 'hello vibe', injected: false, message_id: 'm1' },
      { role: 'assistant', content: 'vibe reply', injected: false, message_id: 'm2', reasoning_content: 'internal chain' },
    ]);

    const stats = new VibeImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.subagents).toBe(0);

    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst!.source).toBe('vibe');
    expect(inst!.coverage).toBe('A');

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.topology).toBe('root');
    expect(s.nativeSessionId).toBe(ROOT_SESSION_ID);
    expect(s.source).toBe('vibe');
    expect(s.cwd).toBe(CWD);
    expect(s.startedAt).toBe(Date.parse('2026-07-13T01:00:00Z'));
    expect(s.totalInputTokens).toBe(100);
    expect(s.totalOutputTokens).toBe(50);

    // reasoning_content 不入库，只取 content
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello vibe'],
      ['assistant', 'vibe reply'],
    ]);
  });

  // ── 验收门 2：subagent 拓扑 + spawned_by 关系 ──────────────────────────

  it('parent_session_id 非空 → subagent，写 spawned_by 关系', () => {
    const rootDir = makeSessionDir(tmpRoot, 'session_20260713_010000_a1b2c3d4');
    writeMeta(rootDir, rootMeta());
    writeMessages(rootDir, [
      { role: 'user', content: 'root prompt', injected: false, message_id: 'm1' },
      { role: 'assistant', content: 'root reply', injected: false, message_id: 'm2' },
    ]);

    const subDir = makeSessionDir(tmpRoot, 'session_20260713_020000_e5f6g7h8');
    writeMeta(subDir, {
      session_id: SUB_SESSION_ID,
      parent_session_id: ROOT_SESSION_ID,
      start_time: '2026-07-13T02:00:00Z',
      environment: { working_directory: CWD },
    });
    writeMessages(subDir, [
      { role: 'user', content: 'sub task', injected: false, message_id: 's1' },
      { role: 'assistant', content: 'sub reply', injected: false, message_id: 's2' },
    ]);

    const stats = new VibeImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(2);
    expect(stats.subagents).toBe(1);
    expect(stats.relationships).toBe(1);
    expect(stats.unlinkedSubagents).toBe(0);

    const subs = store.querySessions({ deviceId: DEVICE, topology: 'subagent' });
    expect(subs).toHaveLength(1);
    const sub = subs[0]!;
    expect(sub.nativeSessionId).toBe(SUB_SESSION_ID);

    const roots = store.querySessions({ deviceId: DEVICE, topology: 'root' });
    const rels = store.queryRelationships(sub.id);
    const spawned = rels.find((r) => r.relationType === 'spawned_by' && r.direction === 'outgoing');
    expect(spawned).toBeDefined();
    expect(spawned!.toSessionId).toBe(roots[0]!.id);
  });

  // ── 验收门 3：injected=true 排除 ───────────────────────────────────────

  it('injected=true 的系统注入消息被排除', () => {
    const dir = makeSessionDir(tmpRoot, 'session_20260713_010000_a1b2c3d4');
    writeMeta(dir, rootMeta());
    writeMessages(dir, [
      { role: 'user', content: 'real user msg', injected: false, message_id: 'm1' },
      { role: 'user', content: 'system injected context', injected: true, message_id: 'm2' }, // 排除
      { role: 'assistant', content: 'reply', injected: false, message_id: 'm3' },
    ]);

    new VibeImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getMessages(s.id).map((m) => m.content)).toEqual([
      'real user msg',
      'reply',
    ]);
  });

  // ── 验收门 4：重复扫描幂等 ─────────────────────────────────────────────

  it('相同内容重复扫描幂等：计入 unchanged', () => {
    const dir = makeSessionDir(tmpRoot, 'session_20260713_010000_a1b2c3d4');
    writeMeta(dir, rootMeta());
    writeMessages(dir, [
      { role: 'user', content: 'hi', injected: false, message_id: 'm1' },
      { role: 'assistant', content: 'ok', injected: false, message_id: 'm2' },
    ]);

    const importer = new VibeImporter(store, { rootPath: tmpRoot, deviceId: DEVICE });
    importer.import();
    const second = importer.import();
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  // ── 验收门 5：无 messages.jsonl 跳过 ───────────────────────────────────

  it('无 messages.jsonl 的目录被跳过', () => {
    const dir = makeSessionDir(tmpRoot, 'session_20260713_010000_a1b2c3d4');
    writeMeta(dir, rootMeta());
    // 不写 messages.jsonl

    const stats = new VibeImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    expect(stats.scanned).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.inserted).toBe(0);
  });

  // ── 验收门 6：native id 回退到目录名 ───────────────────────────────────

  it('meta 缺 session_id 时用目录名作 native id', () => {
    const dirName = 'session_20260713_010000_a1b2c3d4';
    const dir = makeSessionDir(tmpRoot, dirName);
    // meta 无 session_id
    writeMeta(dir, { start_time: '2026-07-13T01:00:00Z', environment: { working_directory: CWD } });
    writeMessages(dir, [
      { role: 'user', content: 'hi', injected: false, message_id: 'm1' },
      { role: 'assistant', content: 'ok', injected: false, message_id: 'm2' },
    ]);

    new VibeImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(s.nativeSessionId).toBe(dirName);
  });

  // ── 验收门 7：unlinked subagent（父未入库）─────────────────────────────

  it('父 session 未入库时 subagent 计入 unlinkedSubagents，不写关系', () => {
    const subDir = makeSessionDir(tmpRoot, 'session_20260713_020000_e5f6g7h8');
    writeMeta(subDir, {
      session_id: SUB_SESSION_ID,
      parent_session_id: 'nonexistent-parent',
      start_time: '2026-07-13T02:00:00Z',
      environment: { working_directory: CWD },
    });
    writeMessages(subDir, [
      { role: 'user', content: 'sub', injected: false, message_id: 's1' },
      { role: 'assistant', content: 'reply', injected: false, message_id: 's2' },
    ]);

    const stats = new VibeImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    expect(stats.subagents).toBe(1);
    expect(stats.unlinkedSubagents).toBe(1);
    expect(stats.relationships).toBe(0);
  });

  // ── 验收门 8：不可读根目录 ─────────────────────────────────────────────

  it('rootPath 不存在时抛出明确错误', () => {
    const importer = new VibeImporter(store, {
      rootPath: path.join(tmpRoot, 'does-not-exist'),
      deviceId: DEVICE,
    });
    expect(() => importer.import()).toThrowError(/vibe|sessions|目录|read/i);
  });

  // ── 默认路径解析 ───────────────────────────────────────────────────────

  describe('resolveVibeSessionsPath', () => {
    it('rootPath 选项优先', () => {
      expect(resolveVibeSessionsPath({ rootPath: '/explicit/vibe' })).toBe('/explicit/vibe');
    });

    it('无 rootPath 时回退默认 ~/.vibe/logs/session', () => {
      expect(resolveVibeSessionsPath()).toBe(path.join(os.homedir(), '.vibe', 'logs', 'session'));
    });
  });
});

// ─── wrapper 契约 ────────────────────────────────────────────────────────

describe('Vibe wrapper', () => {
  it('detectVibe 返回结构良好（installed 为 boolean；已安装时 version 为字符串）', () => {
    const d = detectVibe();
    expect(typeof d.installed).toBe('boolean');
    expect(typeof d.homeExists).toBe('boolean');
    expect(typeof d.sessionsDirExists).toBe('boolean');
    // 若已安装，binary 与 version 必须存在
    if (d.installed) {
      expect(d.binary).toBe('vibe');
      expect(typeof d.version).toBe('string');
      expect(d.version!.length).toBeGreaterThan(0);
    }
  });

  it('vibeResumeArgs 构造续接参数', () => {
    expect(vibeResumeArgs('sid')).toEqual(['--resume', 'sid']);
    expect(vibeResumeArgs('sid', CWD)).toEqual(['--resume', 'sid', '--workdir', CWD]);
  });

  it('VIBE_HOME 指向 ~/.vibe', () => {
    expect(VIBE_HOME).toBe(path.join(os.homedir(), '.vibe'));
  });
});

// ─── mcp-toml-array 策略 ─────────────────────────────────────────────────

describe('mcp-toml-array 策略', () => {
  let tmpConfig: string;

  beforeEach(() => {
    tmpConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-toml-')), 'config.toml');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(tmpConfig), { recursive: true, force: true });
  });

  const ext: Extension = {
    type: 'mcp-server',
    name: 'yondermesh',
    mcp: { command: 'node', args: ['ymesh', 'mcp'] },
  };

  it('mount 写入 [[mcp_servers]] 块到 config.toml', () => {
    const result = mcpTomlArrayStrategy.mount(ext, tmpConfig);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(tmpConfig, 'utf-8');
    expect(content).toContain('[[mcp_servers]]');
    expect(content).toContain('name = "yondermesh"');
  });

  it('isMounted 检测已写入的块', () => {
    mcpTomlArrayStrategy.mount(ext, tmpConfig);
    expect(mcpTomlArrayStrategy.isMounted('yondermesh', tmpConfig)).toBe(true);
    expect(mcpTomlArrayStrategy.isMounted('nonexistent', tmpConfig)).toBe(false);
  });

  it('unmount 移除已写入的块', () => {
    mcpTomlArrayStrategy.mount(ext, tmpConfig);
    const result = mcpTomlArrayStrategy.unmount('yondermesh', tmpConfig);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(tmpConfig, 'utf-8');
    expect(content).not.toContain('yondermesh');
  });

  it('mount 幂等：重复挂载不产生重复块', () => {
    mcpTomlArrayStrategy.mount(ext, tmpConfig);
    mcpTomlArrayStrategy.mount(ext, tmpConfig);
    const content = fs.readFileSync(tmpConfig, 'utf-8');
    const matches = content.match(/\[\[mcp_servers\]\]/g);
    expect(matches).toHaveLength(1);
  });

  it('保留已有顶层 scalar 与 [[providers]]/[[models]] 段（TOML 顺序陷阱安全）', () => {
    // 模拟真实 Vibe config.toml：顶层 scalar + [[providers]] + [[models]]
    fs.writeFileSync(tmpConfig, [
      'theme = "dark"',
      '',
      '[[providers]]',
      'name = "openai"',
      '',
      '[[models]]',
      'name = "gpt-4"',
    ].join('\n') + '\n', 'utf-8');

    mcpTomlArrayStrategy.mount(ext, tmpConfig);
    const content = fs.readFileSync(tmpConfig, 'utf-8');
    // 顶层 scalar 仍在 [[...]] 之前
    expect(content.indexOf('theme = "dark"')).toBeLessThan(content.indexOf('[[providers]]'));
    expect(content.indexOf('theme = "dark"')).toBeLessThan(content.indexOf('[[mcp_servers]]'));
    // [[mcp_servers]] 追加到末尾
    expect(content.indexOf('[[models]]')).toBeLessThan(content.indexOf('[[mcp_servers]]'));
  });
});

// ─── inject 契约 ─────────────────────────────────────────────────────────

describe('Vibe inject', () => {
  it('vibeHooksContent 生成 [[hooks]] TOML array', () => {
    const content = vibeHooksContent();
    expect(content).toContain('[[hooks]]');
    expect(content).toContain('post_agent_turn');
  });

  it('buildVibeExtensions 返回 mcp-server / skill / plugin 三类', () => {
    const exts = buildVibeExtensions();
    const types = exts.map((e) => e.type);
    expect(types).toContain('mcp-server');
    expect(types).toContain('skill');
    expect(types).toContain('plugin');
  });
});
