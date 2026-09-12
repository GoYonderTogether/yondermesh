/**
 * MountManager — 挂载系统入口
 *
 * 职责：
 *   1. 发现已安装的 CLI
 *   2. 声明 yondermesh 要挂载的扩展列表
 *   3. 按策略将扩展挂载到各 CLI
 *   4. 验证挂载状态
 *   5. 卸载
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { resolveDataDir, resolveCurrentSymlink } from '../install/paths.js';
import { detectInstalledClis } from './registry.js';
import {
  mcpJsonStrategy,
  mcpTomlStrategy,
  mcpTomlArrayStrategy,
  skillSymlinkStrategy,
  claudeMcpStrategy,
  alwaysOnStrategy,
} from './strategies.js';
import type { Extension, MountResult, MountStatus, CliTarget } from './types.js';

/** 生成 awareness 段落内容 */
function generateContextBlock(): string {
  // 这段会被注入到每个 CLI 的指令文件里，每次会话都占 token —— 保持短。
  // 只放「必须知道才能用对」的东西：4 个工具 + 3 条铁律 + 1 条禁忌。
  // 详细场景规则见 skills/yondermesh-agent-bus/SKILL.md。
  return [
    '## yondermesh（本机的 Agent 上下文总线）',
    '',
    '本机所有 CLI agent 的会话都汇总在本地 SQLite 里。你有 **4 个工具**：',
    '',
    '- **`observe`** —— 看。scope 选看哪儿（me/global/project/session/active/tree），filter 只要什么，shape 决定形态。',
    '  筛选用参数，不要后处理：`roles:["user"]` 只看人的话；`min_length:200` 只要长需求；`exclude:["tool"]` 排掉工具链。',
    '- **`message`** —— 说。`delivery`: `now` 立刻发（目标在跑会被拒绝）；`after_turn` 等我这轮结束；`on_reply` 等对方回复完用户、以用户口吻发给它。',
    '- **`orchestrate`** —— 管。`action`: spawn 起新会话 / assign 派活给已有会话 / handoff 接力 / await 等结果 / discuss 多方讨论 / prior 这事以前有人试过吗。',
    '- **`workspace`** —— 标。工作目录的归属分组（`status` 看某目录下现在有哪些 agent 在跑）。',
    '',
    '**三条铁律**：',
    '1. 动手前先 `observe` —— 不知道现状就 spawn，会起一堆重复会话。',
    '2. 能 `assign` 就不要 `spawn` —— 重复会话是上下文分裂的头号来源。',
    '3. `discuss` 必须配不同 model —— 同模型讨论等于同一张嘴说三遍。',
    '',
    '**禁忌**：不要用 `message` 的 `now` 给**正在跑**的会话发消息（外部注入会与它自己的进程双写，损坏会话）。用 `on_reply`。',
    '',
    '**开工先 `message({action:"check"})`** 看有没有别的 agent 给你留言。每个工具响应末尾都带一小块「现状」，不用另外查全局。',
    '',
    'CLI 等价入口：`ymesh observe` / `ymesh message` / `ymesh orchestrate` / `ymesh workspace`（整机诊断 `$yondermesh-diagnose`）。',
  ].join('\n');
}

/** yondermesh 默认挂载的扩展列表 */
export function defaultExtensions(_home?: string): Extension[] {
  const exts: Extension[] = [];

  // MCP server
  const nodeBin = process.execPath;
  const ymeshBin = join(resolveDataDir(), 'bin', 'ymesh');
  exts.push({
    type: 'mcp-server',
    name: 'yondermesh',
    mcp: {
      command: nodeBin,
      args: [ymeshBin, 'mcp'],
    },
  });

  // skill (diagnose)
  const skillsRoot = join(resolveCurrentSymlink(), 'skills', 'yondermesh-diagnose');
  if (existsSync(skillsRoot)) {
    exts.push({
      type: 'skill',
      name: 'yondermesh-diagnose',
      skillPath: skillsRoot,
    });
  }

  // trae-awareness skill (替代 always-on，让 trae 在 skill 列表里看到 ymesh)
  const traeAwarenessSkillPath = join(resolveCurrentSymlink(), 'skills', 'trae-awareness');
  if (existsSync(traeAwarenessSkillPath)) {
    exts.push({
      type: 'skill',
      name: 'trae-awareness',
      skillPath: traeAwarenessSkillPath,
    });
  }

  // agent-bus skill：4 个职能工具的完整场景规则表（always-on 只放铁律，细节在这）
  const agentBusSkillPath = join(resolveCurrentSymlink(), 'skills', 'yondermesh-agent-bus');
  if (existsSync(agentBusSkillPath)) {
    exts.push({
      type: 'skill',
      name: 'yondermesh-agent-bus',
      skillPath: agentBusSkillPath,
    });
  }

  // mailbox skill：跨会话消息的具体用法
  const mailboxSkillPath = join(resolveCurrentSymlink(), 'skills', 'yondermesh-mailbox');
  if (existsSync(mailboxSkillPath)) {
    exts.push({
      type: 'skill',
      name: 'yondermesh-mailbox',
      skillPath: mailboxSkillPath,
    });
  }

  // always-on awareness (全局指令文件注入)
  exts.push({
    type: 'plugin',
    name: 'yondermesh-awareness',
    contextBlock: generateContextBlock(),
  });

  return exts;
}

