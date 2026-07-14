/**
 * CLI 注册表
 *
 * 声明所有已知 CLI 及其支持的挂载策略。
 * 新增 CLI 只需在 CLI_REGISTRY 数组中追加一项。
 */

import type { CliTarget } from './types.js';

export const CLI_REGISTRY: CliTarget[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    homeDir: '.codex',
    detect: (home) => existsSync(join(home, '.codex')),
    capabilities: [
      {
        strategy: 'mcp-toml',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({
          configPath: join(home, '.codex', 'config.toml'),
        }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({
          skillsDir: join(home, '.codex', 'skills'),
        }),
      },
    ],
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    homeDir: '.claude',
    detect: (home) => existsSync(join(home, '.claude')),
    capabilities: [
      {
        strategy: 'claude-mcp',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({
          cliBinary: 'claude',
          home,
        }),
      },
    ],
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    homeDir: '.cursor',
    detect: (home) => existsSync(join(home, '.cursor')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({
          configPath: join(home, '.cursor', 'mcp.json'),
        }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({
          skillsDir: join(home, '.cursor', 'skills'),
        }),
      },
    ],
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    homeDir: '.gemini',
    detect: (home) => existsSync(join(home, '.gemini')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({
          configPath: join(home, '.gemini', 'settings.json'),
        }),
      },
    ],
  },
  {
    id: 'windsurf',
    displayName: 'Windsurf',
    homeDir: '.windsurf',
    detect: (home) => existsSync(join(home, '.windsurf')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({
          configPath: join(home, '.windsurf', 'mcp_config.json'),
        }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({
          skillsDir: join(home, '.windsurf', 'skills'),
        }),
      },
    ],
  },
  {
    id: 'trae',
    displayName: 'Trae',
    homeDir: '.trae',
    detect: (home) => existsSync(join(home, '.trae')),
    capabilities: [
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({
          skillsDir: join(home, '.trae', 'skills'),
        }),
      },
    ],
  },
  {
    id: 'continue',
    displayName: 'Continue',
    homeDir: '.continue',
    detect: (home) => existsSync(join(home, '.continue')),
    capabilities: [
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({
          skillsDir: join(home, '.continue', 'skills'),
        }),
      },
    ],
  },
];

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 返回所有已安装的 CLI */
export function detectInstalledClis(home: string): CliTarget[] {
  return CLI_REGISTRY.filter((cli) => cli.detect(home));
}

/** 按 id 查找 CLI */
export function findCli(id: string): CliTarget | undefined {
  return CLI_REGISTRY.find((c) => c.id === id);
}
