/**
 * 四种挂载策略的具体实现
 *
 * 每个策略知道如何：写入配置 / 创建 symlink / 调用 CLI 命令，
 * 以及如何检查是否已挂载和如何卸载。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import type { Extension, MountResult } from './types.js';

// ── mcp-json 策略 (Cursor / Gemini / Windsurf / Continue) ──

/**
 * 向 JSON 配置文件写入 mcpServers 键。
 * 格式：{ "mcpServers": { "name": { command, args, env } } }
 */
export const mcpJsonStrategy = {
  mount(ext: Extension, configPath: string): MountResult {
    try {
      const config = readJsonSafe(configPath);
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers[ext.name] = ext.mcp;
      writeJsonSafe(configPath, config);
      return { strategy: 'mcp-json', target: '', extension: ext.name, success: true, message: `written to ${configPath}` };
    } catch (e) {
      return { strategy: 'mcp-json', target: '', extension: ext.name, success: false, message: String(e) };
    }
  },

  unmount(extName: string, configPath: string): MountResult {
    try {
      const config = readJsonSafe(configPath);
      if (config.mcpServers && config.mcpServers[extName]) {
        delete config.mcpServers[extName];
        writeJsonSafe(configPath, config);
      }
      return { strategy: 'mcp-json', target: '', extension: extName, success: true, message: `removed from ${configPath}` };
    } catch (e) {
      return { strategy: 'mcp-json', target: '', extension: extName, success: false, message: String(e) };
    }
  },

  isMounted(extName: string, configPath: string): boolean {
    const config = readJsonSafe(configPath);
    return !!(config.mcpServers && config.mcpServers[extName]);
  },
};

// ── mcp-toml 策略 (Codex) ──

/**
 * 向 TOML 配置文件写入 [mcp_servers.*] 段。
 * 使用文本操作而非 TOML 解析器，避免引入额外依赖。
 */
export const mcpTomlStrategy = {
  mount(ext: Extension, configPath: string): MountResult {
    try {
      let content = readTextSafe(configPath);
      // 先移除已有的段
      content = tomlRemoveSection(content, ext.name);
      // 追加新段
      const section = tomlFormatSection(ext.name, ext.mcp!);
      content = content.trimEnd() + '\n' + section + '\n';
      fs.writeFileSync(configPath, content, 'utf-8');
      return { strategy: 'mcp-toml', target: '', extension: ext.name, success: true, message: `written to ${configPath}` };
    } catch (e) {
      return { strategy: 'mcp-toml', target: '', extension: ext.name, success: false, message: String(e) };
    }
  },

  unmount(extName: string, configPath: string): MountResult {
    try {
      let content = readTextSafe(configPath);
      content = tomlRemoveSection(content, extName);
      fs.writeFileSync(configPath, content, 'utf-8');
      return { strategy: 'mcp-toml', target: '', extension: extName, success: true, message: `removed from ${configPath}` };
    } catch (e) {
      return { strategy: 'mcp-toml', target: '', extension: extName, success: false, message: String(e) };
    }
  },

  isMounted(extName: string, configPath: string): boolean {
    const content = readTextSafe(configPath);
    return content.includes(`[mcp_servers.${extName}]`);
  },
};

// ── skill-symlink 策略 ──

/**
 * 将 skill 目录 symlink 到 CLI 的 skills/ 目录。
 * symlink 指向 releases/current/skills/<name>，current 切换时自动更新。
 */
