/**
 * Vibe 注入：MCP + Skills + Always-on + Hooks
 *
 * Vibe 配置布局（~/.vibe/）：
 *   - config.toml    —— [[mcp_servers]] array-of-tables + [[providers]] + [[models]]
 *                        （TOML 陷阱：顶层 scalar 必须放在所有 [[...]] 段之前）
 *   - skills/        —— skill 目录 symlink（skill-symlink 策略）
 *   - AGENTS.md      —— 全局指令文件（always-on 注入）
 *   - hooks.toml     —— [[hooks]] array（type: post_agent_turn / before_tool / after_tool）
 *
 * MCP 使用 mcp-toml-array 策略：追加 [[mcp_servers]] 块到 config.toml 末尾。
 *   只追加 array-of-tables 段，不新增顶层 scalar，故不会违反 TOML 顺序陷阱。
 *
 * Hooks 用于 session 启停提醒：post_agent_turn 在每轮结束时触发，
 * 可写入 ymesh 状态文件供 daemon 感知 session 生命周期。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { mcpTomlArrayStrategy, skillSymlinkStrategy, alwaysOnStrategy } from '../mount/strategies.js';
import { CONTEXT_BLOCK_START } from '../mount/types.js';
import type { Extension, MountResult } from '../mount/types.js';
import {
  VIBE_HOME,
  VIBE_CONFIG_PATH,
  VIBE_HOOKS_PATH,
  VIBE_SKILLS_DIR,
  VIBE_AGENTS_MD,
} from './wrapper.js';

/** 注入结果聚合 */
export interface VibeInjectResult {
  mcp: MountResult;
  skill: MountResult;
  alwaysOn: MountResult;
  hooks: MountResult;
}

/** 生成 Vibe always-on 段落内容 */
export function vibeContextBlock(): string {
  return [
    '## yondermesh',
    '',
    'yondermesh is installed. It indexes Vibe sessions (~/.vibe/logs/session) into a local vault.',
    '',
    'Available capabilities:',
    '- **MCP tools**: query sessions across all CLIs by time/project/source (if MCP server is mounted in config.toml)',
    '- **CLI**: run `ymesh help` for commands (scan, status, sessions, mount)',
    '- **Skill**: `$yondermesh-diagnose` for system health checks',
    '',
    'Use these to recall prior work context or check what other agents did.',
  ].join('\n');
}

/** 构建 Vibe 注入所需的扩展列表 */
export function buildVibeExtensions(): Extension[] {
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
      contextBlock: vibeContextBlock(),
    },
  ];
}

/** 生成 Vibe hooks.toml 内容：post_agent_turn 在每轮结束时写 ymesh 状态 */
export function vibeHooksContent(): string {
  // [[hooks]] array-of-tables；顶层无 scalar，不触发 TOML 顺序陷阱
  return [
    '# yondermesh session lifecycle hooks for Vibe',
    '[[hooks]]',
    'name = "ymesh-post-turn-echo"',
    'type = "post_agent_turn"',
    'command = "/bin/sh -c \'date -u +%Y-%m-%dT%H:%M:%SZ > "$HOME/.yondermesh/.vibe-session-stop"\'"',
    'description = "Capture session turn end to ymesh state file"',
    'timeout = 10.0',
    '',
  ].join('\n');
}

/** 注入 MCP server 到 config.toml（[[mcp_servers]] array-of-tables） */
export function injectVibeMcp(ext: Extension): MountResult {
  return mcpTomlArrayStrategy.mount(ext, VIBE_CONFIG_PATH);
}

/** 注入 skill symlink */
export function injectVibeSkill(ext: Extension): MountResult {
  if (!ext.skillPath) {
    return {
      strategy: 'skill-symlink',
      target: 'vibe',
      extension: ext.name,
      success: false,
      message: 'no skillPath provided',
    };
  }
  return skillSymlinkStrategy.mount(ext, VIBE_SKILLS_DIR);
}

/** 注入 always-on 段落到 AGENTS.md */
export function injectVibeAlwaysOn(ext: Extension): MountResult {
  return alwaysOnStrategy.mount(ext, VIBE_AGENTS_MD);
}

/** 注入 hooks.toml（session 启停提醒） */
export function injectVibeHooks(): MountResult {
  try {
    fs.mkdirSync(VIBE_HOME, { recursive: true });
    fs.writeFileSync(VIBE_HOOKS_PATH, vibeHooksContent(), 'utf-8');
    return {
      strategy: 'always-on',
      target: 'vibe',
      extension: 'yondermesh-hooks',
      success: true,
      message: `written to ${VIBE_HOOKS_PATH}`,
    };
  } catch (e) {
    return {
      strategy: 'always-on',
      target: 'vibe',
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
export function injectVibeAll(skillsRoot?: string): VibeInjectResult {
  const exts = buildVibeExtensions();
  const mcpExt = exts.find((e) => e.type === 'mcp-server')!;
  const skillExt = exts.find((e) => e.type === 'skill')!;
  if (skillsRoot) skillExt.skillPath = path.join(skillsRoot, 'yondermesh-diagnose');
  const alwaysExt = exts.find((e) => e.type === 'plugin')!;

  const mcp = injectVibeMcp(mcpExt);
  mcp.target = 'vibe';
  const skill = injectVibeSkill(skillExt);
  skill.target = 'vibe';
  const alwaysOn = injectVibeAlwaysOn(alwaysExt);
  alwaysOn.target = 'vibe';
  const hooks = injectVibeHooks();

  return { mcp, skill, alwaysOn, hooks };
}

/** 移除全部注入 */
export function removeVibeAll(): MountResult[] {
  const results: MountResult[] = [];
  const mcp = mcpTomlArrayStrategy.unmount('yondermesh', VIBE_CONFIG_PATH);
  mcp.target = 'vibe';
  results.push(mcp);
  const skill = skillSymlinkStrategy.unmount('yondermesh-diagnose', VIBE_SKILLS_DIR);
  skill.target = 'vibe';
  results.push(skill);
  const alwaysOn = alwaysOnStrategy.unmount('yondermesh-awareness', VIBE_AGENTS_MD);
  alwaysOn.target = 'vibe';
  results.push(alwaysOn);
  return results;
}

/** 检查注入状态 */
export function checkVibeInjection(): Record<string, boolean> {
  return {
    mcp: mcpTomlArrayStrategy.isMounted('yondermesh', VIBE_CONFIG_PATH),
    skill: skillSymlinkStrategy.isMounted('yondermesh-diagnose', VIBE_SKILLS_DIR),
    alwaysOn: fs.existsSync(VIBE_AGENTS_MD) &&
      fs.readFileSync(VIBE_AGENTS_MD, 'utf-8').includes(CONTEXT_BLOCK_START),
    hooks: fs.existsSync(VIBE_HOOKS_PATH),
  };
}
