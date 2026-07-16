/**
 * Crush 注入器测试
 *
 * 验证 MCP / Skills / Always-on / Hook 注入的幂等往返：
 *   - MCP：crush.json 的 `mcp` 键写入 / 检测 / 移除
 *   - Skills：~/.agents/skills/<name> symlink 创建 / 检测 / 移除
 *   - Always-on：CRUSH.md 边界标记段落写入 / 检测 / 移除（含幂等替换）
 *   - Hook：crush.json 的 hooks.<event> 数组写入 / 检测 / 移除（按 name 去重）
 *   - mountAll / unmountAll 端到端往返
 *
 * 注意：CrushInjector 的 Skills 落点是 ~/.agents/skills/，该路径在 inject.ts 模块
 * 加载时从 process.env.HOME 计算，无法通过构造器选项覆盖。为避免与真实 skills 冲突，
 * 测试使用带随机后缀的唯一 skill 名称，并在 afterEach 中清理。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CrushInjector,
  resolveCrushJsonPath,
  resolveCrushMdPath,
} from '../src/crush/index.js';
import type { CrushHookDef } from '../src/crush/index.js';
import { CONTEXT_BLOCK_START, CONTEXT_BLOCK_END } from '../src/mount/types.js';

/** 生成唯一 skill 名称，避免与真实 ~/.agents/skills/ 下的条目冲突 */
function uniqueSkillName(base: string): string {
  return `ymesh-test-${base}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

describe('Crush 注入器', () => {
  let tmpConfigDir: string;
  let tmpHome: string;
  let inj: CrushInjector;
  /** 收集本测试创建的 skill 名称，afterEach 中强制清理 */
  const createdSkillNames: string[] = [];

  beforeEach(() => {
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-inj-cfg-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-inj-home-'));
    createdSkillNames.length = 0;
    inj = new CrushInjector({ configDir: tmpConfigDir });
  });

  afterEach(() => {
    // 强制清理可能残留在真实 ~/.agents/skills/ 下的测试 skill symlink
    const agentsSkillsDir = path.join(process.env.HOME ?? os.homedir(), '.agents', 'skills');
    for (const name of createdSkillNames) {
      try {
        const p = path.join(agentsSkillsDir, name);
        fs.rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
    try { fs.rmSync(tmpConfigDir, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  // ── MCP ────────────────────────────────────────────────────────────────

  it('MCP 注入 / 检测 / 移除幂等（crush.json mcp 键，含 type=stdio + timeout）', () => {
    expect(inj.isMcpMounted('yondermesh')).toBe(false);

    const r1 = inj.injectMcp('yondermesh', {
      command: 'ymesh',
      args: ['mcp', 'serve'],
    });
    expect(r1.success).toBe(true);
    expect(r1.kind).toBe('mcp');
    expect(inj.isMcpMounted('yondermesh')).toBe(true);

    // 重复注入覆盖
    const r2 = inj.injectMcp('yondermesh', {
      command: 'ymesh2',
      args: ['mcp', 'serve', '--port', '3000'],
      timeout: 60,
      env: { LOG_LEVEL: 'debug' },
    });
    expect(r2.success).toBe(true);

    const configPath = resolveCrushJsonPath({ configDir: tmpConfigDir });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.mcp.yondermesh.type).toBe('stdio');
    expect(config.mcp.yondermesh.command).toBe('ymesh2');
    expect(config.mcp.yondermesh.args).toEqual(['mcp', 'serve', '--port', '3000']);
    expect(config.mcp.yondermesh.timeout).toBe(60);
    expect(config.mcp.yondermesh.env).toEqual({ LOG_LEVEL: 'debug' });

    // 移除
    const r3 = inj.removeMcp('yondermesh');
    expect(r3.success).toBe(true);
    expect(inj.isMcpMounted('yondermesh')).toBe(false);

    // 再次移除幂等
    const r4 = inj.removeMcp('yondermesh');
    expect(r4.success).toBe(true);
  });

  it('MCP env 为空时不写 env 键；timeout 默认 30', () => {
    inj.injectMcp('noenv', { command: 'x', args: [] });
    const configPath = resolveCrushJsonPath({ configDir: tmpConfigDir });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.mcp.noenv.command).toBe('x');
    expect(config.mcp.noenv.timeout).toBe(30);
    expect(config.mcp.noenv.env).toBeUndefined();
  });

  // ── Skills ─────────────────────────────────────────────────────────────

  it('Skill symlink 创建 / 检测 / 移除（~/.agents/skills/ 共享目录）', () => {
    const skillName = uniqueSkillName('my-skill');
    createdSkillNames.push(skillName);
    const skillSource = path.join(tmpHome, 'my-skill-src');
    fs.mkdirSync(skillSource, { recursive: true });
    fs.writeFileSync(path.join(skillSource, 'SKILL.md'), '# my skill\n', 'utf8');

    expect(inj.isSkillMounted(skillName)).toBe(false);

    const r1 = inj.injectSkill(skillName, skillSource);
    expect(r1.success).toBe(true);
    expect(inj.isSkillMounted(skillName)).toBe(true);

    // 重新注入覆盖旧 symlink
    const r2 = inj.injectSkill(skillName, skillSource);
    expect(r2.success).toBe(true);

    // symlink 确实指向 skillSource（macOS 上 /var 是 /private/var 的 symlink，需两边都 realpath）
    const linkPath = path.join(process.env.HOME ?? os.homedir(), '.agents', 'skills', skillName);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(skillSource));

    // 移除
    const r3 = inj.removeSkill(skillName);
    expect(r3.success).toBe(true);
    expect(inj.isSkillMounted(skillName)).toBe(false);

    // 再次移除幂等
    const r4 = inj.removeSkill(skillName);
    expect(r4.success).toBe(true);
  });

  // ── Always-on ──────────────────────────────────────────────────────────

  it('Always-on 段落写入 / 检测 / 移除（CRUSH.md 边界标记 + 幂等替换）', () => {
    const mdPath = resolveCrushMdPath({ configDir: tmpConfigDir });
    expect(inj.isAlwaysOnMounted()).toBe(false);

    // 先写一些已有内容
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, '# My Crush Rules\n\nBe concise.\n', 'utf8');

    const block1 = 'yondermesh 已就位，MCP 工具可用。';
    const r1 = inj.injectAlwaysOn(block1);
    expect(r1.success).toBe(true);
    expect(inj.isAlwaysOnMounted()).toBe(true);

    let content = fs.readFileSync(mdPath, 'utf8');
    expect(content).toContain(CONTEXT_BLOCK_START);
    expect(content).toContain(CONTEXT_BLOCK_END);
    expect(content).toContain(block1);
    expect(content).toContain('Be concise.');

    // 重复注入替换（不堆积）
    const block2 = 'yondermesh v2 已就位。';
    const r2 = inj.injectAlwaysOn(block2);
    expect(r2.success).toBe(true);

    content = fs.readFileSync(mdPath, 'utf8');
    expect(content).toContain(block2);
    expect(content).not.toContain(block1);
    expect(content.split(CONTEXT_BLOCK_START).length - 1).toBe(1);
    expect(content.split(CONTEXT_BLOCK_END).length - 1).toBe(1);

    // 移除
    const r3 = inj.removeAlwaysOn();
    expect(r3.success).toBe(true);
    expect(inj.isAlwaysOnMounted()).toBe(false);

    content = fs.readFileSync(mdPath, 'utf8');
    expect(content).not.toContain(CONTEXT_BLOCK_START);
    expect(content).not.toContain(block2);
    expect(content).toContain('Be concise.');
  });

  // ── Hook（PreToolUse，Claude Code 兼容） ─────────────────────────────────

  it('Hook 注入 / 检测 / 移除幂等（按 name 去重）', () => {
    const hook: CrushHookDef = {
      name: 'ymesh-audit',
      matcher: '^bash$',
      command: 'ymesh audit --tool "$TOOL_NAME"',
    };

    expect(inj.isHookMounted('PreToolUse', 'ymesh-audit')).toBe(false);

    const r1 = inj.injectHook('PreToolUse', hook);
    expect(r1.success).toBe(true);
    expect(r1.kind).toBe('hook');
    expect(inj.isHookMounted('PreToolUse', 'ymesh-audit')).toBe(true);

    // 重复注入覆盖（按 name 去重，不堆积）
    const hook2: CrushHookDef = {
      name: 'ymesh-audit',
      matcher: '^bash$|^grep$',
      command: 'ymesh audit v2',
    };
    const r2 = inj.injectHook('PreToolUse', hook2);
    expect(r2.success).toBe(true);

    const configPath = resolveCrushJsonPath({ configDir: tmpConfigDir });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const hooks = config.hooks.PreToolUse as Array<Record<string, unknown>>;
    const auditHooks = hooks.filter((h) => h.name === 'ymesh-audit');
    expect(auditHooks).toHaveLength(1); // 去重后只 1 条
    expect(auditHooks[0]!.command).toBe('ymesh audit v2');
    expect(auditHooks[0]!.matcher).toBe('^bash$|^grep$');

    // 移除
    const r3 = inj.removeHook('PreToolUse', 'ymesh-audit');
    expect(r3.success).toBe(true);
    expect(inj.isHookMounted('PreToolUse', 'ymesh-audit')).toBe(false);

    // 移除后 hooks.PreToolUse 数组为空时键被清理
    const config2 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config2.hooks?.PreToolUse ?? []).toHaveLength(0);
  });

  it('不同 name 的 hook 共存，互不影响', () => {
    inj.injectHook('PreToolUse', { name: 'hook-a', command: 'cmd-a' });
    inj.injectHook('PreToolUse', { name: 'hook-b', command: 'cmd-b' });

    expect(inj.isHookMounted('PreToolUse', 'hook-a')).toBe(true);
    expect(inj.isHookMounted('PreToolUse', 'hook-b')).toBe(true);

    // 移除 a 不影响 b
    inj.removeHook('PreToolUse', 'hook-a');
    expect(inj.isHookMounted('PreToolUse', 'hook-a')).toBe(false);
    expect(inj.isHookMounted('PreToolUse', 'hook-b')).toBe(true);
  });

  it('无 matcher 的 hook 不写 matcher 键', () => {
    inj.injectHook('PreToolUse', { name: 'no-matcher', command: 'cmd' });
    const configPath = resolveCrushJsonPath({ configDir: tmpConfigDir });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const entry = (config.hooks.PreToolUse as Array<Record<string, unknown>>).find((h) => h.name === 'no-matcher');
    expect(entry).toBeDefined();
    expect(entry!.matcher).toBeUndefined();
  });

  // ── mountAll / unmountAll ──────────────────────────────────────────────

  it('mountAll / unmountAll 端到端往返（MCP + Skills + Always-on + Hooks）', () => {
    const skillName = uniqueSkillName('batch-skill');
    createdSkillNames.push(skillName);
    const skillSource = path.join(tmpHome, 'batch-skill');
    fs.mkdirSync(skillSource, { recursive: true });

    const results = inj.mountAll({
      mcp: { name: 'ymesh-mcp', server: { command: 'ymesh', args: ['mcp'] } },
      skills: [{ name: skillName, path: skillSource }],
      contextBlock: 'batch always-on',
      hooks: [{ event: 'PreToolUse', hook: { name: 'batch-hook', command: 'cmd' } }],
    });
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.success)).toBe(true);

    expect(inj.isMcpMounted('ymesh-mcp')).toBe(true);
    expect(inj.isSkillMounted(skillName)).toBe(true);
    expect(inj.isAlwaysOnMounted()).toBe(true);
    expect(inj.isHookMounted('PreToolUse', 'batch-hook')).toBe(true);

    const rmResults = inj.unmountAll({
      mcpName: 'ymesh-mcp',
      skillNames: [skillName],
      alwaysOn: true,
      hooks: [{ event: 'PreToolUse', name: 'batch-hook' }],
    });
    expect(rmResults).toHaveLength(4);
    expect(rmResults.every((r) => r.success)).toBe(true);

    expect(inj.isMcpMounted('ymesh-mcp')).toBe(false);
    expect(inj.isSkillMounted(skillName)).toBe(false);
    expect(inj.isAlwaysOnMounted()).toBe(false);
    expect(inj.isHookMounted('PreToolUse', 'batch-hook')).toBe(false);
  });

  // ── 路径解析 ───────────────────────────────────────────────────────────

  it('resolveCrushJsonPath / resolveCrushMdPath 使用 configDir', () => {
    expect(resolveCrushJsonPath({ configDir: tmpConfigDir })).toBe(
      path.join(tmpConfigDir, 'crush.json'),
    );
    expect(resolveCrushMdPath({ configDir: tmpConfigDir })).toBe(
      path.join(tmpConfigDir, 'CRUSH.md'),
    );
  });

  it('resolveCrushJsonPath：configPath 选项优先于 configDir', () => {
    expect(resolveCrushJsonPath({ configPath: '/explicit/crush.json' })).toBe('/explicit/crush.json');
  });
});
