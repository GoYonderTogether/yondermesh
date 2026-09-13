/**
 * 四种挂载策略的具体实现
 *
 * 每个策略知道如何：写入配置 / 创建 symlink / 调用 CLI 命令，
 * 以及如何检查是否已挂载和如何卸载。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

import type { Extension, MountResult } from './types.js';
import { CONTEXT_BLOCK_START, CONTEXT_BLOCK_END } from './types.js';

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

// ── mcp-toml-array 策略 (Vibe) ──

/**
 * 向 TOML 配置文件写入 [[mcp_servers]] array-of-tables 段。
 *
 * Vibe 的 config.toml 使用 array-of-tables 而非 Codex 的 [mcp_servers.*] 子表。
 * TOML 陷阱：顶层 scalar 必须放在所有 [[...]] 段之前，否则会被附加到最近的 table。
 * 本策略只追加 [[mcp_servers]] 段到文件末尾（不新增顶层 scalar），故天然安全；
 * 移除时按 name 字段匹配整个 [[mcp_servers]] 块删除。
 */
export const mcpTomlArrayStrategy = {
  mount(ext: Extension, configPath: string): MountResult {
    try {
      let content = readTextSafe(configPath);
      // 先移除已有的同名 [[mcp_servers]] 块
      content = tomlRemoveArrayEntry(content, ext.name);
      // 追加新段到末尾（顶层 scalar 不受影响）
      const section = tomlFormatArrayEntry(ext.name, ext.mcp!);
      content = content.trimEnd() + '\n' + section + '\n';
      const dir = path.dirname(configPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, content, 'utf-8');
      return { strategy: 'mcp-toml-array', target: '', extension: ext.name, success: true, message: `written to ${configPath}` };
    } catch (e) {
      return { strategy: 'mcp-toml-array', target: '', extension: ext.name, success: false, message: String(e) };
    }
  },

  unmount(extName: string, configPath: string): MountResult {
    try {
      let content = readTextSafe(configPath);
      content = tomlRemoveArrayEntry(content, extName);
      content = content.trimEnd();
      if (content) content += '\n';
      fs.writeFileSync(configPath, content, 'utf-8');
      return { strategy: 'mcp-toml-array', target: '', extension: extName, success: true, message: `removed from ${configPath}` };
    } catch (e) {
      return { strategy: 'mcp-toml-array', target: '', extension: extName, success: false, message: String(e) };
    }
  },

  isMounted(extName: string, configPath: string): boolean {
    const content = readTextSafe(configPath);
    return tomlHasArrayEntry(content, extName);
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
      if (!fs.existsSync(linkPath)) return false;
      if (!fs.lstatSync(linkPath).isSymbolicLink()) return false;
      // 校验 symlink 指向 ymesh release skills 目录，避免其他工具（如 lark-*
      // marketplace）创建的同名 symlink 被误判为 ymesh 挂载。
      const target = fs.readlinkSync(linkPath);
      return target.includes('yondermesh') || target.includes('ymesh') || target.includes('release');
    } catch {
      return false;
    }
  },
};

// ── CLI 可执行文件解析 ──

/**
 * 解析 CLI 可执行文件的绝对路径。
 *
 * 为什么不能只靠 PATH：daemon 由 LaunchAgent 托管，launchd 给的环境 PATH 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，而 `claude` 装在 `~/.local/bin/claude`
 * —— 于是 daemon 里的 auto-mount 每次都失败（实测日志：128/129，失败项
 * `yondermesh@claude-code(claude-mcp)`），而手动 `ymesh mount all` 又一切正常。
 * 这类「同一条命令，人和 daemon 跑出两种结果」的坑，只能靠显式解析路径解决。
 */
