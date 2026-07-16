/**
 * Continue 注入器 —— MCP / Skills / Always-on 三件套
 *
 * 实测 Continue CLI（@continuedev/cli，v1.5.47）的扩展点（本机 2026-07）：
 *   - MCP 配置：~/.continue/config.yaml 的 `mcpServers:` 段（YAML）
 *       形态（实测 + Continue 官方文档）：
 *         mcpServers:
 *           yondermesh:
 *             type: stdio
 *             command: node
 *             args: [/path/to/ymesh, mcp]
 *             env: {}
 *   - Skills：~/.continue/skills/<name>/SKILL.md（与 ~/.agents/skills/ 共享）
 *       实测已有 yondermesh-diagnose symlink（来自 mount/registry 自动注入）
 *   - Always-on rules：~/.continue/config.yaml 的 `rules:` 段（YAML 字符串数组）
 *       形态：
 *         rules:
 *           - |
 *             yondermesh 集成规则...
 *   - Permissions：~/.continue/permissions.yaml（工具权限，不在本注入器范围）
 *
 * config.yaml 实测：本机文件为 0 字节（空文件）。注入器需要：
 *   - 空文件 → 创建最小可用 YAML
 *   - 已有内容 → 行级保守合并（不引入 yaml 依赖，与 goose inject 一致）
 *
 * 设计原则（沿用 goose inject.ts）：
 *   - 幂等：MCP 按 server name 去重；Skills 按 name 覆盖；Rules 用 ymesh 专属标记
 *     段覆盖更新
 *   - 不破坏用户既有配置：MCP 合并而非覆盖；rules 保留非 ymesh 段
 *   - 零依赖：仅用 node:fs / node:path；YAML 行级解析（不引入 yaml 库）
 *   - 与 mcp/register.ts 风格一致：read/write/isRegistered 三段式
 *
 * GLM-5.2 ✅：Continue 通过 config.yaml 的 `models:` 段配置任意 OpenAI 兼容端点，
 * 本机 GLM-4.6 通过 http://open.bigmodel.cn/api/paas/v4 接入。models 配置不在本
 * 注入器范围（由用户自己写 config.yaml models 段或用 --model 参数）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveCurrentSymlink } from '../install/paths.js';
import { CONTINUE_CONFIG_DIR } from './importer.js';

/** Continue config.yaml 路径 */
export const CONTINUE_CONFIG_PATH = path.join(CONTINUE_CONFIG_DIR, 'config.yaml');

/** Continue skills 目录（~/.continue/skills/） */
export const CONTINUE_SKILLS_DIR = path.join(CONTINUE_CONFIG_DIR, 'skills');

/** yondermesh 自带的 skill 列表（从 release/skills/ 中读取） */
const YONDERMESH_BUNDLED_SKILLS = ['yondermesh-diagnose'];

/** rules 内容版本 */
const CONTINUE_RULES_VERSION = 1;

const SERVER_NAME = 'yondermesh';

// ─── 配置文件读写 ──────────────────────────────────────────────────────

/** 读取 config.yaml 全文（不存在返回空串） */
function readConfig(): string {
  if (!fs.existsSync(CONTINUE_CONFIG_PATH)) return '';
  try {
    return fs.readFileSync(CONTINUE_CONFIG_PATH, 'utf-8');
  } catch {
    return '';
  }
}

