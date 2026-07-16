/**
 * Cline 注入器测试
 *
 * 验证 MCP / Skills / Always-on 注入的幂等往返：
 *   - MCP：cline_mcp_settings.json 中 mcpServers.{name} 的写入 / 检测 / 移除
 *   - Skills：symlink 创建 / 检测 / 移除（cline 目录优先，回退共享 ~/.agents/skills/）
 *   - Always-on：.clinerules 边界标记段落写入 / 检测 / 移除（含幂等替换）
 *   - mountAll / unmountAll 端到端往返
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ClineInjector,
  resolveClineMcpSettingsPath,
  resolveClineSkillsDir,
  resolveClineRulesPath,
} from '../src/cline/index.js';
import { CONTEXT_BLOCK_START, CONTEXT_BLOCK_END } from '../src/mount/types.js';

describe('Cline 注入器', () => {
  let tmpDataDir: string;
  let inj: ClineInjector;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-inj-'));
    inj = new ClineInjector({ dataDir: tmpDataDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── MCP ────────────────────────────────────────────────────────────────

  it('MCP 注入 / 检测 / 移除幂等', () => {
    expect(inj.isMcpMounted('yondermesh')).toBe(false);

    const r1 = inj.injectMcp('yondermesh', {
      command: 'ymesh',
      args: ['mcp', 'serve'],
    });
    expect(r1.success).toBe(true);
    expect(r1.kind).toBe('mcp');
    expect(inj.isMcpMounted('yondermesh')).toBe(true);

    // 重复注入覆盖（幂等：先 remove 再 add）
    const r2 = inj.injectMcp('yondermesh', {
      command: 'ymesh2',
      args: ['mcp', 'serve', '--port', '3000'],
      env: { LOG_LEVEL: 'debug' },
    });
    expect(r2.success).toBe(true);

    const configPath = resolveClineMcpSettingsPath({ dataDir: tmpDataDir });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.mcpServers.yondermesh.command).toBe('ymesh2');
    expect(config.mcpServers.yondermesh.args).toEqual(['mcp', 'serve', '--port', '3000']);
    expect(config.mcpServers.yondermesh.env).toEqual({ LOG_LEVEL: 'debug' });

    // 移除
    const r3 = inj.removeMcp('yondermesh');
    expect(r3.success).toBe(true);
    expect(inj.isMcpMounted('yondermesh')).toBe(false);

    // 再次移除幂等
    const r4 = inj.removeMcp('yondermesh');
    expect(r4.success).toBe(true);
  });

  it('MCP env 为空时不写 env 键', () => {
    inj.injectMcp('noenv', { command: 'x', args: [] });
    const configPath = resolveClineMcpSettingsPath({ dataDir: tmpDataDir });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.mcpServers.noenv.command).toBe('x');
    expect(config.mcpServers.noenv.env).toBeUndefined();
  });

  // ── Skills ─────────────────────────────────────────────────────────────

  it('Skill symlink 创建 / 检测 / 移除（cline 本地目录）', () => {
    const skillSource = path.join(tmpDataDir, 'my-skill-src');
    fs.mkdirSync(skillSource, { recursive: true });
    fs.writeFileSync(path.join(skillSource, 'SKILL.md'), '# my skill\n', 'utf8');

    expect(inj.isSkillMounted('my-skill')).toBe(false);

    const r1 = inj.injectSkill('my-skill', skillSource);
    expect(r1.success).toBe(true);
    expect(inj.isSkillMounted('my-skill')).toBe(true);

    // 重新注入覆盖旧 symlink
    const r2 = inj.injectSkill('my-skill', skillSource);
    expect(r2.success).toBe(true);

    // symlink 确实指向 skillSource（macOS 上 /var 是 /private/var 的 symlink，需两边都 realpath）
    const linkPath = path.join(resolveClineSkillsDir({ dataDir: tmpDataDir }), 'my-skill');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(skillSource));

    // 移除
    const r3 = inj.removeSkill('my-skill');
    expect(r3.success).toBe(true);
    expect(inj.isSkillMounted('my-skill')).toBe(false);

    // 再次移除幂等
    const r4 = inj.removeSkill('my-skill');
    expect(r4.success).toBe(true);
  });

  // ── Always-on ──────────────────────────────────────────────────────────

  it('Always-on 段落写入 / 检测 / 移除（边界标记 + 幂等替换）', () => {
    const rulesPath = resolveClineRulesPath({ dataDir: tmpDataDir });
    expect(inj.isAlwaysOnMounted()).toBe(false);

    // 先写一些已有内容
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, '# My Cline Rules\n\nBe helpful.\n', 'utf8');

    const block1 = 'yondermesh 已就位，MCP 工具可用。';
    const r1 = inj.injectAlwaysOn(block1);
    expect(r1.success).toBe(true);
    expect(inj.isAlwaysOnMounted()).toBe(true);

    let content = fs.readFileSync(rulesPath, 'utf8');
    expect(content).toContain(CONTEXT_BLOCK_START);
    expect(content).toContain(CONTEXT_BLOCK_END);
    expect(content).toContain(block1);
    // 原有内容保留
    expect(content).toContain('Be helpful.');

    // 重复注入替换（不堆积）
    const block2 = 'yondermesh v2 已就位。';
    const r2 = inj.injectAlwaysOn(block2);
    expect(r2.success).toBe(true);

    content = fs.readFileSync(rulesPath, 'utf8');
    expect(content).toContain(block2);
    expect(content).not.toContain(block1);
    // 边界标记只出现一次
    expect(content.split(CONTEXT_BLOCK_START).length - 1).toBe(1);
    expect(content.split(CONTEXT_BLOCK_END).length - 1).toBe(1);

    // 移除
    const r3 = inj.removeAlwaysOn();
    expect(r3.success).toBe(true);
    expect(inj.isAlwaysOnMounted()).toBe(false);

    content = fs.readFileSync(rulesPath, 'utf8');
    expect(content).not.toContain(CONTEXT_BLOCK_START);
    expect(content).not.toContain(block2);
    // 原有内容保留
    expect(content).toContain('Be helpful.');
  });

  // ── mountAll / unmountAll ──────────────────────────────────────────────

  it('mountAll / unmountAll 端到端往返', () => {
    const skillSource = path.join(tmpDataDir, 'batch-skill');
    fs.mkdirSync(skillSource, { recursive: true });

    const results = inj.mountAll({
      mcp: { name: 'ymesh-mcp', server: { command: 'ymesh', args: ['mcp'] } },
      skills: [{ name: 'batch-skill', path: skillSource }],
      contextBlock: 'batch always-on',
    });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);

    expect(inj.isMcpMounted('ymesh-mcp')).toBe(true);
    expect(inj.isSkillMounted('batch-skill')).toBe(true);
    expect(inj.isAlwaysOnMounted()).toBe(true);

    const rmResults = inj.unmountAll({
      mcpName: 'ymesh-mcp',
      skillNames: ['batch-skill'],
      alwaysOn: true,
    });
    expect(rmResults).toHaveLength(3);
    expect(rmResults.every((r) => r.success)).toBe(true);

    expect(inj.isMcpMounted('ymesh-mcp')).toBe(false);
    expect(inj.isSkillMounted('batch-skill')).toBe(false);
    expect(inj.isAlwaysOnMounted()).toBe(false);
  });

  // ── 路径解析 ───────────────────────────────────────────────────────────

  it('resolveClineMcpSettingsPath / resolveClineSkillsDir / resolveClineRulesPath 使用 dataDir', () => {
    expect(resolveClineMcpSettingsPath({ dataDir: tmpDataDir })).toBe(
      path.join(tmpDataDir, 'data', 'settings', 'cline_mcp_settings.json'),
    );
    expect(resolveClineSkillsDir({ dataDir: tmpDataDir })).toBe(
      path.join(tmpDataDir, 'skills'),
    );
    expect(resolveClineRulesPath({ dataDir: tmpDataDir })).toBe(
      path.join(tmpDataDir, '.clinerules'),
    );
  });
});
