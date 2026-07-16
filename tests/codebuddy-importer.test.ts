/**
 * WorkBuddy / CodeBuddy 原生 adapter 契约测试
 *
 * 覆盖：
 *   1. 嵌套格式解析（type=message, message.role, message.content[]）
 *   2. 扁平格式解析（role/content 顶层）
 *   3. 排除 local_storage/code-ratio/plugins/marketplaces 目录
 *   4. 重复扫描幂等
 *   5. 无有效消息跳过
 *   6. native id 回退
 *   7. wrapper detect / resume args
 *   8. 9 hooks × 4 类型（SessionStart/PreToolUse/PostToolUse/Stop）
 *   9. source 别名归一化（factory/vibe/codebuddy）
 *  10. registry CliTarget 注册
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import {
  CodeBuddyImporter,
  resolveCodeBuddyPath,
  detectCodeBuddy,
  cbcResumeArgs,
  codeBuddyHooksContent,
  codeBuddyHookTypes,
  buildCodeBuddyExtensions,
  CODEBUDDY_HOME,
} from '../src/codebuddy/index.js';
import type { CodeBuddyHookType } from '../src/codebuddy/index.js';
import { normalizeSource, expandSource } from '../src/store/source-aliases.js';
import { findCli, CLI_REGISTRY } from '../src/mount/registry.js';

const DEVICE = 'mac-test';
const SESSION_ID = 'cb-0001';
const CWD = '/Users/zoran/Documents/projects/demo';

function writeJsonl(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
}

describe('WorkBuddy / CodeBuddy 原生 adapter', () => {
  let tmpRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-test-'));
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── 验收门 1：嵌套格式解析 ─────────────────────────────────────────────

  it('导入嵌套格式 session（type=message, message.content[]），thinking/tool_use 排除', () => {
    const file = path.join(tmpRoot, 'proj', `${SESSION_ID}.jsonl`);
    writeJsonl(file, [
      { type: 'summary', summary: 'demo', cwd: CWD, version: '2.106.4', session_id: SESSION_ID },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello codebuddy' }] } },
      { type: 'message', message: { role: 'assistant', content: [
        { type: 'thinking', text: 'CoT' },     // 排除
        { type: 'text', text: 'cb reply' },     // 保留
        { type: 'tool_use', name: 'Read' },     // 排除
      ] } },
    ]);

    const stats = new CodeBuddyImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);

    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst!.source).toBe('codebuddy');
    expect(inst!.coverage).toBe('A');

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(s.topology).toBe('root');
    expect(s.nativeSessionId).toBe(SESSION_ID);
    expect(s.source).toBe('codebuddy');
    expect(s.cwd).toBe(CWD);
    expect(s.cliVersion).toBe('2.106.4');

    expect(store.getMessages(s.id).map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello codebuddy'],
      ['assistant', 'cb reply'],
    ]);
  });

  // ── 验收门 2：扁平格式解析 ─────────────────────────────────────────────

  it('导入扁平格式 session（role/content 顶层字符串）', () => {
    const file = path.join(tmpRoot, 'proj', `flat.jsonl`);
    writeJsonl(file, [
      { role: 'user', content: 'flat user msg' },
      { role: 'assistant', content: 'flat assistant reply' },
    ]);

    new CodeBuddyImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getMessages(s.id).map((m) => [m.role, m.content])).toEqual([
      ['user', 'flat user msg'],
      ['assistant', 'flat assistant reply'],
    ]);
  });

  // ── 验收门 3：排除 local_storage 等目录 ────────────────────────────────

  it('排除 local_storage/ code-ratio/ plugins/ marketplaces/ 目录', () => {
    // 真实 session
    writeJsonl(path.join(tmpRoot, 'proj', `${SESSION_ID}.jsonl`), [
      { type: 'message', message: { role: 'user', content: 'real' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } },
    ]);
    // local_storage 下的 .jsonl（应排除）
    writeJsonl(path.join(tmpRoot, 'local_storage', 'entry.info.jsonl'), [
      { role: 'user', content: 'product config noise' },
    ]);
    // code-ratio 下的 .jsonl（应排除）
    writeJsonl(path.join(tmpRoot, 'code-ratio', 'state.jsonl'), [
      { role: 'user', content: 'git watcher noise' },
    ]);
    // plugins 下的 .jsonl（应排除）
    writeJsonl(path.join(tmpRoot, 'plugins', 'p.jsonl'), [
      { role: 'user', content: 'plugin noise' },
    ]);

    const stats = new CodeBuddyImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    const nativeIds = store.querySessions({ deviceId: DEVICE }).map((s) => s.nativeSessionId);
    expect(nativeIds).not.toContain('entry.info');
    expect(nativeIds).not.toContain('state');
    expect(nativeIds).not.toContain('p');
  });

  // ── 验收门 4：重复扫描幂等 ─────────────────────────────────────────────

  it('相同内容重复扫描幂等：计入 unchanged', () => {
    const file = path.join(tmpRoot, 'proj', `${SESSION_ID}.jsonl`);
    writeJsonl(file, [
      { type: 'message', message: { role: 'user', content: 'hi' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]);

    const importer = new CodeBuddyImporter(store, { rootPath: tmpRoot, deviceId: DEVICE });
    importer.import();
    const second = importer.import();
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  // ── 验收门 5：无有效消息跳过 ───────────────────────────────────────────

  it('无有效消息的 session 被跳过', () => {
    const file = path.join(tmpRoot, 'proj', `empty.jsonl`);
    writeJsonl(file, [
      { type: 'mode', mode: 'normal' },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', text: 'only thinking' }] } },
    ]);

    const stats = new CodeBuddyImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    expect(stats.scanned).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.inserted).toBe(0);
  });

  // ── 验收门 6：native id 回退到文件名 ───────────────────────────────────

  it('缺 session_id 时用文件名作 native id', () => {
    const file = path.join(tmpRoot, 'proj', `fallback-name.jsonl`);
    writeJsonl(file, [
      { type: 'message', message: { role: 'user', content: 'hi' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } },
    ]);

    new CodeBuddyImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(s.nativeSessionId).toBe('fallback-name');
  });

  // ── 验收门 7：不可读根目录 ─────────────────────────────────────────────

  it('rootPath 不存在时抛出明确错误', () => {
    const importer = new CodeBuddyImporter(store, {
      rootPath: path.join(tmpRoot, 'does-not-exist'),
      deviceId: DEVICE,
    });
    expect(() => importer.import()).toThrowError(/codebuddy|目录|read/i);
  });

  // ── 默认路径解析 ───────────────────────────────────────────────────────

  describe('resolveCodeBuddyPath', () => {
    it('rootPath 选项优先', () => {
      expect(resolveCodeBuddyPath({ rootPath: '/explicit/cb' })).toBe('/explicit/cb');
    });

    it('无 rootPath 时回退默认 ~/.codebuddy', () => {
      expect(resolveCodeBuddyPath()).toBe(path.join(os.homedir(), '.codebuddy'));
    });
  });
});

// ─── wrapper 契约 ────────────────────────────────────────────────────────

describe('CodeBuddy wrapper', () => {
  it('detectCodeBuddy 在 cbc 未安装时 graceful 返回 installed=false', () => {
    const d = detectCodeBuddy();
    expect(d.installed).toBe(false);
    expect(typeof d.homeExists).toBe('boolean');
  });

  it('cbcResumeArgs 构造续接参数', () => {
    expect(cbcResumeArgs('sid')).toEqual(['--resume', 'sid']);
    expect(cbcResumeArgs('sid', CWD)).toEqual(['--resume', 'sid', '--cwd', CWD]);
  });

  it('CODEBUDDY_HOME 指向 ~/.codebuddy', () => {
    expect(CODEBUDDY_HOME).toBe(path.join(os.homedir(), '.codebuddy'));
  });
});

// ─── 9 hooks × 4 类型 ────────────────────────────────────────────────────

describe('CodeBuddy 9 hooks × 4 类型', () => {
  it('codeBuddyHookTypes 返回 4 种事件类型', () => {
    const types = codeBuddyHookTypes();
    expect(types).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']);
  });

  it('codeBuddyHooksContent 生成 9 hooks，4 类型完整覆盖', () => {
    const content = codeBuddyHooksContent();
    const parsed = JSON.parse(content) as {
      hooks: Record<CodeBuddyHookType, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
    };

    // 4 类型都存在
    expect(parsed.hooks.SessionStart).toBeDefined();
    expect(parsed.hooks.PreToolUse).toBeDefined();
    expect(parsed.hooks.PostToolUse).toBeDefined();
    expect(parsed.hooks.Stop).toBeDefined();

    // 统计 hooks 总数：每个 entry 的 hooks 数组长度之和
    const countHooks = (entries: typeof parsed.hooks.SessionStart): number =>
      entries.reduce((sum, e) => sum + e.hooks.length, 0);

    const sessionStartCount = countHooks(parsed.hooks.SessionStart);
    const preToolUseCount = countHooks(parsed.hooks.PreToolUse);
    const postToolUseCount = countHooks(parsed.hooks.PostToolUse);
    const stopCount = countHooks(parsed.hooks.Stop);
    const total = sessionStartCount + preToolUseCount + postToolUseCount + stopCount;

    // 分布：SessionStart × 2, PreToolUse × 2, PostToolUse × 2, Stop × 3
    expect(sessionStartCount).toBe(2);
    expect(preToolUseCount).toBe(2);
    expect(postToolUseCount).toBe(2);
    expect(stopCount).toBe(3);
    expect(total).toBe(9);
  });

  it('SessionStart hooks 写 .codebuddy-session-start 状态文件（覆盖"启"）', () => {
    const content = codeBuddyHooksContent();
    const parsed = JSON.parse(content) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const sessionStartCmds = parsed.hooks.SessionStart
      .flatMap((e) => e.hooks.map((h) => h.command))
      .join('\n');
    expect(sessionStartCmds).toContain('.codebuddy-session-start');
  });

  it('Stop hooks 写 .codebuddy-session-stop 状态文件（覆盖"停"）', () => {
    const content = codeBuddyHooksContent();
    const parsed = JSON.parse(content) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const stopCmds = parsed.hooks.Stop
      .flatMap((e) => e.hooks.map((h) => h.command))
      .join('\n');
    expect(stopCmds).toContain('.codebuddy-session-stop');
  });

  it('PreToolUse hooks 覆盖 Read/Write 两个 matcher', () => {
    const content = codeBuddyHooksContent();
    const parsed = JSON.parse(content) as { hooks: Record<string, Array<{ matcher: string; hooks: unknown[] }>> };
    const matchers = parsed.hooks.PreToolUse.map((e) => e.matcher);
    expect(matchers).toContain('Read');
    expect(matchers).toContain('Write');
  });

  it('buildCodeBuddyExtensions 返回 mcp-server / skill / plugin 三类', () => {
    const exts = buildCodeBuddyExtensions();
    const types = exts.map((e) => e.type);
    expect(types).toContain('mcp-server');
    expect(types).toContain('skill');
    expect(types).toContain('plugin');
  });
});

// ─── source 别名归一化 ───────────────────────────────────────────────────

describe('source 别名归一化（factory / vibe / codebuddy）', () => {
  it('factory 别名归一化', () => {
    expect(normalizeSource('factory')).toBe('factory');
    expect(normalizeSource('factory_droid')).toBe('factory');
    expect(normalizeSource('factory-droid')).toBe('factory');
    expect(normalizeSource('droid')).toBe('factory');
    expect(normalizeSource('FACTORY')).toBe('factory');
  });

  it('vibe 别名归一化', () => {
    expect(normalizeSource('vibe')).toBe('vibe');
    expect(normalizeSource('VIBE')).toBe('vibe');
  });

  it('codebuddy 别名归一化', () => {
    expect(normalizeSource('codebuddy')).toBe('codebuddy');
    expect(normalizeSource('cbc')).toBe('codebuddy');
    expect(normalizeSource('workbuddy')).toBe('codebuddy');
    expect(normalizeSource('CODEBUDDY')).toBe('codebuddy');
  });

  it('expandSource: factory 展开包含所有别名', () => {
    const aliases = expandSource('factory');
    expect(aliases).toContain('factory');
    expect(aliases).toContain('factory_droid');
    expect(aliases).toContain('factory-droid');
    expect(aliases).toContain('droid');
  });

  it('expandSource: codebuddy 展开包含 cbc / workbuddy', () => {
    const aliases = expandSource('codebuddy');
    expect(aliases).toContain('codebuddy');
    expect(aliases).toContain('cbc');
    expect(aliases).toContain('workbuddy');
  });

  it('expandSource: vibe 只返回自身', () => {
    expect(expandSource('vibe')).toEqual(['vibe']);
  });
});

// ─── registry CliTarget 注册 ─────────────────────────────────────────────

describe('mount registry 注册（factory / vibe / codebuddy）', () => {
  it('findCli("factory") 返回带 mcp-json/skill-symlink/always-on 三策略的 target', () => {
    const cli = findCli('factory');
    expect(cli).toBeDefined();
    expect(cli!.displayName).toContain('Factory');
    expect(cli!.homeDir).toBe('.factory');
    const strategies = cli!.capabilities.map((c) => c.strategy);
    expect(strategies).toContain('mcp-json');
    expect(strategies).toContain('skill-symlink');
    expect(strategies).toContain('always-on');
  });

  it('findCli("vibe") 返回带 mcp-toml-array 策略的 target', () => {
    const cli = findCli('vibe');
    expect(cli).toBeDefined();
    expect(cli!.homeDir).toBe('.vibe');
    const strategies = cli!.capabilities.map((c) => c.strategy);
    expect(strategies).toContain('mcp-toml-array');
    expect(strategies).toContain('skill-symlink');
    expect(strategies).toContain('always-on');
  });

  it('findCli("codebuddy") 返回带 mcp-json 策略的 target', () => {
    const cli = findCli('codebuddy');
    expect(cli).toBeDefined();
    expect(cli!.displayName).toContain('CodeBuddy');
    expect(cli!.homeDir).toBe('.codebuddy');
    const strategies = cli!.capabilities.map((c) => c.strategy);
    expect(strategies).toContain('mcp-json');
    expect(strategies).toContain('skill-symlink');
    expect(strategies).toContain('always-on');
  });

  it('CLI_REGISTRY 至少包含 factory / vibe / codebuddy 三个 id', () => {
    const ids = CLI_REGISTRY.map((c) => c.id);
    expect(ids).toContain('factory');
    expect(ids).toContain('vibe');
    expect(ids).toContain('codebuddy');
  });
});
