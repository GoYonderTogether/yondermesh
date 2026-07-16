/**
 * WorkBuddy / CodeBuddy 注入：MCP + Skills + 9 hooks × 4 类型 + Always-on
 *
 * CodeBuddy 配置布局（~/.codebuddy/）：
 *   - models.json    —— MCP + 模型配置（JSON { "mcpServers": {...} }，复用 mcp-json 策略）
 *                        GLM-5.2 BYOK：url 必须以 /chat/completions 结尾
 *   - skills/        —— skill 目录 symlink（skill-symlink 策略）
 *   - AGENTS.md      —— 全局指令文件（always-on 注入）
 *   - hooks.json     —— 9 hooks × 4 类型（SessionStart/PreToolUse/PostToolUse/Stop）
 *
 * 9 hooks × 4 类型覆盖 session 启停：
 *   - SessionStart（2 hooks）：session 启动时写 ymesh 状态 → 覆盖 "启"
 *   - PreToolUse（2 hooks）：Read/Write 工具调用前
 *   - PostToolUse（2 hooks）：Read/Write 工具调用后
 *   - Stop（3 hooks）：session 结束时写 ymesh 状态 + 清理 → 覆盖 "停"
 *   合计 9 hooks，4 类型，SessionStart + Stop 完整覆盖 session 启停提醒。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { mcpJsonStrategy, skillSymlinkStrategy, alwaysOnStrategy } from '../mount/strategies.js';
import { CONTEXT_BLOCK_START } from '../mount/types.js';
import type { Extension, MountResult } from '../mount/types.js';
import {
  CODEBUDDY_HOME,
  CODEBUDDY_MODELS_JSON,
  CODEBUDDY_HOOKS_PATH,
  CODEBUDDY_SKILLS_DIR,
  CODEBUDDY_AGENTS_MD,
} from './wrapper.js';

/** CodeBuddy 支持的 4 种 hook 事件类型 */
export type CodeBuddyHookType = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop';

/** 注入结果聚合 */
export interface CodeBuddyInjectResult {
  mcp: MountResult;
  skill: MountResult;
  alwaysOn: MountResult;
  hooks: MountResult;
}

/** 生成 CodeBuddy always-on 段落内容 */
export function codeBuddyContextBlock(): string {
  return [
    '## yondermesh',
    '',
    'yondermesh is installed. It indexes WorkBuddy/CodeBuddy sessions (~/.codebuddy) into a local vault.',
    '',
    'Available capabilities:',
    '- **MCP tools**: query sessions across all CLIs by time/project/source (if MCP server is mounted in models.json)',
    '- **CLI**: run `ymesh help` for commands (scan, status, sessions, mount)',
    '- **Skill**: `$yondermesh-diagnose` for system health checks',
    '',
    'Use these to recall prior work context or check what other agents did.',
  ].join('\n');
}

/** 构建 CodeBuddy 注入所需的扩展列表 */
export function buildCodeBuddyExtensions(): Extension[] {
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
      contextBlock: codeBuddyContextBlock(),
    },
  ];
}

/**
 * 生成 CodeBuddy hooks.json 内容：9 hooks × 4 类型。
 *
 * 4 类型：SessionStart / PreToolUse / PostToolUse / Stop
 * 9 hooks 分布：
 *   - SessionStart × 2：session 启动时写 ymesh 启动状态文件
 *   - PreToolUse × 2：Read / Write 工具调用前打日志
 *   - PostToolUse × 2：Read / Write 工具调用后打日志
 *   - Stop × 3：session 结束时写 ymesh 停止状态 + 追加历史 + 清理
 *
 * SessionStart + Stop 完整覆盖 session 启停提醒。
 */
export function codeBuddyHooksContent(): string {
  const ymeshDir = '$HOME/.yondermesh';
  const hooks = {
    hooks: {
      // —— SessionStart（2 hooks）：覆盖 session "启" ——
      SessionStart: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `/bin/sh -c 'mkdir -p ${ymeshDir} && date -u +%Y-%m-%dT%H:%M:%SZ > ${ymeshDir}/.codebuddy-session-start'`,
            },
          ],
        },
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `/bin/sh -c 'echo "start" >> ${ymeshDir}/.codebuddy-session-lifecycle.log'`,
            },
          ],
        },
      ],
      // —— PreToolUse（2 hooks）——
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [
            { type: 'command', command: '/bin/echo "PreToolUse-Read" >> /tmp/ymesh-codebuddy-hooks.log' },
          ],
        },
        {
          matcher: 'Write',
          hooks: [
            { type: 'command', command: '/bin/echo "PreToolUse-Write" >> /tmp/ymesh-codebuddy-hooks.log' },
          ],
        },
      ],
      // —— PostToolUse（2 hooks）——
      PostToolUse: [
        {
          matcher: 'Read',
          hooks: [
            { type: 'command', command: '/bin/echo "PostToolUse-Read" >> /tmp/ymesh-codebuddy-hooks.log' },
          ],
        },
        {
          matcher: 'Write',
          hooks: [
            { type: 'command', command: '/bin/echo "PostToolUse-Write" >> /tmp/ymesh-codebuddy-hooks.log' },
          ],
        },
      ],
      // —— Stop（3 hooks）：覆盖 session "停" ——
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `/bin/sh -c 'date -u +%Y-%m-%dT%H:%M:%SZ > ${ymeshDir}/.codebuddy-session-stop'`,
            },
          ],
        },
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `/bin/sh -c 'echo "stop" >> ${ymeshDir}/.codebuddy-session-lifecycle.log'`,
            },
          ],
        },
        {
          matcher: '',
          hooks: [
            { type: 'command', command: '/bin/echo "Stop fired" >> /tmp/ymesh-codebuddy-hooks.log' },
          ],
        },
      ],
    },
  };
  return JSON.stringify(hooks, null, 2) + '\n';
}

