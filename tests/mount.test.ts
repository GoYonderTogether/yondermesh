import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import { mcpJsonStrategy, mcpTomlStrategy, skillSymlinkStrategy } from '../src/mount/strategies.js';
import { CLI_REGISTRY, detectInstalledClis } from '../src/mount/registry.js';
import type { Extension } from '../src/mount/types.js';

// ── helpers ──

let tmpHome: string;

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'ymesh-mount-'));
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const mcpExt: Extension = {
  type: 'mcp-server',
  name: 'yondermesh',
  mcp: { command: 'node', args: ['/usr/bin/ymesh', 'mcp'] },
};

const skillExt: Extension = {
  type: 'skill',
  name: 'yondermesh-diagnose',
  skillPath: '',
};

beforeEach(() => {
  tmpHome = mkdtemp();
  // Create fake skill source
  const skillSrc = path.join(tmpHome, 'fake-skill-source');
  fs.mkdirSync(skillSrc, { recursive: true });
  fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '---\nname: test\n---\n# test');
  skillExt.skillPath = skillSrc;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ── mcp-json strategy ──

describe('mcp-json strategy (Cursor/Gemini/Windsurf)', () => {
  it('mount: writes mcpServers key to a fresh config', () => {
    const configPath = path.join(tmpHome, 'mcp.json');
    const result = mcpJsonStrategy.mount(mcpExt, configPath);
    expect(result.success).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.yondermesh).toBeDefined();
    expect(config.mcpServers.yondermesh.command).toBe('node');
    expect(config.mcpServers.yondermesh.args).toEqual(['/usr/bin/ymesh', 'mcp']);
  });

  it('mount: preserves existing mcpServers entries', () => {
    const configPath = path.join(tmpHome, 'mcp.json');
    writeJson(configPath, { mcpServers: { other: { command: 'other', args: [] } } });

    mcpJsonStrategy.mount(mcpExt, configPath);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.other).toBeDefined();
    expect(config.mcpServers.yondermesh).toBeDefined();
  });

  it('mount: overwrites existing yondermesh entry (idempotent)', () => {
    const configPath = path.join(tmpHome, 'mcp.json');
    writeJson(configPath, { mcpServers: { yondermesh: { command: 'old', args: [] } } });

    mcpJsonStrategy.mount(mcpExt, configPath);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.yondermesh.command).toBe('node');
  });

  it('isMounted: returns true when present, false when absent', () => {
    const configPath = path.join(tmpHome, 'mcp.json');
    expect(mcpJsonStrategy.isMounted('yondermesh', configPath)).toBe(false);

    mcpJsonStrategy.mount(mcpExt, configPath);
    expect(mcpJsonStrategy.isMounted('yondermesh', configPath)).toBe(true);
  });

  it('unmount: removes entry and preserves others', () => {
    const configPath = path.join(tmpHome, 'mcp.json');
    writeJson(configPath, {
      mcpServers: {
        other: { command: 'other', args: [] },
        yondermesh: { command: 'node', args: [] },
      },
    });

    const result = mcpJsonStrategy.unmount('yondermesh', configPath);
    expect(result.success).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.other).toBeDefined();
    expect(config.mcpServers.yondermesh).toBeUndefined();
  });
});

// ── mcp-toml strategy ──