/** 写 config.yaml（确保父目录存在） */
function writeConfig(content: string): void {
  fs.mkdirSync(path.dirname(CONTINUE_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONTINUE_CONFIG_PATH, content, 'utf-8');
}

/** ymesh 入口脚本绝对路径（用于 MCP args） */
function resolveYmeshEntry(): string {
  const installed = path.join(os.homedir(), '.yondermesh', 'bin', 'ymesh');
  if (fs.existsSync(installed)) return installed;
  // dev fallback：dist/bin/ymesh.js
  return path.join(process.cwd(), 'dist', 'bin', 'ymesh.js');
}

function resolveNodeBin(): string {
  return process.execPath;
}

// ─── MCP 注入（config.yaml mcpServers:） ──────────────────────────────

export interface ContinueMcpRegistrationResult {
  registered: boolean;
  path: string;
  alreadyPresent?: boolean;
}

/**
 * 把 yondermesh MCP server 注册到 Continue config.yaml 的 mcpServers: 段。
 * 幂等：先移除旧 yondermesh 块再写入。
 *
 * 写入形态（YAML）：
 *   mcpServers:
 *     yondermesh:
 *       type: stdio
 *       command: /path/to/node
 *       args: [/path/to/ymesh, mcp]
 *       env: {}
 */
export function registerMcp(ymeshArgs?: string[]): ContinueMcpRegistrationResult {
  const args = ymeshArgs ?? buildYmeshArgs();
  const nodeBin = resolveNodeBin();
  const entry = args[0] ?? '';
  const rest = args.slice(1);

  const content = readConfig();
  const lines = content.split('\n');
  // 先移除旧 yondermesh mcpServers 子段
  const cleaned = removeMcpServerBlock(lines, SERVER_NAME);

  // 确保 mcpServers: 段存在
  const hasMcp = cleaned.some((l) => l.trim() === 'mcpServers:');
  if (!hasMcp) {
    if (cleaned.length > 0 && cleaned[cleaned.length - 1]!.trim() !== '') {
      cleaned.push('');
    }
    cleaned.push('mcpServers:');
  }

  // 在 mcpServers: 段下追加 yondermesh 子段
  const mcpIdx = cleaned.findIndex((l) => l.trim() === 'mcpServers:');
  const block = [
    `  ${SERVER_NAME}:`,
    `    type: stdio`,
    `    command: "${nodeBin}"`,
    `    args: ${JSON.stringify([entry, ...rest])}`,
    `    env: {}`,
  ];
  // 找到 mcpServers 段末尾（下一个顶层 key 或文件尾）
  let insertAt = mcpIdx + 1;
  while (insertAt < cleaned.length && !/^\S/.test(cleaned[insertAt]!)) {
    insertAt++;
  }
  cleaned.splice(insertAt, 0, ...block);
  writeConfig(cleaned.join('\n'));
  return { registered: true, path: CONTINUE_CONFIG_PATH, alreadyPresent: false };
}

/** 从 config.yaml 移除 yondermesh mcpServers 块（幂等） */
export function unregisterMcp(): boolean {
  const content = readConfig();
  if (!content.includes(`${SERVER_NAME}:`)) return false;
  const cleaned = removeMcpServerBlock(content.split('\n'), SERVER_NAME);
  writeConfig(cleaned.join('\n'));
  return true;
}

export function isMcpRegistered(): boolean {
  const content = readConfig();
  const lines = content.split('\n');
  let inMcp = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'mcpServers:') {
      inMcp = true;
      continue;
    }
    if (inMcp) {
      // 检测是否离开 mcpServers 段：原始行首非空格 = 顶层 key
      if (/^\S/.test(line)) {
        inMcp = false;
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
  const args = [entry, 'mcp'];
  if (extraDbPath) args.push('--db', extraDbPath);
  return args;
}

// ─── Skills（~/.continue/skills/） ────────────────────────────────────

export interface ContinueSkillEntry {
  name: string;
  path: string;
  hasSkillMd: boolean;
}

/** 列出 Continue 已安装的 skills */
export function listSkills(): ContinueSkillEntry[] {
  if (!fs.existsSync(CONTINUE_SKILLS_DIR)) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = fs.readdirSync(CONTINUE_SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ContinueSkillEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const skillPath = path.join(CONTINUE_SKILLS_DIR, e.name);
    const skillMd = path.join(skillPath, 'SKILL.md');
    out.push({ name: e.name, path: skillPath, hasSkillMd: fs.existsSync(skillMd) });
  }
  return out;
}

/**
 * 把一个 skill 目录（含 SKILL.md）软链到 ~/.continue/skills/<name>。
 * 已存在同名 skill 不覆盖（幂等）。该目录与其他 agent 共享。
 */
export function installSkill(
  sourceDir: string,
  name?: string,
): { installed: boolean; path: string; reason?: string } {
  const skillName = name ?? sourceDir.split('/').pop() ?? 'skill';
  const target = path.join(CONTINUE_SKILLS_DIR, skillName);
  if (fs.existsSync(target)) {
    return { installed: false, path: target, reason: 'skill already exists' };
  }
  fs.mkdirSync(CONTINUE_SKILLS_DIR, { recursive: true });
  try {
    fs.symlinkSync(sourceDir, target, 'dir');
    return { installed: true, path: target };
  } catch {
    return { installed: false, path: target, reason: 'symlink failed' };
  }
}

/**
 * 注入 ymesh 自带 skills：把 release/skills/ 下所有子目录软链到
 * ~/.continue/skills/。幂等：已存在的 symlink 先移除再重建（跟随 release 切换）。
 */
export function injectBundledSkills(): {
  linked: string[];
  skipped: string[];
} {
  const linked: string[] = [];
  const skipped: string[] = [];

  fs.mkdirSync(CONTINUE_SKILLS_DIR, { recursive: true });

  const currentRelease = resolveCurrentSymlink();
  const skillsRoot = path.join(currentRelease, 'skills');
  if (!fs.existsSync(skillsRoot)) {
    skipped.push('no skills directory in current release');
    return { linked, skipped };
  }

  let bundledSkills: string[] = [];
  try {
    bundledSkills = fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    bundledSkills = YONDERMESH_BUNDLED_SKILLS;
  }

  for (const skillName of bundledSkills) {
    const skillSource = path.join(skillsRoot, skillName);
    const linkPath = path.join(CONTINUE_SKILLS_DIR, skillName);

    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(linkPath);
      } else if (stat.isDirectory()) {
        skipped.push(`${skillName} is real dir (skipped)`);
        continue;
      } else if (stat.isFile()) {
        fs.unlinkSync(linkPath);
      }
    } catch {
      // 不存在 → 直接创建
    }

    try {
      fs.symlinkSync(skillSource, linkPath, 'dir');
      linked.push(skillName);
    } catch (e) {
      skipped.push(`${skillName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { linked, skipped };
}

// ─── Always-on rules ──────────────────────────────────────────────────

/** 生成 yondermesh rules 内容（YAML 字符串字面量，含标记段） */
function generateRulesContent(): string {
  return [
    `# <!-- yondermesh v${CONTINUE_RULES_VERSION} -->`,
    '# Yondermesh 集成',
    '',
    '本机已部署 yondermesh —— 一个 self-hosted agent context bus。',
    '通过它可以让本机的多个 AI agent（Claude Code / Codex / Continue / Windsurf 等）',
    '互相看到彼此的 session 历史、互相转交任务、跨设备同步上下文。',
    '',
    '可用 MCP 工具（已自动注册到 Continue）：',
    '- `yondermesh` MCP server：查询/检索/转交 session，详见 `ymesh mcp`',
    '',
    '可用 CLI 命令（在终端运行）：',
    '- `ymesh sessions` —— 列出所有 session',
    '- `ymesh scan` —— 扫描本机全部 session 入库',
    '',
    '注意事项：',
    '- Continue 的 session 通过 ~/.continue/sessions/<uuid>.json 采集',
    '  （来源标记 `continue`，A 级原生 adapter）',
    '- 你的对话内容（user/assistant 文本）会被存入本地 ymesh SQLite，跨 agent 可读',
    '- 思维链 / tool_use / tool_result 不被采集（仅最终显示文本）',
    '# <!-- /yondermesh -->',
  ].join('\n');
}

/**
 * 注入 Always-on rules：把 ymesh rules 段写入 config.yaml 的 `rules:` 数组。
 * 幂等：用 ymesh 专属标记段覆盖更新，保留非 ymesh 段。
 *
 * 形态（YAML）：
 *   rules:
 *     - |
 *       # <!-- yondermesh v1 -->
 *       ...内容...
 *       # <!-- /yondermesh -->
 *     - <其他用户 rule>
 */
export function setAlwaysOnRules(): { written: boolean; path: string } {
  const rulesContent = generateRulesContent();
  const content = readConfig();
  const lines = content.split('\n');

  // 已含 ymesh 段 → 检测版本
  if (content.includes(`<!-- yondermesh v`)) {
    if (content.includes(`<!-- yondermesh v${CONTINUE_RULES_VERSION} -->`)) {
      return { written: false, path: CONTINUE_CONFIG_PATH };
    }
    // 旧版本 → 替换 ymesh 段（先移除旧块，再写入新块）
    const cleaned = removeRulesBlock(lines);
    return writeRulesBlock(cleaned, rulesContent);
  }

  // 新增 ymesh 段
  return writeRulesBlock(lines, rulesContent);
}

/** 把 rules 块写入 lines（确保 rules: 段存在），并返回结果 */
function writeRulesBlock(
  lines: string[],
  rulesContent: string,
): { written: boolean; path: string } {
  // 确保 rules: 段存在
  const hasRules = lines.some((l) => l.trim() === 'rules:');
  if (!hasRules) {
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') {
      lines.push('');
    }
    lines.push('rules:');
  }

  const rulesIdx = lines.findIndex((l) => l.trim() === 'rules:');

  // 把 rulesContent 转成 YAML block scalar 行（每行缩进 6 空格，对应 "- |" 块内）
  const block = ['  - |'];
  for (const line of rulesContent.split('\n')) {
    block.push(`    ${line}`);
  }

  // 找到 rules: 段末尾插入位置
  let insertAt = rulesIdx + 1;
  while (insertAt < lines.length && !/^\S/.test(lines[insertAt]!)) {
    insertAt++;
  }
  lines.splice(insertAt, 0, ...block);
  writeConfig(lines.join('\n'));
  return { written: true, path: CONTINUE_CONFIG_PATH };
}

/** 移除 rules: 段下的 ymesh 块（保留其他 rules 条目） */
function removeRulesBlock(lines: string[]): string[] {
  const out: string[] = [];
  let inRules = false;
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'rules:') {
      inRules = true;
      out.push(line);
      continue;
    }
    if (inRules) {
      // 检测是否离开 rules 段：原始行首非空格 = 顶层 key
      if (/^\S/.test(line)) {
        inRules = false;
        skipping = false;
        out.push(line);
        continue;
      }
      // 在 rules 段内
      // 检测 ymesh 块开始：形如 "  - |" 后跟含 <!-- yondermesh v --> 的内容
      // 简化判定：当遇到含 yondermesh 标记的条目时开始跳过，直到 /yondermesh 标记
      if (!skipping && /<!-- yondermesh v\d+ -->/.test(line)) {
        skipping = true;
        // 当前行可能是块开始 "- |" 行或块内行；回溯移除上一行（- | 行）
        if (out.length > 0 && out[out.length - 1]!.trim() === '- |') {
          out.pop();
        }
        // 若同行已含 /yondermesh → 单行块，直接跳过
        if (/<!-- \/yondermesh -->/.test(line)) {
          skipping = false;
        }
        continue;
      }
      if (skipping) {
        if (/<!-- \/yondermesh -->/.test(line)) {
          skipping = false;
        }
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }
  // 清理尾部空行
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return out;
}

export function clearAlwaysOnRules(): boolean {
  const content = readConfig();
  if (!content.includes('<!-- yondermesh v')) return false;
  const cleaned = removeRulesBlock(content.split('\n'));
  writeConfig(cleaned.join('\n'));
  return true;
}

export function getAlwaysOnRulesVersion(): number | null {
  const content = readConfig();
  const m = content.match(/<!-- yondermesh v(\d+) -->/);
  return m ? parseInt(m[1]!, 10) : null;
}

// ─── 组合操作 ─────────────────────────────────────────────────────────

export interface ContinueInjectResult {
  mcp: ContinueMcpRegistrationResult;
  skills: { linked: string[]; skipped: string[] };
  rules: { written: boolean; path: string };
}

/** 注入选项 */
export interface ContinueInjectOptions {
  /** 是否注册 MCP（默认 true） */
  mcp?: boolean;
  /** 是否链接 Skills（默认 true） */
  skills?: boolean;
  /** 是否写 Always-on rules（默认 true） */
  rules?: boolean;
  /** ymesh 二进制路径覆盖（用于 MCP command） */
  ymeshBin?: string;
}

/**
 * 一次性注入 MCP + Skills + Always-on rules。
 * 幂等：可重复执行，不会产生重复注册或破坏既有配置。
 */
export function injectContinue(options: ContinueInjectOptions = {}): ContinueInjectResult {
  const doMcp = options.mcp ?? true;
  const doSkills = options.skills ?? true;
  const doRules = options.rules ?? true;

  fs.mkdirSync(CONTINUE_CONFIG_DIR, { recursive: true });

  const result: ContinueInjectResult = {
    mcp: { registered: false, path: CONTINUE_CONFIG_PATH },
    skills: { linked: [], skipped: [] },
    rules: { written: false, path: CONTINUE_CONFIG_PATH },
  };

  if (doMcp) {
    // 检查是否已注册，避免重复写入
    if (isMcpRegistered()) {
      result.mcp = { registered: true, path: CONTINUE_CONFIG_PATH, alreadyPresent: true };
    } else {
      const args = buildYmeshArgs();
      // 注：若用户传入 ymeshBin，覆盖 args[0]
      if (options.ymeshBin) args[0] = options.ymeshBin;
      result.mcp = registerMcp(args);
    }
  }
  if (doSkills) {
    result.skills = injectBundledSkills();
  }
  if (doRules) {
    result.rules = setAlwaysOnRules();
  }

  return result;
}

/**
 * 移除 yondermesh 注入（uninstall 时调用）
 * 仅移除 ymesh 自己写的部分，保留用户其他配置
 */
export function uninstallContinueInjection(): {
  mcp: boolean;
  skills: string[];
  rules: boolean;
} {
  // MCP：移除 yondermesh server
  const mcpRemoved = unregisterMcp();

  // Skills：移除所有 release/skills/ 来源的 symlink
  const skillsRemoved: string[] = [];
  const currentRelease = resolveCurrentSymlink();
  const skillsRoot = path.join(currentRelease, 'skills');
  if (fs.existsSync(CONTINUE_SKILLS_DIR) && fs.existsSync(skillsRoot)) {
    let bundled: string[] = [];
    try {
      bundled = fs
        .readdirSync(skillsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // ignore
    }
    for (const name of bundled) {
      const linkPath = path.join(CONTINUE_SKILLS_DIR, name);
      try {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(linkPath);
          skillsRemoved.push(name);
        }
      } catch {
        // ignore
      }
    }
  }

  // Rules：移除 ymesh 段
  const rulesRemoved = clearAlwaysOnRules();

  return { mcp: mcpRemoved, skills: skillsRemoved, rules: rulesRemoved };
}

// ─── 内部辅助 ─────────────────────────────────────────────────────────

/**
 * 从 config.yaml 移除 mcpServers.<name> 子段。
 * 形态：mcpServers: 下 2 空格缩进的 <name>: 块，到下一个同级条目或顶层 key。
 * 与 goose/inject.ts 的 removeExtensionBlock 同模式。
 */
function removeMcpServerBlock(lines: string[], name: string): string[] {
  const out: string[] = [];
  let inMcp = false;
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'mcpServers:') {
      inMcp = true;
      out.push(line);
      continue;
    }
    if (inMcp) {
      // 检测是否离开 mcpServers 段：原始行首非空格 = 顶层 key
      if (/^\S/.test(line)) {
        inMcp = false;
        skipping = false;
        out.push(line);
        continue;
      }
      // 在 mcpServers 段内
      const isNameEntry = new RegExp(`^${name}\\s*:`).test(trimmed);
      if (isNameEntry) {
        skipping = true;
        continue;
      }
      if (skipping) {
        // yondermesh 块的子项（4+ 空格缩进或更深），跳过
        // 遇到 mcpServers 下的下一个 2 空格同级条目则停止跳过
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
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return out;
}