/** 注入 MCP server 到 models.json（mcpServers 键） */
export function injectCodeBuddyMcp(ext: Extension): MountResult {
  return mcpJsonStrategy.mount(ext, CODEBUDDY_MODELS_JSON);
}

/** 注入 skill symlink */
export function injectCodeBuddySkill(ext: Extension): MountResult {
  if (!ext.skillPath) {
    return {
      strategy: 'skill-symlink',
      target: 'codebuddy',
      extension: ext.name,
      success: false,
      message: 'no skillPath provided',
    };
  }
  return skillSymlinkStrategy.mount(ext, CODEBUDDY_SKILLS_DIR);
}

/** 注入 always-on 段落到 AGENTS.md */
export function injectCodeBuddyAlwaysOn(ext: Extension): MountResult {
  return alwaysOnStrategy.mount(ext, CODEBUDDY_AGENTS_MD);
}

/** 注入 hooks.json（9 hooks × 4 类型，session 启停提醒） */
export function injectCodeBuddyHooks(): MountResult {
  try {
    fs.mkdirSync(CODEBUDDY_HOME, { recursive: true });
    fs.writeFileSync(CODEBUDDY_HOOKS_PATH, codeBuddyHooksContent(), 'utf-8');
    return {
      strategy: 'always-on',
      target: 'codebuddy',
      extension: 'yondermesh-hooks',
      success: true,
      message: `written to ${CODEBUDDY_HOOKS_PATH} (9 hooks × 4 types)`,
    };
  } catch (e) {
    return {
      strategy: 'always-on',
      target: 'codebuddy',
      extension: 'yondermesh-hooks',
      success: false,
      message: String(e),
    };
  }
}

/**
 * 一键注入全部（MCP + Skills + Always-on + 9 Hooks）。
 * skillsRoot 指向 yondermesh releases/current/skills 目录。
 */
export function injectCodeBuddyAll(skillsRoot?: string): CodeBuddyInjectResult {
  const exts = buildCodeBuddyExtensions();
  const mcpExt = exts.find((e) => e.type === 'mcp-server')!;
  const skillExt = exts.find((e) => e.type === 'skill')!;
  if (skillsRoot) skillExt.skillPath = path.join(skillsRoot, 'yondermesh-diagnose');
  const alwaysExt = exts.find((e) => e.type === 'plugin')!;

  const mcp = injectCodeBuddyMcp(mcpExt);
  mcp.target = 'codebuddy';
  const skill = injectCodeBuddySkill(skillExt);
  skill.target = 'codebuddy';
  const alwaysOn = injectCodeBuddyAlwaysOn(alwaysExt);
  alwaysOn.target = 'codebuddy';
  const hooks = injectCodeBuddyHooks();

  return { mcp, skill, alwaysOn, hooks };
}

/** 移除全部注入 */
export function removeCodeBuddyAll(): MountResult[] {
  const results: MountResult[] = [];
  const mcp = mcpJsonStrategy.unmount('yondermesh', CODEBUDDY_MODELS_JSON);
  mcp.target = 'codebuddy';
  results.push(mcp);
  const skill = skillSymlinkStrategy.unmount('yondermesh-diagnose', CODEBUDDY_SKILLS_DIR);
  skill.target = 'codebuddy';
  results.push(skill);
  const alwaysOn = alwaysOnStrategy.unmount('yondermesh-awareness', CODEBUDDY_AGENTS_MD);
  alwaysOn.target = 'codebuddy';
  results.push(alwaysOn);
  return results;
}

/** 检查注入状态 */
export function checkCodeBuddyInjection(): Record<string, boolean> {
  return {
    mcp: mcpJsonStrategy.isMounted('yondermesh', CODEBUDDY_MODELS_JSON),
    skill: skillSymlinkStrategy.isMounted('yondermesh-diagnose', CODEBUDDY_SKILLS_DIR),
    alwaysOn: fs.existsSync(CODEBUDDY_AGENTS_MD) &&
      fs.readFileSync(CODEBUDDY_AGENTS_MD, 'utf-8').includes(CONTEXT_BLOCK_START),
    hooks: fs.existsSync(CODEBUDDY_HOOKS_PATH),
  };
}

/** 返回 4 种 hook 类型名（供外部展示与校验） */
export function codeBuddyHookTypes(): CodeBuddyHookType[] {
  return ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'];
}