describe('mcp-toml strategy (Codex)', () => {
  it('mount: appends [mcp_servers.yondermesh] section', () => {
    const configPath = path.join(tmpHome, 'config.toml');
    fs.writeFileSync(configPath, 'model = "gpt-4"\n');

    const result = mcpTomlStrategy.mount(mcpExt, configPath);
    expect(result.success).toBe(true);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('[mcp_servers.yondermesh]');
    expect(content).toContain('command = "node"');
    expect(content).toContain('args = ["/usr/bin/ymesh", "mcp"]');
  });

  it('mount: preserves existing TOML content', () => {
    const configPath = path.join(tmpHome, 'config.toml');
    const original = [
      'model = "glm-5.2"',
      '',
      '[model_providers]',
      'name = "test"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
    ].join('\n');
    fs.writeFileSync(configPath, original);

    mcpTomlStrategy.mount(mcpExt, configPath);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('model = "glm-5.2"');
    expect(content).toContain('[mcp_servers.other]');
    expect(content).toContain('[mcp_servers.yondermesh]');
  });

  it('mount: overwrites existing yondermesh section (idempotent)', () => {
    const configPath = path.join(tmpHome, 'config.toml');
    const original = [
      '[mcp_servers.yondermesh]',
      'command = "old"',
      'args = []',
    ].join('\n');
    fs.writeFileSync(configPath, original);

    mcpTomlStrategy.mount(mcpExt, configPath);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('command = "node"');
    expect(content).not.toContain('command = "old"');
  });

  it('mount: writes env section when env provided', () => {
    const configPath = path.join(tmpHome, 'config.toml');
    const extWithEnv: Extension = {
      type: 'mcp-server',
      name: 'yondermesh',
      mcp: { command: 'node', args: ['x'], env: { KEY: 'value' } },
    };

    mcpTomlStrategy.mount(extWithEnv, configPath);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('[mcp_servers.yondermesh.env]');
    expect(content).toContain('KEY = "value"');
  });

  it('isMounted: checks section presence', () => {
    const configPath = path.join(tmpHome, 'config.toml');
    fs.writeFileSync(configPath, '');
    expect(mcpTomlStrategy.isMounted('yondermesh', configPath)).toBe(false);

    mcpTomlStrategy.mount(mcpExt, configPath);
    expect(mcpTomlStrategy.isMounted('yondermesh', configPath)).toBe(true);
  });

  it('unmount: removes section, preserves others', () => {
    const configPath = path.join(tmpHome, 'config.toml');
    const original = [
      '[mcp_servers.other]',
      'command = "other"',
      '',
      '[mcp_servers.yondermesh]',
      'command = "node"',
      'args = ["x"]',
    ].join('\n');
    fs.writeFileSync(configPath, original);

    mcpTomlStrategy.unmount('yondermesh', configPath);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('[mcp_servers.other]');
    expect(content).not.toContain('[mcp_servers.yondermesh]');
  });
});

// ── skill-symlink strategy ──

describe('skill-symlink strategy', () => {
  it('mount: creates symlink in skills dir', () => {
    const skillsDir = path.join(tmpHome, 'skills');

    const result = skillSymlinkStrategy.mount(skillExt, skillsDir);
    expect(result.success).toBe(true);

    const linkPath = path.join(skillsDir, 'yondermesh-diagnose');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(linkPath, 'SKILL.md'))).toBe(true);
  });

  it('mount: overwrites existing symlink (idempotent)', () => {
    const skillsDir = path.join(tmpHome, 'skills');

    skillSymlinkStrategy.mount(skillExt, skillsDir);
    skillSymlinkStrategy.mount(skillExt, skillsDir);

    const linkPath = path.join(skillsDir, 'yondermesh-diagnose');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  it('isMounted: checks symlink existence', () => {
    const skillsDir = path.join(tmpHome, 'skills');
    expect(skillSymlinkStrategy.isMounted('yondermesh-diagnose', skillsDir)).toBe(false);

    skillSymlinkStrategy.mount(skillExt, skillsDir);
    expect(skillSymlinkStrategy.isMounted('yondermesh-diagnose', skillsDir)).toBe(true);
  });

  it('unmount: removes symlink, preserves others', () => {
    const skillsDir = path.join(tmpHome, 'skills');
    skillSymlinkStrategy.mount(skillExt, skillsDir);
    // also create another symlink
    fs.symlinkSync(skillExt.skillPath, path.join(skillsDir, 'other-skill'), 'dir');

    const result = skillSymlinkStrategy.unmount('yondermesh-diagnose', skillsDir);
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(skillsDir, 'yondermesh-diagnose'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'other-skill'))).toBe(true);
  });
});

// ── CLI registry ──

describe('CLI registry', () => {
  it('detectInstalledClis: returns empty when no CLIs installed', () => {
    const empty = detectInstalledClis(tmpHome);
    expect(empty).toEqual([]);
  });

  it('detectInstalledClis: detects codex', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'));
    const clis = detectInstalledClis(tmpHome);
    const ids = clis.map((c) => c.id);
    expect(ids).toContain('codex');
  });

  it('detectInstalledClis: detects multiple CLIs', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'));
    fs.mkdirSync(path.join(tmpHome, '.cursor'));
    fs.mkdirSync(path.join(tmpHome, '.gemini'));

    const clis = detectInstalledClis(tmpHome);
    const ids = clis.map((c) => c.id);
    expect(ids).toContain('codex');
    expect(ids).toContain('cursor');
    expect(ids).toContain('gemini');
  });

  it('CLI_REGISTRY: each entry has valid capabilities', () => {
    for (const cli of CLI_REGISTRY) {
      expect(cli.capabilities.length).toBeGreaterThan(0);
      for (const cap of cli.capabilities) {
        expect(cap.extensionTypes.length).toBeGreaterThan(0);
        expect(cap.resolve(tmpHome)).toBeDefined();
      }
    }
  });
});
