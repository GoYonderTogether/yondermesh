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
  skillSymlinkStrategy,
  claudeMcpStrategy,
  alwaysOnStrategy,
} from './strategies.js';
import type { Extension, MountResult, MountStatus, CliTarget } from './types.js';

/** 生成 awareness 段落内容 */
function generateContextBlock(): string {
  return [
    '## yondermesh',
    '',
    'yondermesh is installed on this machine. It indexes all CLI agent sessions (Claude Code, Codex, cass) into a local SQLite vault.',
    '',
    'Available capabilities:',
    '- **MCP tools**: query sessions by time/project/source/topology (if MCP server is mounted)',
    '- **CLI**: run `ymesh help` for commands (scan, status, sessions, doctor, mount)',
    '- **Skill**: `$yondermesh-diagnose` for system health checks',
    '- **Session query**: `ymesh sessions --json --limit 10` to see recent work',
    '',
    'Use these to recall prior work context, check what other agents did, or diagnose issues.',
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