function resolveCliBinary(name: string): string {
  try {
    const found = execSync(`which ${name} 2>/dev/null`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (found) return found;
  } catch {
    // PATH 里没有，继续找常见安装位置
  }
  const home = homedir();
  const candidates = [
    path.join(home, '.local', 'bin', name),
    path.join(home, '.claude', 'local', name),
    path.join(home, '.bun', 'bin', name),
    path.join(home, '.npm-global', 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return name; // 找不到就原样返回，让调用方按原方式报错
}

// ── claude-mcp 策略 (Claude Code) ──

/**
 * 使用 `claude mcp add/remove` CLI 命令管理 MCP server。
 * Claude Code 的 MCP 配置不存储在 settings.json 中，
 * 而是内部数据库，通过 CLI 命令操作。
 */
/**
 * Claude Code 的 MCP 注册落在 `~/.claude.json` 的 mcpServers 下。
 * 这里只做「已注册且定义完全一致」的判断，用于跳过无意义的 remove+add。
 *
 * 为什么要跳过：auto-mount 每次 reconcile（默认每分钟）都会跑一遍，
 * 而 claude-mcp 策略要 spawn 两次 claude CLI（remove + add）。实测这既拖慢
 * 每轮挂载（129 个挂载点里就它最贵），也是 128/129 偶发失败的来源
 * （claude CLI 冷启动/被占用时 remove 或 add 会失败）。
 */
export function claudeMcpEntryMatches(config: unknown, ext: Extension): boolean {
  if (!ext.mcp) return false;
  const servers = (config as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
  const entry = servers?.[ext.name] as { command?: unknown; args?: unknown } | undefined;
  if (!entry) return false;
  if (entry.command !== ext.mcp.command) return false;
  return JSON.stringify(entry.args ?? []) === JSON.stringify(ext.mcp.args);
}

/** 读 ~/.claude.json 判断是否已按当前定义注册（读不到/解析失败 → false，回退到重挂） */
function claudeMcpAlreadyRegistered(ext: Extension, home: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(home, '.claude.json'), 'utf-8');
    return claudeMcpEntryMatches(JSON.parse(raw), ext);
  } catch {
    return false;
  }
}

export const claudeMcpStrategy = {
  mount(ext: Extension, home: string): MountResult {
    try {
      if (!ext.mcp) {
        return { strategy: 'claude-mcp', target: '', extension: ext.name, success: false, message: 'no mcp def' };
      }
      // 定义没变就别折腾外部 CLI（见 claudeMcpEntryMatches 注释）
      if (claudeMcpAlreadyRegistered(ext, home)) {
        return { strategy: 'claude-mcp', target: '', extension: ext.name, success: true, message: 'already registered (verified)' };
      }
      // 先移除旧的（幂等）
      const claudeBin = resolveCliBinary('claude');
      try { execSync(`${claudeBin} mcp remove ${ext.name} -s user`, { stdio: 'pipe', timeout: 5000 }); } catch { /* not mounted */ }
      // 构建命令
      const parts = [claudeBin, `mcp`, `add`, ext.name, '-s', 'user', '--', ext.mcp.command, ...ext.mcp.args];
      execSync(parts.join(' '), { stdio: 'pipe', timeout: 30000 });
      return { strategy: 'claude-mcp', target: '', extension: ext.name, success: true, message: 'added via claude mcp' };
    } catch (e) {
      return { strategy: 'claude-mcp', target: '', extension: ext.name, success: false, message: String(e) };
    }
  },

  unmount(extName: string): MountResult {
    try {
      execSync(`${resolveCliBinary('claude')} mcp remove ${extName} -s user`, { stdio: 'pipe', timeout: 5000 });
      return { strategy: 'claude-mcp', target: '', extension: extName, success: true, message: 'removed via claude mcp' };
    } catch (e) {
      return { strategy: 'claude-mcp', target: '', extension: extName, success: true, message: 'not mounted or already removed' };
    }
  },

  isMounted(extName: string): boolean {
    try {
      const out = execSync(`${resolveCliBinary('claude')} mcp list 2>&1`, { encoding: 'utf-8', timeout: 20000 });
      return out.includes(extName);
    } catch {
      return false;
    }
  },
};

// ── always-on 策略 ──

/**
 * 向全局指令文件注入一个带边界标记的段落。
 * 每次新 session 启动时，CLI 会读取这些文件并注入到上下文中。
 * 段落内容告诉 agent：yondermesh 已安装，MCP 工具可用，CLI 命令可用。
 */
export const alwaysOnStrategy = {
  mount(ext: Extension, instructionFile: string): MountResult {
    try {
      if (!ext.contextBlock) {
        return { strategy: 'always-on', target: '', extension: ext.name, success: false, message: 'no contextBlock provided' };
      }
      let content = readTextSafe(instructionFile);
      // 先移除已有段落
      content = removeBlock(content);
      // 追加新段落
      const block = `${CONTEXT_BLOCK_START}\n${ext.contextBlock}\n${CONTEXT_BLOCK_END}\n`;
      content = content.trimEnd() + '\n\n' + block;
      const dir = path.dirname(instructionFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(instructionFile, content, 'utf-8');
      return { strategy: 'always-on', target: '', extension: ext.name, success: true, message: `injected into ${instructionFile}` };
    } catch (e) {
      return { strategy: 'always-on', target: '', extension: ext.name, success: false, message: String(e) };
    }
  },

 unmount(_extName: string, instructionFile: string): MountResult {
   try {
     let content = readTextSafe(instructionFile);
     content = removeBlock(content);
     content = content.trimEnd();
     if (content) content += '\n';
     fs.writeFileSync(instructionFile, content, 'utf-8');
      return { strategy: 'always-on', target: '', extension: 'yondermesh-awareness', success: true, message: `removed from ${instructionFile}` };
   } catch (e) {
      return { strategy: 'always-on', target: '', extension: 'yondermesh-awareness', success: false, message: String(e) };
   }
 },

  isMounted(_extName: string, instructionFile: string): boolean {
    const content = readTextSafe(instructionFile);
    // 校验包含完整的 ymesh 标记块（START + END），避免残留/残缺标记误判。
    // CONTEXT_BLOCK_START 即 `<!-- YONDERMESH_AWARENESS_START -->`，含
    // `<!-- YONDERMESH_AWARENESS` 与 `YONDERMESH_START` 标记。
    return content.includes(CONTEXT_BLOCK_START) && content.includes(CONTEXT_BLOCK_END);
  },
};

/** 从内容中移除 always-on 段落（含边界标记） */
function removeBlock(content: string): string {
  const startIdx = content.indexOf(CONTEXT_BLOCK_START);
  if (startIdx === -1) return content;
  const endIdx = content.indexOf(CONTEXT_BLOCK_END);
  if (endIdx === -1) return content; // 残缺标记，不处理
  // 移除标记段及其后的换行
  let before = content.slice(0, startIdx);
  let after = content.slice(endIdx + CONTEXT_BLOCK_END.length);
  // 清理前后的空行
  before = before.trimEnd();
  after = after.replace(/^\s*\n/, '');
  if (before && after) return before + '\n\n' + after;
  return before + after;
}

// ── OpenSpace 残留目录检测 ──

/**
 * 检测目录是否为 OpenSpace（HKUDS）批量创建的残留目录。
 *
 * OpenSpace 会创建空的 `~/.xxx/skills/` 目录，skills/ 下仅含若干指向
 * `~/.agents/skills/` 的 symlink。这些并非真实安装的 agent，detect 时应跳过。
 *
 * 特征：
 *   1. 目录下仅一个名为 `skills` 的子目录
 *   2. `skills/` 非空，且每个条目都是 symlink
 *   3. 所有 symlink 的 target 都包含 `.agents/skills`
 */
export function isOpenSpaceResidual(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const entries = fs.readdirSync(dir);
  if (entries.length !== 1 || entries[0] !== 'skills') return false;
  const skillsDir = path.join(dir, 'skills');
  if (!fs.existsSync(skillsDir)) return false;
  const skillEntries = fs.readdirSync(skillsDir);
  if (skillEntries.length === 0) return false;
  // 检查是否全是 symlink 且指向 ~/.agents/skills/
  for (const entry of skillEntries) {
    const entryPath = path.join(skillsDir, entry);
    try {
      const target = fs.readlinkSync(entryPath);
      if (!target.includes('.agents/skills')) return false;
    } catch {
      return false; // 不是 symlink（普通目录或文件）
    }
  }
  return true;
}

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

// ── mcp-toml-array 辅助 (Vibe [[mcp_servers]]) ──

/**
 * 从 TOML 内容中移除 name 匹配的 [[mcp_servers]] 块。
 * 一个 [[mcp_servers]] 块从 `[[mcp_servers]]` 头到下一个 `[[...]]`/`[...]` 头（或文件尾）。
 * 仅删除其 `name = "<extName>"` 的块。
 */
function tomlRemoveArrayEntry(content: string, extName: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inMcpBlock = false;
  let blockMatches = false;
  let blockLines: string[] = [];

  const flushBlock = (): void => {
    if (blockMatches) {
      // 丢弃该块
    } else {
      out.push(...blockLines);
    }
    blockLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('[[')) {
      // 进入新 array-of-tables 块前，冲刷上一个 mcp 块
      if (inMcpBlock) {
        flushBlock();
        inMcpBlock = false;
      }
      if (trimmed === '[[mcp_servers]]') {
        inMcpBlock = true;
        blockMatches = false;
        blockLines = [line];
        continue;
      }
      out.push(line);
    } else if (trimmed.startsWith('[')) {
      // 进入普通 table 块前，冲刷上一个 mcp 块
      if (inMcpBlock) {
        flushBlock();
        inMcpBlock = false;
      }
      out.push(line);
    } else if (inMcpBlock) {
      blockLines.push(line);
      // 检测 name = "extName"
      const m = trimmed.match(/^name\s*=\s*"([^"]*)"/);
      if (m && m[1] === extName) {
        blockMatches = true;
      }
    } else {
      out.push(line);
    }
  }
  // 文件尾冲刷
  if (inMcpBlock) {
    flushBlock();
  }
  return out.join('\n');
}

/** 检测 TOML 内容是否包含 name 匹配的 [[mcp_servers]] 块 */
function tomlHasArrayEntry(content: string, extName: string): boolean {
  const lines = content.split('\n');
  let inMcpBlock = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('[[')) {
      inMcpBlock = trimmed === '[[mcp_servers]]';
      continue;
    }
    if (trimmed.startsWith('[')) {
      inMcpBlock = false;
      continue;
    }
    if (inMcpBlock) {
      const m = trimmed.match(/^name\s*=\s*"([^"]*)"/);
      if (m && m[1] === extName) return true;
    }
  }
  return false;
}

/** 生成 [[mcp_servers]] array-of-tables 段 */
function tomlFormatArrayEntry(name: string, mcp: { command: string; args: string[]; env?: Record<string, string> }): string {
  let out = '[[mcp_servers]]\n';
  out += `name = "${name}"\n`;
  out += `transport = "stdio"\n`;
  out += `command = "${mcp.command}"\n`;
  out += `args = [${mcp.args.map((a) => `"${a}"`).join(', ')}]\n`;
  out += `startup_timeout_sec = 30.0\n`;
  out += `tool_timeout_sec = 60.0\n`;
  if (mcp.env && Object.keys(mcp.env).length > 0) {
    out += '\n[mcp_servers.env]\n';
    for (const [k, v] of Object.entries(mcp.env)) {
      out += `${k} = "${v}"\n`;
    }
  }
  return out;
}
