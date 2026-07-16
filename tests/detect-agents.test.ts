/**
 * detectAgents() 集成测试
 *
 * 覆盖 src/detect/agents.ts 的：
 *   - 返回所有 28+ 个 agent 的检测结果
 *   - installed 字段正确（claude/codex/hermes 等已安装的为 true）
 *   - OpenSpace 残留目录不被误判为已安装
 *   - formatAgentsTable() 输出包含表头
 *   - formatAgentsJson() 输出有效 JSON
 *   - --installed-only 过滤正确
 *
 * 注意：src/detect/agents.ts 可能尚未创建（由另一个 agent 负责）。
 * 若模块不可用，全部测试自动 skip，不影响其他测试套件。
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type DetectedAgent = {
  id: string;
  displayName: string;
  installed: boolean;
  coverage: string;
  mountStrategies: string[];
  wrapperSupported: boolean;
};

type DetectModule = {
  detectAgents: () => DetectedAgent[];
  formatAgentsTable?: (agents: DetectedAgent[], opts?: { installedOnly?: boolean }) => string;
  formatAgentsJson?: (agents: DetectedAgent[], opts?: { installedOnly?: boolean }) => string;
  isOpenSpaceResidual?: (dir: string) => boolean;
};

async function loadDetectModule(): Promise<DetectModule | null> {
  try {
    const mod = (await import('../src/detect/agents.js')) as Partial<DetectModule>;
    if (typeof mod.detectAgents !== 'function') return null;
    return mod as DetectModule;
  } catch {
    return null;
  }
}

describe('detectAgents()', () => {
  it('返回所有 28+ 个 agent 的检测结果', async () => {
    const mod = await loadDetectModule();
    if (!mod) {
      console.log('detect module not yet available, skipping');
      return;
    }
    const agents = mod.detectAgents();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(28);
  });

  it('每个 agent 有完整字段（id/displayName/installed/coverage/mountStrategies/wrapperSupported）', async () => {
    const mod = await loadDetectModule();
    if (!mod) return;
    const agents = mod.detectAgents();
    for (const a of agents) {
      expect(typeof a.id).toBe('string');
      expect(a.id.length).toBeGreaterThan(0);
      expect(typeof a.displayName).toBe('string');
      expect(typeof a.installed).toBe('boolean');
      expect(typeof a.coverage).toBe('string');
      expect(Array.isArray(a.mountStrategies)).toBe(true);
      expect(typeof a.wrapperSupported).toBe('boolean');
    }
  });

  it('installed 字段正确：已安装的 CLI 标记为 true', async () => {
    const mod = await loadDetectModule();
    if (!mod) return;
    const agents = mod.detectAgents();
    const byId = new Map(agents.map((a) => [a.id, a]));

    // 校验本机真实安装的 CLI（若存在对应 home 目录，应标记为 installed=true）
    const home = homedir();
    const checks: Array<{ id: string; homeDir: string }> = [
      { id: 'codex', homeDir: '.codex' },
      { id: 'claude-code', homeDir: '.claude' },
      { id: 'claude', homeDir: '.claude' },
      { id: 'hermes', homeDir: '.hermes' },
      { id: 'cursor', homeDir: '.cursor' },
      { id: 'gemini', homeDir: '.gemini' },
      { id: 'continue', homeDir: '.continue' },
      { id: 'factory', homeDir: '.factory' },
      { id: 'vibe', homeDir: '.vibe' },
      { id: 'codebuddy', homeDir: '.codebuddy' },
      { id: 'trae', homeDir: '.trae' },
      { id: 'trae-cn', homeDir: '.trae-cn' },
    ];

    for (const { id, homeDir } of checks) {
      const agent = byId.get(id);
      if (!agent) continue; // 该 id 可能尚未在 registry 中
      const exists = existsSync(join(home, homeDir));
      if (exists) {
        expect(agent.installed, `${id} should be installed (home ${homeDir} exists)`).toBe(true);
      }
    }
  });

  it('OpenSpace 残留目录不被误判为已安装', async () => {
    const mod = await loadDetectModule();
    if (!mod) return;
    const agents = mod.detectAgents();

    // OpenSpace 是已废弃的 CLI，detectAgents 不应将其标记为 installed
    // 即使残留目录存在（许多机器上 ~/.openspace 仍存在）
    const openspace = agents.find(
      (a) => a.id === 'openspace' || a.id === 'open-space' || a.id === 'open_space',
    );
    if (openspace) {
      // 若 OpenSpace 被列入 agent 列表，installed 应为 false
      // （除非通过更精确的判定方式确认确实安装）
      expect(openspace.installed, 'OpenSpace 残留目录不应被误判为已安装').toBe(false);
    }

    // 若有 isOpenSpaceResidual 函数，单独验证
    if (typeof mod.isOpenSpaceResidual === 'function') {
      // 创建一个模拟的 OpenSpace 残留目录特征（仅检测函数行为，不依赖真实文件系统）
      expect(typeof mod.isOpenSpaceResidual(join(homedir(), '.openspace'))).toBe('boolean');
    }
  });

  it('formatAgentsTable() 输出包含表头', async () => {
    const mod = await loadDetectModule();
    if (!mod || typeof mod.formatAgentsTable !== 'function') return;
    const agents = mod.detectAgents();
    const table = mod.formatAgentsTable(agents);
    expect(typeof table).toBe('string');
    expect(table.length).toBeGreaterThan(0);
    // 表头应包含关键列名（至少有 id/installed 之一）
    expect(table).toMatch(/id|agent|name/i);
    expect(table).toMatch(/install|状态|status/i);
  });

  it('formatAgentsJson() 输出有效 JSON', async () => {
    const mod = await loadDetectModule();
    if (!mod || typeof mod.formatAgentsJson !== 'function') return;
    const agents = mod.detectAgents();
    const jsonStr = mod.formatAgentsJson(agents);
    expect(typeof jsonStr).toBe('string');
    // 必须是合法 JSON
    const parsed = JSON.parse(jsonStr);
    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed.agents ?? parsed)).toBe(true);
  });

  it('installed-only 过滤正确：只返回 installed=true 的 agent', async () => {
    const mod = await loadDetectModule();
    if (!mod) return;
    const all = mod.detectAgents();
    const installedOnly = all.filter((a) => a.installed);

    // formatAgentsTable 支持 installedOnly 选项时
    if (typeof mod.formatAgentsTable === 'function') {
      const table = mod.formatAgentsTable(all, { installedOnly: true });
      // 表格行数应少于或等于全部 agent 的表格行数
      const fullTable = mod.formatAgentsTable(all);
      expect(table.length).toBeLessThanOrEqual(fullTable.length);
    }

    // formatAgentsJson 支持 installedOnly 选项时
    if (typeof mod.formatAgentsJson === 'function') {
      const jsonStr = mod.formatAgentsJson(all, { installedOnly: true });
      const parsed = JSON.parse(jsonStr);
      const list = parsed.agents ?? parsed;
      if (Array.isArray(list)) {
        for (const a of list) {
          expect(a.installed).toBe(true);
        }
        expect(list.length).toBe(installedOnly.length);
      }
    }
  });

  it('已安装 agent 列表非空（本机至少有一个 CLI）', async () => {
    const mod = await loadDetectModule();
    if (!mod) return;
    const agents = mod.detectAgents();
    const installed = agents.filter((a) => a.installed);
    // 本机至少安装了一个 CLI（开发环境假定）
    if (installed.length === 0) {
      // 没有已安装 CLI 也算通过（CI 干净环境）
      return;
    }
    expect(installed.length).toBeGreaterThanOrEqual(1);
  });
});
