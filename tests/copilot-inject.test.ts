/**
 * Copilot CLI 注入器 smoke test
 *
 * 验证 inject / uninject 幂等往返：
 *   - MCP：mcp-config.json 中 mcpServers.{name} 的写入 / 读取 / 移除
 *   - Skill：symlink 创建 / 移除
 *   - Hooks：hooks.json 中 8 个 hookType 的写入 / 列出 / 移除
 *   - Always-on：AGENTS.md 段落写入 / 检测 / 移除（含幂等替换）
 *   - injectAll / uninjectAll 端到端往返
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CopilotInjector,
  COPILOT_HOOK_TYPES,
  defaultYondermeshAwarenessBlock,
} from '../src/copilot/index.js';

describe('Copilot CLI 注入器', () => {
  let tmpHome: string;
  let inj: CopilotInjector;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-inj-'));
    inj = new CopilotInjector({ homePath: tmpHome });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('MCP 注入 / 检测 / 移除幂等', () => {
    expect(inj.isMcpInjected('yondermesh')).toBe(false);

    const r1 = inj.injectMcp('yondermesh', {
      command: 'ymesh',
      args: ['mcp', 'serve'],
    });
    expect(r1.success).toBe(true);
    expect(inj.isMcpInjected('yondermesh')).toBe(true);

    // 重复注入覆盖
    const r2 = inj.injectMcp('yondermesh', {
      command: 'ymesh2',
      args: ['mcp', 'serve', '--port', '3000'],
    });
    expect(r2.success).toBe(true);

    const config = JSON.parse(fs.readFileSync(inj.mcpConfigPath, 'utf8'));
    expect(config.mcpServers.yondermesh.command).toBe('ymesh2');

    // 移除
    const r3 = inj.uninjectMcp('yondermesh');
    expect(r3.success).toBe(true);
    expect(inj.isMcpInjected('yondermesh')).toBe(false);

    // 再次移除幂等
    const r4 = inj.uninjectMcp('yondermesh');
    expect(r4.success).toBe(true);
  });

  it('Skill symlink 创建 / 检测 / 移除', () => {
    const targetDir = path.join(tmpHome, 'my-skill-source');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'SKILL.md'), '# my skill\n', 'utf8');

    const r1 = inj.injectSkill({ name: 'my-skill', targetPath: targetDir });
    expect(r1.success).toBe(true);
    expect(inj.isSkillInjected('my-skill')).toBe(true);

    // 重新注入（覆盖旧 symlink）
    const r2 = inj.injectSkill({ name: 'my-skill', targetPath: targetDir });
    expect(r2.success).toBe(true);

    // 移除
    const r3 = inj.uninjectSkill('my-skill');
    expect(r3.success).toBe(true);
    expect(inj.isSkillInjected('my-skill')).toBe(false);

    // target 不存在 → 失败
    const r4 = inj.injectSkill({ name: 'bad', targetPath: '/nonexistent/path' });
    expect(r4.success).toBe(false);
  });

  it('Hooks 批量注入 / 列出 / 移除', () => {
    expect(Object.keys(inj.listHooks())).toHaveLength(0);

    const r1 = inj.injectDefaultYmeshHooks({ ymeshBin: '/usr/local/bin/ymesh' });
    expect(r1.success).toBe(true);
    expect(r1.message).toContain('8 hooks written');

    const hooks = inj.listHooks();
    expect(Object.keys(hooks).sort()).toEqual([...COPILOT_HOOK_TYPES].sort());
    expect(hooks.sessionStart![0]!.command).toBe('/usr/local/bin/ymesh hook copilot sessionStart');
    expect(hooks.sessionStart![0]!.timeout).toBe(5000);

    // 重复注入相同 command → 替换（不追加）
    inj.injectDefaultYmeshHooks({ ymeshBin: '/usr/local/bin/ymesh' });
    expect(hooks.sessionStart).toHaveLength(1);

    // 移除某个 hookType 下的指定 command
    const r2 = inj.uninjectHook('sessionStart', '/usr/local/bin/ymesh hook copilot sessionStart');
    expect(r2.success).toBe(true);
    const hooks2 = inj.listHooks();
    expect(hooks2.sessionStart).toBeUndefined();

    // 清空整个 hookType
    inj.uninjectHook('sessionEnd');
    const hooks3 = inj.listHooks();
    expect(hooks3.sessionEnd).toBeUndefined();
  });

  it('Always-on 段落写入 / 检测 / 幂等替换 / 移除', () => {
    expect(inj.isAlwaysOnInjected()).toBe(false);

    const block1 = '## yondermesh awareness v1\nfirst version';
    const r1 = inj.injectAlwaysOn({ block: block1 });
    expect(r1.success).toBe(true);
    expect(inj.isAlwaysOnInjected()).toBe(true);

    const content1 = fs.readFileSync(inj.agentsMdPath, 'utf8');
    expect(content1).toContain('YONDERMESH_AWARENESS_START');
    expect(content1).toContain('yondermesh awareness v1');

    // 幂等替换（相同 blockId）
    const block2 = '## yondermesh awareness v2\nsecond version';
    inj.injectAlwaysOn({ block: block2 });
    const content2 = fs.readFileSync(inj.agentsMdPath, 'utf8');
    expect(content2).not.toContain('yondermesh awareness v1');
    expect(content2).toContain('yondermesh awareness v2');
    // 仅一段
    const startCount = (content2.match(/YONDERMESH_AWARENESS_START/g) || []).length;
    expect(startCount).toBe(1);

    // 多 blockId 共存
    inj.injectAlwaysOn({ block: 'extra block', id: 'extra' });
    expect(inj.isAlwaysOnInjected('awareness')).toBe(true);
    expect(inj.isAlwaysOnInjected('extra')).toBe(true);

    // 移除某 blockId
    inj.uninjectAlwaysOn('extra');
    expect(inj.isAlwaysOnInjected('extra')).toBe(false);
    expect(inj.isAlwaysOnInjected('awareness')).toBe(true);

    // 全部移除后文件应被删除
    inj.uninjectAlwaysOn('awareness');
    expect(inj.isAlwaysOnInjected('awareness')).toBe(false);
    expect(fs.existsSync(inj.agentsMdPath)).toBe(false);
  });

  it('buildSystemPromptEnv 构造 COPILOT_SYSTEM_PROMPT env', () => {
    const env = inj.buildSystemPromptEnv('hello system prompt');
    expect(env.COPILOT_SYSTEM_PROMPT).toBe('hello system prompt');
  });

  it('injectAll / uninjectAll 端到端往返', () => {
    const block = defaultYondermeshAwarenessBlock({ deviceId: 'test-device' });
    const results = inj.injectAll({
      mcpServer: { command: 'ymesh', args: ['mcp', 'serve'] },
      agentsBlock: block,
      ymeshBin: 'ymesh',
    });

    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(inj.isMcpInjected('yondermesh')).toBe(true);
    expect(inj.isAlwaysOnInjected('awareness')).toBe(true);
    expect(Object.keys(inj.listHooks()).length).toBe(8);

    // uninjectAll
    const unresults = inj.uninjectAll({ ymeshBin: 'ymesh' });
    expect(unresults.length).toBeGreaterThanOrEqual(10); // 1 mcp + 1 awareness + 8 hooks
    expect(inj.isMcpInjected('yondermesh')).toBe(false);
    expect(inj.isAlwaysOnInjected('awareness')).toBe(false);
    // hooks 应只剩空的 hooks.json
    expect(Object.keys(inj.listHooks())).toHaveLength(0);

    // 再次 uninjectAll 幂等
    const unresults2 = inj.uninjectAll({ ymeshBin: 'ymesh' });
    expect(unresults2.every((r) => r.success)).toBe(true);
  });
});
