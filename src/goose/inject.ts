/**
 * Goose 扩展注入：MCP（config.yaml extensions:）+ Skills（~/.agents/skills/）+ Always-on
 *
 * Goose（Block）的扩展机制：
 *
 * 1. MCP servers：通过 ~/.config/goose/config.yaml 的 `extensions:` 段注册。
 *    形态（YAML）：
 *      extensions:
 *        yondermesh:
 *          type: stdio
 *          command: /path/to/node
 *          args: [/path/to/ymesh, mcp]
 *          env: {}
 *    goose 启动新 session 时加载这些 MCP server。
 *
 * 2. Skills：goose 自动加载 ~/.agents/skills/ 下的 skill 目录（与 Trae/其他 agent
 *    共享同一 skills 目录）。SKILL.md 为入口。
 *
 * 3. Always-on context：通过 config.yaml 的 `GOOSE_SYSTEM_PROMPT` 或
 *    `system_prompt:` 字段注入常驻提示。
 *
 * 设计原则：
 *   - 与 mcp/register.ts 风格一致：read/write/isRegistered 三段式
 *   - YAML 操作采用保守的行级解析（不引入 yaml 依赖），与 codex TOML 处理一致
 *   - 注入幂等：重复调用不堆积
 *
 * GLM-5.2 ✅：Goose 内置 zhipu provider，通过 config.yaml 配置 provider +
 *   ZHIPU_BASE_URL 自定义端点接入（provider 配置不在本模块，由 goose configure 负责）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const SERVER_NAME = 'yondermesh';

/** ~/.config/goose 根目录（XDG） */
function gooseConfigDir(): string {
  return process.env.GOOSE_CONFIG_DIR ?? join(homedir(), '.config', 'goose');
}

/** config.yaml 路径 */
function configPath(): string {
  return join(gooseConfigDir(), 'config.yaml');
}

/** skills 目录：~/.agents/skills/（与其他 agent 共享） */
function skillsDir(): string {
  return process.env.GOOSE_SKILLS_DIR ?? join(homedir(), '.agents', 'skills');
}

/** 读取 config.yaml 全文（不存在返回空串） */
function readConfig(): string {
  const p = configPath();
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

/** 写 config.yaml */
function writeConfig(content: string): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf-8');
}

// ─── MCP 注入（config.yaml extensions:） ────────────────────────────────

/** ymesh 入口脚本绝对路径 */
function resolveYmeshEntry(): string {
  const installed = join(homedir(), '.yondermesh', 'bin', 'ymesh');
  if (existsSync(installed)) return installed;
  return '';
}

function resolveNodeBin(): string {
  return process.execPath;
}

export interface McpRegistrationResult {
  registered: boolean;
  path: string;
}

/**
 * 把 yondermesh MCP server 注册到 Goose config.yaml 的 extensions: 段。
 * 幂等：先移除旧 yondermesh 块再写入。
 *
 * 写入形态：
 *   extensions:
 *     yondermesh:
 *       type: stdio
 *       command: /path/to/node
 *       args: [/path/to/ymesh, mcp]
 */
export function registerMcp(ymeshArgs?: string[]): McpRegistrationResult {
  const args = ymeshArgs ?? buildYmeshArgs();
  const nodeBin = resolveNodeBin();
  const entry = args[0] ?? '';
  const rest = args.slice(1);

  const content = readConfig();
  const lines = content.split('\n');
  // 先移除旧 yondermesh extension 块（extensions.yondermesh 子段）
  const cleaned = removeExtensionBlock(lines, SERVER_NAME);

  // 确保 extensions: 段存在
  const hasExtensions = cleaned.some((l) => l.trim() === 'extensions:');
  if (!hasExtensions) {
    cleaned.push('');
    cleaned.push('extensions:');
  }

  // 在 extensions: 段下追加 yondermesh 子段
  // 找到 extensions: 行的位置，在其后（跳过已有同级条目）插入
  const extIdx = cleaned.findIndex((l) => l.trim() === 'extensions:');
  const block = [
    `  ${SERVER_NAME}:`,
    `    type: stdio`,
    `    command: "${nodeBin}"`,
    `    args: ${JSON.stringify([entry, ...rest])}`,
    `    env: {}`,
  ];
  // 找到 extensions 段的末尾（下一个顶层 key 或文件尾）
  let insertAt = extIdx + 1;
  while (insertAt < cleaned.length && !/^\S/.test(cleaned[insertAt]!)) {
    insertAt++;
  }
  cleaned.splice(insertAt, 0, ...block);
  writeConfig(cleaned.join('\n'));
  return { registered: true, path: configPath() };
}

/** 从 config.yaml 移除 yondermesh extension 块（幂等） */
export function unregisterMcp(): boolean {
  const content = readConfig();
  if (!content.includes(`${SERVER_NAME}:`)) return false;
  const cleaned = removeExtensionBlock(content.split('\n'), SERVER_NAME);
  writeConfig(cleaned.join('\n'));
  return true;
}