/** 挂载全部扩展到全部已安装的 CLI */
export function mountAll(home: string = homedir()): MountResult[] {
  const results: MountResult[] = [];
  const clis = detectInstalledClis(home);
  const extensions = defaultExtensions(home);

  for (const cli of clis) {
    for (const ext of extensions) {
      const result = mountExtension(cli, ext, home);
      results.push(result);
    }
  }

  return results;
}

/** 验证全部挂载状态 */
export function verifyAll(home: string = homedir()): MountStatus[] {
  const statuses: MountStatus[] = [];
  const clis = detectInstalledClis(home);
  const extensions = defaultExtensions(home);

  for (const cli of clis) {
    for (const ext of extensions) {
      const status = checkMount(cli, ext, home);
      statuses.push(status);
    }
  }

  return statuses;
}

/** 卸载全部 */
export function unmountAll(home: string = homedir()): MountResult[] {
  const results: MountResult[] = [];
  const clis = detectInstalledClis(home);
  const extensions = defaultExtensions(home);

  for (const cli of clis) {
    for (const ext of extensions) {
      const result = unmountExtension(cli, ext, home);
      results.push(result);
    }
  }

  return results;
}

/** 只挂载到指定 CLI */
export function mountForCli(cliId: string, home: string = homedir()): MountResult[] {
  const clis = detectInstalledClis(home);
  const cli = clis.find((c) => c.id === cliId);
  if (!cli) return [];
  const extensions = defaultExtensions(home);
  return extensions.map((ext) => mountExtension(cli, ext, home));
}

// ── 内部 ──

function mountExtension(cli: CliTarget, ext: Extension, home: string): MountResult {
  for (const cap of cli.capabilities) {
    if (!cap.extensionTypes.includes(ext.type)) continue;

    const paths = cap.resolve(home);
    let result: MountResult;

    switch (cap.strategy) {
      case 'mcp-json':
        result = mcpJsonStrategy.mount(ext, paths.configPath);
        break;
      case 'mcp-toml':
        result = mcpTomlStrategy.mount(ext, paths.configPath);
        break;
      case 'mcp-toml-array':
        result = mcpTomlArrayStrategy.mount(ext, paths.configPath);
        break;
      case 'skill-symlink':
        result = skillSymlinkStrategy.mount(ext, paths.skillsDir);
        break;
      case 'claude-mcp':
        result = claudeMcpStrategy.mount(ext, home);
        break;
      case 'always-on':
        result = alwaysOnStrategy.mount(ext, paths.instructionFile);
        break;
      default:
        return { strategy: cap.strategy, target: cli.id, extension: ext.name, success: false, message: 'unknown strategy' };
    }

    result.target = cli.id;
    return result;
  }

  return { strategy: 'unsupported', target: cli.id, extension: ext.name, success: false, message: `CLI ${cli.id} does not support ${ext.type}` };
}

function checkMount(cli: CliTarget, ext: Extension, home: string): MountStatus {
  for (const cap of cli.capabilities) {
    if (!cap.extensionTypes.includes(ext.type)) continue;
    const paths = cap.resolve(home);

    let mounted = false;
    switch (cap.strategy) {
      case 'mcp-json':
        mounted = mcpJsonStrategy.isMounted(ext.name, paths.configPath);
        break;
      case 'mcp-toml':
        mounted = mcpTomlStrategy.isMounted(ext.name, paths.configPath);
        break;
      case 'mcp-toml-array':
        mounted = mcpTomlArrayStrategy.isMounted(ext.name, paths.configPath);
        break;
      case 'skill-symlink':
        mounted = skillSymlinkStrategy.isMounted(ext.name, paths.skillsDir);
        break;
      case 'claude-mcp':
        mounted = claudeMcpStrategy.isMounted(ext.name);
        break;
      case 'always-on':
        mounted = alwaysOnStrategy.isMounted(ext.name, paths.instructionFile);
        break;
      }

    return { cli: cli.id, extension: ext.name, type: ext.type, strategy: cap.strategy, mounted };
  }

  return { cli: cli.id, extension: ext.name, type: ext.type, strategy: 'unsupported', mounted: false };
}

function unmountExtension(cli: CliTarget, ext: Extension, home: string): MountResult {
  for (const cap of cli.capabilities) {
    if (!cap.extensionTypes.includes(ext.type)) continue;
    const paths = cap.resolve(home);

    let result: MountResult;
    switch (cap.strategy) {
      case 'mcp-json':
        result = mcpJsonStrategy.unmount(ext.name, paths.configPath);
        break;
      case 'mcp-toml':
        result = mcpTomlStrategy.unmount(ext.name, paths.configPath);
        break;
      case 'mcp-toml-array':
        result = mcpTomlArrayStrategy.unmount(ext.name, paths.configPath);
        break;
      case 'skill-symlink':
        result = skillSymlinkStrategy.unmount(ext.name, paths.skillsDir);
        break;
      case 'claude-mcp':
        result = claudeMcpStrategy.unmount(ext.name);
        break;
      case 'always-on':
        result = alwaysOnStrategy.unmount(ext.name, paths.instructionFile);
        break;
      default:
        return { strategy: cap.strategy, target: cli.id, extension: ext.name, success: false, message: 'unknown strategy' };
    }
    result.target = cli.id;
    return result;
  }

  return { strategy: 'unsupported', target: cli.id, extension: ext.name, success: false, message: `CLI ${cli.id} does not support ${ext.type}` };
}
