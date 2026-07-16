/**
 * Factory Droid 注入：MCP + Skills + Always-on + Hooks
 *
 * Factory Droid 配置布局（~/.factory/）：
 *   - mcp.json      —— JSON { "mcpServers": { name: {command,args,env} } }（复用 mcp-json 策略）
 *   - skills/       —— skill 目录 symlink（复用 skill-symlink 策略）
 *   - AGENTS.md     —— 全局指令文件（always-on 注入）
 *   - hooks.json    —— hooks 配置（PreToolUse / Stop，类 Claude Code 结构）
 *
 * Hooks 用于 session 启停提醒：Stop hook 在 session 结束时触发，
 * 可写入 ymesh 状态文件供 daemon 感知 session 生命周期。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { mcpJsonStrategy, skillSymlinkStrategy, alwaysOnStrategy } from '../mount/strategies.js';
import { CONTEXT_BLOCK_START } from '../mount/types.js';
import type { Extension, MountResult } from '../mount/types.js';
import { FACTORY_HOME } from './wrapper.js';

/** Factory hooks.json 路径 */
export const FACTORY_HOOKS_PATH = path.join(FACTORY_HOME, 'hooks.json');
/** Factory MCP 配置路径 */
export const FACTORY_MCP_PATH = path.join(FACTORY_HOME, 'mcp.json');
/** Factory skills 目录 */
export const FACTORY_SKILLS_DIR = path.join(FACTORY_HOME, 'skills');
/** Factory 全局指令文件 */
export const FACTORY_AGENTS_MD = path.join(FACTORY_HOME, 'AGENTS.md');

/** 注入结果聚合 */
export interface FactoryInjectResult {
  mcp: MountResult;
  skill: MountResult;
  alwaysOn: MountResult;
  hooks: MountResult;
}

/** 生成 Factory always-on 段落内容 */
export function factoryContextBlock(): string {
  return [
    '## yondermesh',
    '',
    'yondermesh is installed. It indexes Factory Droid sessions (~/.factory/sessions) into a local vault.',
    '',
    'Available capabilities:',
    '- **MCP tools**: query sessions across all CLIs by time/project/source (if MCP server is mounted in mcp.json)',
    '- **CLI**: run `ymesh help` for commands (scan, status, sessions, mount)',
    '- **Skill**: `$yondermesh-diagnose` for system health checks',
    '',
    'Use these to recall prior work context or check what other agents did.',
  ].join('\n');
}

/** 构建 Factory 注入所需的扩展列表 */
export function buildFactoryExtensions(): Extension[] {
  return [
    {
      type: 'mcp-server',
      name: 'yondermesh',
      mcp: { command: process.execPath, args: ['ymesh', 'mcp'] },
    },
    {
      type: 'skill',
      name: 'yondermesh-diagnose',
      skillPath: '', // 由调用方填入实际 skillsRoot
    },
    {
      type: 'plugin',
      name: 'yondermesh-awareness',
      contextBlock: factoryContextBlock(),
    },
  ];
}

/** 生成 Factory hooks.json 内容：Stop hook 在 session 结束时写 ymesh 状态 */
export function factoryHooksContent(): string {
  const hooks = {
    hooks: {
      // Stop: session 结束时触发，写状态文件供 daemon 感知
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: '/bin/sh -c \'date -u +%Y-%m-%dT%H:%M:%SZ > "$HOME/.yondermesh/.factory-session-stop"\'',
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(hooks, null, 2) + '\n';
}

/** 注入 MCP server 到 mcp.json */
export function injectFactoryMcp(ext: Extension): MountResult {
  return mcpJsonStrategy.mount(ext, FACTORY_MCP_PATH);
}

/** 注入 skill symlink */
export function injectFactorySkill(ext: Extension): MountResult {
  if (!ext.skillPath) {
    return {
      strategy: 'skill-symlink',
      target: 'factory',
      extension: ext.name,
      success: false,
      message: 'no skillPath provided',
    };
  }
  return skillSymlinkStrategy.mount(ext, FACTORY_SKILLS_DIR);
}

/** 注入 always-on 段落到 AGENTS.md */
export function injectFactoryAlwaysOn(ext: Extension): MountResult {
  return alwaysOnStrategy.mount(ext, FACTORY_AGENTS_MD);
}

/** 注入 hooks.json（session 启停提醒） */
export function injectFactoryHooks(): MountResult {
  try {
    fs.mkdirSync(FACTORY_HOME, { recursive: true });
    fs.writeFileSync(FACTORY_HOOKS_PATH, factoryHooksContent(), 'utf-8');
    return {
      strategy: 'always-on',
      target: 'factory',
      extension: 'yondermesh-hooks',
      success: true,
      message: `written to ${FACTORY_HOOKS_PATH}`,
    };
  } catch (e) {
    return {
      strategy: 'always-on',
      target: 'factory',
      extension: 'yondermesh-hooks',
      success: false,
      message: String(e),
    };
  }
}

/**
 * 一键注入全部（MCP + Skills + Always-on + Hooks）。
 * skillsRoot 指向 yondermesh releases/current/skills 目录。
 */
export function injectFactoryAll(skillsRoot?: string): FactoryInjectResult {
  const exts = buildFactoryExtensions();
  const mcpExt = exts.find((e) => e.type === 'mcp-server')!;
  const skillExt = exts.find((e) => e.type === 'skill')!;
  if (skillsRoot) skillExt.skillPath = path.join(skillsRoot, 'yondermesh-diagnose');
  const alwaysExt = exts.find((e) => e.type === 'plugin')!;

  const mcp = injectFactoryMcp(mcpExt);
  mcp.target = 'factory';
  const skill = injectFactorySkill(skillExt);
  skill.target = 'factory';
  const alwaysOn = injectFactoryAlwaysOn(alwaysExt);
  alwaysOn.target = 'factory';
  const hooks = injectFactoryHooks();

  return { mcp, skill, alwaysOn, hooks };
}

/** 移除全部注入 */
export function removeFactoryAll(): MountResult[] {
  const results: MountResult[] = [];
  const mcp = mcpJsonStrategy.unmount('yondermesh', FACTORY_MCP_PATH);
  mcp.target = 'factory';
  results.push(mcp);
  const skill = skillSymlinkStrategy.unmount('yondermesh-diagnose', FACTORY_SKILLS_DIR);
  skill.target = 'factory';
  results.push(skill);
  const alwaysOn = alwaysOnStrategy.unmount('yondermesh-awareness', FACTORY_AGENTS_MD);
  alwaysOn.target = 'factory';
  results.push(alwaysOn);
  return results;
}

/** 检查注入状态 */
export function checkFactoryInjection(): Record<string, boolean> {
  return {
    mcp: mcpJsonStrategy.isMounted('yondermesh', FACTORY_MCP_PATH),
    skill: skillSymlinkStrategy.isMounted('yondermesh-diagnose', FACTORY_SKILLS_DIR),
    alwaysOn: fs.existsSync(FACTORY_AGENTS_MD) &&
      fs.readFileSync(FACTORY_AGENTS_MD, 'utf-8').includes(CONTEXT_BLOCK_START),
    hooks: fs.existsSync(FACTORY_HOOKS_PATH),
  };
}