export const skillSymlinkStrategy = {
  mount(ext: Extension, skillsDir: string): MountResult {
    try {
      if (!ext.skillPath) {
        return { strategy: 'skill-symlink', target: '', extension: ext.name, success: false, message: 'no skillPath provided' };
      }
      fs.mkdirSync(skillsDir, { recursive: true });
      const linkPath = path.join(skillsDir, ext.name);
      // 移除旧链接（不管指向哪里）
      try { fs.unlinkSync(linkPath); } catch { try { fs.rmSync(linkPath, { force: true }); } catch { /* */ } }
      fs.symlinkSync(ext.skillPath, linkPath, 'dir');
      return { strategy: 'skill-symlink', target: '', extension: ext.name, success: true, message: `linked to ${linkPath}` };
    } catch (e) {
      return { strategy: 'skill-symlink', target: '', extension: ext.name, success: false, message: String(e) };
    }
  },

  unmount(extName: string, skillsDir: string): MountResult {
    try {
      const linkPath = path.join(skillsDir, extName);
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(linkPath);
      }
      return { strategy: 'skill-symlink', target: '', extension: extName, success: true, message: `unlinked ${linkPath}` };
    } catch {
      return { strategy: 'skill-symlink', target: '', extension: extName, success: true, message: 'not mounted' };
    }
  },

  isMounted(extName: string, skillsDir: string): boolean {
    try {
      const linkPath = path.join(skillsDir, extName);
      return fs.existsSync(linkPath) && fs.lstatSync(linkPath).isSymbolicLink();
    } catch {
      return false;
    }
  },
};

// ── claude-mcp 策略 (Claude Code) ──

/**
 * 使用 `claude mcp add/remove` CLI 命令管理 MCP server。
 * Claude Code 的 MCP 配置不存储在 settings.json 中，
 * 而是内部数据库，通过 CLI 命令操作。
 */
export const claudeMcpStrategy = {
  mount(ext: Extension, _home: string): MountResult {
    try {
      if (!ext.mcp) {
        return { strategy: 'claude-mcp', target: '', extension: ext.name, success: false, message: 'no mcp def' };
      }
      // 先移除旧的（幂等）
      try { execSync(`claude mcp remove ${ext.name} -s user`, { stdio: 'pipe', timeout: 5000 }); } catch { /* not mounted */ }
      // 构建命令
      const parts = [`claude`, `mcp`, `add`, ext.name, '-s', 'user', '--', ext.mcp.command, ...ext.mcp.args];
      execSync(parts.join(' '), { stdio: 'pipe', timeout: 10000 });
      return { strategy: 'claude-mcp', target: '', extension: ext.name, success: true, message: 'added via claude mcp' };
    } catch (e) {
      return { strategy: 'claude-mcp', target: '', extension: ext.name, success: false, message: String(e) };
    }
  },

  unmount(extName: string): MountResult {
    try {
      execSync(`claude mcp remove ${extName} -s user`, { stdio: 'pipe', timeout: 5000 });
      return { strategy: 'claude-mcp', target: '', extension: extName, success: true, message: 'removed via claude mcp' };
    } catch (e) {
      return { strategy: 'claude-mcp', target: '', extension: extName, success: true, message: 'not mounted or already removed' };
    }
  },

  isMounted(extName: string): boolean {
    try {
      const out = execSync('claude mcp list 2>&1', { encoding: 'utf-8', timeout: 10000 });
      return out.includes(extName);
    } catch {
      return false;
    }
  },
};

// ── 私有辅助 ──

function readJsonSafe(filePath: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJsonSafe(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function readTextSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/** 从 TOML 内容中移除 [mcp_servers.<name>] 段（含其子表） */
function tomlRemoveSection(content: string, name: string): string {
  const header = `[mcp_servers.${name}]`;
  const lines = content.split('\n');
 const out: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('[mcp_servers.')) {
      skipping = trimmed === header || trimmed.startsWith(header + '.');
    } else if (trimmed.startsWith('[') && !trimmed.startsWith('[mcp_servers')) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/** 生成 TOML 段 */
function tomlFormatSection(name: string, mcp: { command: string; args: string[]; env?: Record<string, string> }): string {
  let out = `[mcp_servers.${name}]\n`;
  out += `command = "${mcp.command}"\n`;
  out += `args = [${mcp.args.map((a) => `"${a}"`).join(', ')}]\n`;
  if (mcp.env && Object.keys(mcp.env).length > 0) {
    out += `\n[mcp_servers.${name}.env]\n`;
    for (const [k, v] of Object.entries(mcp.env)) {
      out += `${k} = "${v}"\n`;
    }
  }
  return out;
}