export function isMcpRegistered(): boolean {
  const content = readConfig();
  // 检查 extensions: 段下是否含 yondermesh: 条目
  const lines = content.split('\n');
  let inExtensions = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'extensions:') {
      inExtensions = true;
      continue;
    }
    if (inExtensions) {
      if (/^\S/.test(trimmed)) {
        inExtensions = false;
        continue;
      }
      if (trimmed === `${SERVER_NAME}:`) return true;
    }
  }
  return false;
}

/** 构建注册用的 ymesh 参数 */
export function buildYmeshArgs(extraDbPath?: string): string[] {
  const entry = resolveYmeshEntry();
  if (entry) {
    const args = [entry, 'mcp'];
    if (extraDbPath) args.push('--db', extraDbPath);
    return args;
  }
  const devEntry = join(process.cwd(), 'dist', 'bin', 'ymesh.js');
  const args = [devEntry, 'mcp'];
  if (extraDbPath) args.push('--db', extraDbPath);
  return args;
}

// ─── Skills（~/.agents/skills/） ────────────────────────────────────────

export interface SkillEntry {
  name: string;
  path: string;
  hasSkillMd: boolean;
}

/** 列出 goose 已安装的 skills（~/.agents/skills/<name>/SKILL.md） */
export function listSkills(): SkillEntry[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const skillPath = join(dir, e.name);
    const skillMd = join(skillPath, 'SKILL.md');
    out.push({ name: e.name, path: skillPath, hasSkillMd: existsSync(skillMd) });
  }
  return out;
}

/**
 * 把一个 skill 目录（含 SKILL.md）软链到 ~/.agents/skills/<name>。
 * 已存在同名 skill 不覆盖（幂等）。该目录与其他 agent 共享。
 */
export function installSkill(sourceDir: string, name?: string): { installed: boolean; path: string; reason?: string } {
  const skillName = name ?? sourceDir.split('/').pop() ?? 'skill';
  const target = join(skillsDir(), skillName);
  if (existsSync(target)) {
    return { installed: false, path: target, reason: 'skill already exists' };
  }
  mkdirSync(skillsDir(), { recursive: true });
  try {
    symlinkSync(sourceDir, target, 'dir');
    return { installed: true, path: target };
  } catch {
    return { installed: false, path: target, reason: 'symlink failed' };
  }
}

// ─── Always-on context ──────────────────────────────────────────────────

/**
 * 注入常驻上下文（system_prompt）。
 * 写入 config.yaml 顶层 system_prompt: 字段（幂等覆盖）。
 */
export function setAlwaysOnContext(context: string): { set: boolean; path: string } {
  const content = readConfig();
  const lines = content.split('\n');
  // 移除已有 system_prompt: 行
  const cleaned = lines.filter((l) => !/^system_prompt\s*:/.test(l.trim()));
  // 在文件开头插入（确保是顶层 key）
  cleaned.unshift(`system_prompt: ${JSON.stringify(context)}`);
  writeConfig(cleaned.join('\n'));
  return { set: true, path: configPath() };
}

export function getAlwaysOnContext(): string | null {
  const content = readConfig();
  const lines = content.split('\n');
  for (const line of lines) {
    const m = /^system_prompt\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line.trim());
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return null;
}

export function clearAlwaysOnContext(): boolean {
  const content = readConfig();
  if (!/^system_prompt\s*:/.test(content)) return false;
  const cleaned = content.split('\n').filter((l) => !/^system_prompt\s*:/.test(l.trim()));
  writeConfig(cleaned.join('\n'));
  return true;
}

// ─── 组合操作 ───────────────────────────────────────────────────────────

export interface FullInjectResult {
  mcp: McpRegistrationResult;
  alwaysOnSet: boolean;
}

/** 一次性注入 MCP + Always-on（skills 需单独 installSkill） */
export function injectAll(opts: {
  ymeshArgs?: string[];
  alwaysOnContext?: string;
}): FullInjectResult {
  const mcp = registerMcp(opts.ymeshArgs);
  let alwaysOnSet = false;
  if (opts.alwaysOnContext !== undefined) {
    alwaysOnSet = setAlwaysOnContext(opts.alwaysOnContext).set;
  }
  return { mcp, alwaysOnSet };
}

// ─── 内部辅助 ───────────────────────────────────────────────────────────

/**
 * 从 config.yaml 移除 extensions.<name> 子段。
 * 形态：extensions: 下 2 空格缩进的 <name>: 块，到下一个同级条目或顶层 key。
 */
function removeExtensionBlock(lines: string[], name: string): string[] {
  const out: string[] = [];
  let inExtensions = false;
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'extensions:') {
      inExtensions = true;
      out.push(line);
      continue;
    }
    if (inExtensions) {
      if (/^\S/.test(trimmed)) {
        // 离开 extensions 段
        inExtensions = false;
        skipping = false;
        out.push(line);
        continue;
      }
      // 在 extensions 段内
      const isNameEntry = new RegExp(`^${name}\\s*:`).test(trimmed);
      if (isNameEntry) {
        skipping = true;
        continue;
      }
      if (skipping) {
        // yondermesh 块的子项（4+ 空格缩进或更深），跳过
        // 遇到 extensions 下的下一个 2 空格同级条目则停止跳过
        if (/^  \S/.test(line) && !/^    /.test(line)) {
          skipping = false;
          out.push(line);
        }
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }
  // 清理尾部空行
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}
