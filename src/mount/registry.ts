/**
 * CLI 注册表
 *
 * 声明所有已知 CLI 及其支持的挂载策略。
 * 新增 CLI 只需在 CLI_REGISTRY 数组中追加一项。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CliTarget } from './types.js';
import { isOpenSpaceResidual } from './strategies.js';

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
        resolve: (home) => ({ configPath: join(home, '.codex', 'config.toml') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.codex', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.codex', 'AGENTS.md') }),
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
        resolve: (home) => ({ cliBinary: 'claude', home }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.claude', 'CLAUDE.md') }),
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
        resolve: (home) => ({ configPath: join(home, '.cursor', 'mcp.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.cursor', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.cursorrules') }),
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
        resolve: (home) => ({ configPath: join(home, '.gemini', 'settings.json') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.gemini', 'GEMINI.md') }),
      },
    ],
  },
  {
    id: 'windsurf',
    displayName: 'Windsurf',
    // 实测 Windsurf（Codeium IDE）配置根目录是 ~/.codeium/windsurf/，非 ~/.windsurf/。
    // detect 同时检测两个位置以兼容老版本 / 误装场景。
    homeDir: '.codeium/windsurf',
    detect: (home) =>
      existsSync(join(home, '.codeium', 'windsurf')) ||
      existsSync(join(home, '.windsurf')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        // MCP 配置：~/.codeium/windsurf/mcp_config.json（备选 ~/.windsurf/mcp_config.json）
        resolve: (home) => {
          const primary = join(home, '.codeium', 'windsurf', 'mcp_config.json');
          return {
            configPath: existsSync(primary)
              ? primary
              : join(home, '.windsurf', 'mcp_config.json'),
          };
        },
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.codeium', 'windsurf', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        // Always-on rules：~/.windsurfrules（用户级，Cascade 自动加载）
        resolve: (home) => ({ instructionFile: join(home, '.windsurfrules') }),
      },
    ],
  },
  {
    id: 'trae',
    displayName: 'Trae (International, covers IDE + Work)',
    homeDir: '.trae',
    detect: (home) => existsSync(join(home, '.trae')),
    capabilities: [
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.trae', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.trae', 'project_rules.md') }),
      },
    ],
  },
  {
    id: 'trae-cn',
    displayName: 'Trae CN (Chinese, covers IDE + Work)',
    homeDir: '.trae-cn',
    detect: (home) => existsSync(join(home, '.trae-cn')),
    capabilities: [
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.trae-cn', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.trae-cn', 'project_rules.md') }),
      },
    ],
  },
  {
    id: 'continue',
    displayName: 'Continue CLI (@continuedev/cli, binary: cn)',
    homeDir: '.continue',
    detect: (home) => existsSync(join(home, '.continue')),
    // Continue 的 MCP 和 Always-on rules 写在 ~/.continue/config.yaml（YAML），
    // 通用 mount 系统的 mcp-json（JSON）/ always-on（独立指令文件）策略不适用。
    // 这两项由专用注入器 src/continue/inject.ts 的 injectContinue() 负责
    // （YAML 行级解析，幂等）。registry 此处仅保留 skill-symlink 给 auto-mount。
    // 手动注入：`ymesh continue inject`（待 CLI 子命令接入）或直接调用 injectContinue()。
    capabilities: [
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.continue', 'skills') }),
      },
    ],
  },
  {
    id: 'hermes',
    displayName: 'Hermes Agent',
    homeDir: '.hermes',
    detect: (home) => existsSync(join(home, '.hermes')),
    // Hermes 不支持 MCP 挂载（D3 ⚠️）也不支持 Skills（D4 ❌），
    // 但支持 SOUL.md（D10 ✅）always-on 注入。
    capabilities: [
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.hermes', 'SOUL.md') }),
      },
    ],
  },
  {
    id: 'factory',
    displayName: 'Factory Droid (Factory AI)',
    homeDir: '.factory',
    detect: (home) => existsSync(join(home, '.factory')),
    // droid v0.171.0：GLM-5.2 BYOK via https://open.bigmodel.cn/api/anthropic。
    // D1-D4 ✅, D5 ⚠️（交互式），D6 ⚠️。
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.factory', 'mcp.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.factory', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.factory', 'AGENTS.md') }),
      },
    ],
  },
  {
    id: 'vibe',
    displayName: 'Vibe (Mistral AI)',
    homeDir: '.vibe',
    detect: (home) => existsSync(join(home, '.vibe')),
    // vibe v2.19.1：GLM-5.2 via http://127.0.0.1:15721/v1，TOML 配置 + [[mcp_servers]] 数组。
    // D1-D4 ✅, D5 ⚠️（实验性），D6 ❌。使用 mcp-toml-array 策略写入数组节。
    capabilities: [
      {
        strategy: 'mcp-toml-array',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.vibe', 'config.toml') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.vibe', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.vibe', 'AGENTS.md') }),
      },
    ],
  },
  {
    id: 'codebuddy',
    displayName: 'WorkBuddy / CodeBuddy (Tencent)',
    homeDir: '.codebuddy',
    detect: (home) => existsSync(join(home, '.codebuddy')),
    // cbc v2.106.4：GLM-5.2 写入 models.json（url 必须以 /chat/completions 结尾）。
    // ALL D1-D10 ✅（D5 ✅ 9 hooks × 4 types）。P0 优先级 - ymesh 最大遗漏。
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.codebuddy', 'models.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.codebuddy', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.codebuddy', 'AGENTS.md') }),
      },
    ],
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    homeDir: '.copilot',
    detect: (home) => existsSync(join(home, '.copilot')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.copilot', 'mcp-config.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.copilot', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.copilot', 'AGENTS.md') }),
      },
    ],
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    homeDir: '.openclaw',
    detect: (home) => existsSync(join(home, '.openclaw')),
    // OpenClaw 无 MCP / Skills / Always-on 挂载点（D4❌ D10❌），
    // 仅通过 CLI 链式注入实现等效效果（见 src/openclaw/inject.ts）。
    capabilities: [
      {
        strategy: 'cli-inject',
        extensionTypes: ['cli-inject'],
        resolve: (home) => ({ configDir: join(home, '.openclaw') }),
      },
    ],
  },
  {
    id: 'kimi',
    displayName: 'Kimi CLI',
    homeDir: '.kimi',
    detect: (home) => existsSync(join(home, '.kimi')),
    // Kimi 无 MCP / Skills / Always-on 挂载点，
    // 通过 Wire 协议 + CLI 链式注入实现等效效果（见 src/kimi/inject.ts）。
    capabilities: [
      {
        strategy: 'cli-inject',
        extensionTypes: ['cli-inject'],
        resolve: (home) => ({ configDir: join(home, '.kimi') }),
      },
    ],
  },
  {
    id: 'qwen',
    displayName: 'Qwen Code',
    homeDir: '.qwen',
    detect: (home) => existsSync(join(home, '.qwen')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.qwen', 'settings.json') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.qwen', 'QWEN.md') }),
      },
    ],
  },
  {
    id: 'pi',
    displayName: 'Pi Agent',
    homeDir: '.pi/agent',
    detect: (home) => existsSync(join(home, '.pi', 'agent')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.pi', 'agent', 'mcp.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.pi', 'agent', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.pi', 'agent', 'AGENTS.md') }),
      },
    ],
  },
  {
    id: 'omp',
    displayName: 'Oh-My-Pi (omp)',
    homeDir: '.omp/agent',
    detect: (home) => existsSync(join(home, '.omp', 'agent')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.omp', 'agent', 'mcp.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.omp', 'agent', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.omp', 'agent', 'AGENTS.md') }),
      },
    ],
  },
  {
    id: 'gsd-pi',
    displayName: 'GSD-Pi',
    homeDir: '.gsd/agent',
    detect: (home) => existsSync(join(home, '.gsd', 'agent')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.gsd', 'agent', 'mcp.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.gsd', 'agent', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.gsd', 'agent', 'AGENTS.md') }),
      },
    ],
  },
  {
    id: 'openhands',
    displayName: 'OpenHands',
    homeDir: '.openhands',
    detect: (home) => existsSync(join(home, '.openhands')),
    capabilities: [
      {
        strategy: 'mcp-toml',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.openhands', 'config.toml') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.openhands', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.openhands', 'AGENTS.md') }),
      },
    ],
  },
  {
    id: 'goose',
    displayName: 'Goose (Block)',
    homeDir: '.config/goose',
    detect: (home) => existsSync(join(home, '.config', 'goose')),
    capabilities: [
      {
        strategy: 'mcp-toml',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.config', 'goose', 'config.yaml') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.config', 'goose', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.config', 'goose', 'GOOSE.md') }),
      },
    ],
  },
  {
    id: 'crush',
    displayName: 'Crush (Charm)',
    homeDir: '.config/crush',
    detect: (home) => existsSync(join(home, '.config', 'crush')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.config', 'crush', 'crush.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.config', 'crush', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.config', 'crush', 'CRUSH.md') }),
      },
    ],
  },
  {
    id: 'cline',
    displayName: 'Cline',
    homeDir: '.cline',
    detect: (home) => existsSync(join(home, '.cline')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.cline', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.cline', '.clinerules') }),
      },
    ],
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity (Google IDE)',
    homeDir: '.gemini',
    detect: (home) => existsSync(join(home, '.gemini')),
    // Antigravity 与 Gemini CLI 共享 ~/.gemini/ 目录，但 MCP 配置路径不同：
    // Antigravity 用 ~/.gemini/config/mcp_config.json，Gemini CLI 用 ~/.gemini/settings.json。
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.gemini', 'config', 'mcp_config.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.gemini', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.gemini', 'AGENTS.md') }),
      },
    ],
  },
  {
    id: 'cursor-ide',
    displayName: 'Cursor IDE',
    homeDir: '.cursor',
    detect: (home) => existsSync(join(home, '.cursor')),
    // Cursor IDE 与 Cursor CLI 共享 ~/.cursor/ 配置目录。
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.cursor', 'mcp.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.cursor', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.cursorrules') }),
      },
    ],
  },
  {
    id: 'trae-ide',
    displayName: 'Trae IDE',
    homeDir: '.trae',
    detect: (home) => existsSync(join(home, '.trae')),
    // Trae IDE 与 Trae CLI 共享 ~/.trae/ 配置目录，但 IDE 有项目级 MCP (.trae/mcp.json)。
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.trae', 'mcp.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.trae', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.trae', 'project_rules.md') }),
      },
    ],
  },
  {
    id: 'amp',
    displayName: 'Amp (Sourcegraph)',
    homeDir: '.config/amp',
    detect: (home) => existsSync(join(home, '.config', 'amp')),
    capabilities: [
      {
        strategy: 'mcp-json',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.config', 'amp', 'settings.json') }),
      },
      {
        strategy: 'skill-symlink',
        extensionTypes: ['skill'],
        resolve: (home) => ({ skillsDir: join(home, '.config', 'amp', 'skills') }),
      },
      {
        strategy: 'always-on',
        extensionTypes: ['plugin'],
        resolve: (home) => ({ instructionFile: join(home, '.config', 'amp', 'AGENTS.md') }),
      },
    ],
  },
  {
    id: 'aider',
    displayName: 'Aider',
    homeDir: '.aider',
    detect: (home) => existsSync(join(home, '.aider')),
    // Aider 无 MCP / Skills / Always-on 挂载点（D3/D4/D5/D6/D8 全部 ❌），
    // 仅支持只读文件 --read + .aider.conf.yml（见 src/aider/inject.ts）。
    capabilities: [
      {
        strategy: 'cli-inject',
        extensionTypes: ['cli-inject'],
        resolve: (home) => ({ configDir: join(home, '.aider') }),
      },
    ],
  },
  {
    id: 'trae-cli',
    displayName: 'Trae CLI',
    homeDir: '.trae-cli',
    // detect 区分 ~/.trae-cli/（CLI）与 ~/.trae/（IDE）：检查独立的 .trae-cli 目录。
    detect: (home) => existsSync(join(home, '.trae-cli')),
    // trae-cli 无 Skills / Always-on（D4❌ D5❌ D6❌ D10❌），
    // 仅支持 MCP via config.yaml（见 src/trae-cli/inject.ts）。
    capabilities: [
      {
        strategy: 'mcp-toml',
        extensionTypes: ['mcp-server'],
        resolve: (home) => ({ configPath: join(home, '.trae-cli', 'config.yaml') }),
      },
    ],
  },
  {
    id: 'chatgpt',
    displayName: 'ChatGPT Desktop',
    homeDir: '.chatgpt',
    // ChatGPT 桌面版无 CLI 配置目录，detect 检查 ~/.chatgpt 是否存在
    // （macOS .app bundle 会在用户首次配置后创建本地配置目录）。
    detect: (home) => existsSync(join(home, '.chatgpt')),
    // 无标准 MCP / Skills / Always-on 挂载点，仅支持 CLI 链式注入。
    capabilities: [
      {
        strategy: 'cli-inject',
        extensionTypes: ['cli-inject'],
        resolve: (home) => ({ configDir: join(home, '.chatgpt') }),
      },
    ],
  },
];

/** 返回所有已安装的 CLI */
export function detectInstalledClis(home: string): CliTarget[] {
  return CLI_REGISTRY.filter((cli) => {
    if (!cli.detect(home)) return false;
    // 过滤 OpenSpace（HKUDS）残留目录：仅含 skills/ 且 skills/ 下全是
    // 指向 ~/.agents/skills/ 的 symlink，并非真实安装的 agent。
    if (isOpenSpaceResidual(join(home, cli.homeDir))) return false;
    return true;
  });
}

/** 按 id 查找 CLI */
export function findCli(id: string): CliTarget | undefined {
  return CLI_REGISTRY.find((c) => c.id === id);
}
