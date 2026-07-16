/**
 * Trae IDE 注入器 —— Always-on rules / MCP / Skills 三件套
 *
 * Trae 的「外部集成点」：
 *   - Always-on context：~/.trae[-cn]/project_rules.md（Trae 自动加载到每个 Chat）
 *     实测两个变体：~/.trae/project_rules.md（TRAE SOLO）+ ~/.trae-cn/project_rules.md（TRAE SOLO CN）
 *   - MCP：项目级 .trae/mcp.json（每个项目独立，不在全局 ~/.trae/ 下）
 *   - Skills：~/.trae[-cn]/skills/<name>/ 目录（文件式，symlink 即可）
 *   - 无 hooks.json（Trae 当前没有公开的 hook 机制；session 启停观察依赖 ymesh daemon 周期扫描）
 *
 * 已知 bug 修复：
 *   - isMounted bug：skill-config.json 的 managedSkills 列出了某 skill，但 ~/.trae-cn/skills/<name>/
 *     目录实际不存在 → 检测并报告（不自动创建 marketplace skill，仅修复 ymesh 自带 skill 的缺失）
 *   - ~/.trae-cn/project_rules.md 不存在 → 创建（与 ~/.trae/project_rules.md 同步）
 *
 * 与 Cursor inject.ts 的差异：
 *   - Trae 的 trae-awareness skill 是 CORRECT mounting（Trae 用），与 Cursor 相反
 *   - Trae 的 MCP 是项目级（.trae/mcp.json），不是全局（~/.trae/mcp.json）
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveCurrentSymlink } from '../install/paths.js';
import { TRAE_CONFIG_DIRS, TRAE_RULES_END, TRAE_RULES_START } from './wrapper.js';

/** 项目级 MCP 配置目录（在每个项目根下创建） */
export const TRAE_PROJECT_MCP_DIR = '.trae';
export const TRAE_PROJECT_MCP_FILE = 'mcp.json';

/** yondermesh 自带的 skill 列表（应挂载到 Trae 的 skills/ 下） */
const YONDERMESH_SKILLS_FOR_TRAE = ['yondermesh-diagnose', 'trae-awareness'];

/** rules 内容版本 */
const TRAE_RULES_VERSION = 2;

/** 注入选项 */
export interface TraeInjectOptions {
  /** 是否写 Always-on rules（默认 true） */
  rules?: boolean;
  /** 是否链接 Skills（默认 true） */
  skills?: boolean;
  /** 是否注入项目级 MCP（默认 true，需指定 projectPath） */
  mcp?: boolean;
  /** 项目根路径（用于 MCP 注入；不指定则跳过 MCP） */
  projectPath?: string;
  /** ymesh 二进制路径覆盖 */
  ymeshBin?: string;
  /** 仅注入到指定的 configDir（默认两个都注入） */
  configDirs?: string[];
  /** 是否修复 isMounted bug（检测 managedSkills 但实际目录缺失） */
  fixMountedBug?: boolean;
}

/** 注入结果 */
export interface TraeInjectResult {
  rules: Array<{ configDir: string; written: boolean; path: string }>;
  skills: Array<{
    configDir: string;
    linked: string[];
    skipped: string[];
  }>;
  mcp: { injected: boolean; path?: string; alreadyPresent?: boolean };
  mountedBug: Array<{
    configDir: string;
    missingSkills: string[];
    fixed: string[];
  }>;
}

/** ymesh 二进制路径 */
function resolveYmeshBin(): string {
  try {
    const out = execFileSync('which', ['ymesh'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const p = out.trim();
    if (p) return p;
  } catch {
    // fallback
  }
  return path.join(os.homedir(), '.yondermesh', 'bin', 'ymesh');
}

/**
 * 注入 yondermesh 集成到 Trae IDE。
 * 幂等：可重复执行，不产生重复注册。
 */
export function injectTraeIde(options: TraeInjectOptions = {}): TraeInjectResult {
  const doRules = options.rules ?? true;
  const doSkills = options.skills ?? true;
  const doMcp = options.mcp ?? true;
  const doFixMounted = options.fixMountedBug ?? true;
  const configDirs = options.configDirs ?? TRAE_CONFIG_DIRS.filter((d) => fs.existsSync(d));

  const result: TraeInjectResult = {
    rules: [],
    skills: [],
    mcp: { injected: false },
    mountedBug: [],
  };

  if (doRules) {
    for (const configDir of configDirs) {
      result.rules.push(injectRules(configDir));
    }
  }

  if (doSkills) {
    for (const configDir of configDirs) {
      result.skills.push(injectSkills(configDir));
    }
  }

  if (doFixMounted) {
    for (const configDir of configDirs) {
      result.mountedBug.push(detectAndFixMountedBug(configDir));
    }
  }

  if (doMcp && options.projectPath) {
    result.mcp = injectProjectMcp(options.projectPath, options.ymeshBin ?? resolveYmeshBin());
  }

  return result;
}

/**
 * 注入 Always-on rules 到 ~/.trae[-cn]/project_rules.md
 * 用 TRAE_RULES_START / TRAE_RULES_END 标记包裹 ymesh 段，幂等替换。
 */
function injectRules(configDir: string): {
  configDir: string;
  written: boolean;
  path: string;
} {
  const rulesPath = path.join(configDir, 'project_rules.md');
  const content = generateTraeRulesContent();
  let existing = '';
  if (fs.existsSync(rulesPath)) {
    existing = fs.readFileSync(rulesPath, 'utf-8');
  }

  // 已含 ymesh 段
  if (existing.includes(TRAE_RULES_START)) {
    // 检测版本
    if (existing.includes(`<!-- yondermesh v${TRAE_RULES_VERSION} -->`)) {
      return { configDir, written: false, path: rulesPath };
    }
    // 替换旧版本 ymesh 段
    const replaced = existing.replace(
      new RegExp(`${escapeRegex(TRAE_RULES_START)}[\\s\\S]*?${escapeRegex(TRAE_RULES_END)}`, 'g'),
      content,
    );
    fs.writeFileSync(rulesPath, replaced, 'utf-8');
    return { configDir, written: true, path: rulesPath };
  }

  // 新增 ymesh 段（追加到末尾）
  const newContent = existing.endsWith('\n') || existing === ''
    ? existing + content + '\n'
    : existing + '\n\n' + content + '\n';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(rulesPath, newContent, 'utf-8');
  return { configDir, written: true, path: rulesPath };
}

/** 生成 Trae rules 段（嵌入到 project_rules.md） */
function generateTraeRulesContent(): string {
  return [
    TRAE_RULES_START,
    `<!-- yondermesh v${TRAE_RULES_VERSION} -->`,
    '## yondermesh',
    '',
    'yondermesh is installed on this machine. It indexes all CLI agent sessions',
    '(Claude Code / Codex / Cursor / Trae) into a local SQLite vault.',
    '',
    '**Note for Trae**: Trae sessions are extracted from JSONL summaries',
    '(`~/.trae-cn/memory/projects/*/*.jsonl`), B-grade coverage.',
    'SQLCipher-encrypted `database.db` could not be cracked — key is likely',
    'derived from macOS Keychain at runtime.',
    '',
    'Available capabilities:',
    '- **MCP tools**: query sessions by time/project/source/topology',
    '- **CLI**: `ymesh sessions list`, `ymesh search "<query>"`, `ymesh extract --cwd-prefix <path>`',
    '- **Skill**: `$yondermesh-diagnose` for system health checks',
    '- **Active session observation**: ymesh daemon scans `~/.trae-cn/memory/projects`',
    '  periodically (Trae has no hooks.json equivalent, so observation is pull-based)',
    '',
    'Use these to recall prior work context, check what other agents did, or',
    'hand off tasks across CLIs (claude / codex / cursor / trae).',
    TRAE_RULES_END,
  ].join('\n');
}

/** 转义正则特殊字符 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 注入 Skills：链接 yondermesh 自带 skill 到 ~/.trae[-cn]/skills/
 * - yondermesh-diagnose：通用诊断 skill
 * - trae-awareness：Trae 专用 awareness skill（含 ymesh 集成说明）
 *
 * 注：trae-awareness 是 Trae 的 CORRECT mounting（与 Cursor 相反，不应在 Cursor 上挂）。
 */
function injectSkills(configDir: string): {
  configDir: string;
  linked: string[];
  skipped: string[];
} {
  const skillsDir = path.join(configDir, 'skills');
  const linked: string[] = [];
  const skipped: string[] = [];

  fs.mkdirSync(skillsDir, { recursive: true });

  const currentRelease = resolveCurrentSymlink();
  const skillsRoot = path.join(currentRelease, 'skills');
  if (!fs.existsSync(skillsRoot)) {
    skipped.push('no skills directory in current release');
    return { configDir, linked, skipped };
  }

  for (const skillName of YONDERMESH_SKILLS_FOR_TRAE) {
    const skillSource = path.join(skillsRoot, skillName);
    if (!fs.existsSync(skillSource)) {
      skipped.push(`${skillName} not in release`);
      continue;
    }
    const linkPath = path.join(skillsDir, skillName);

    // 移除旧链接（无论指向哪里）
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(linkPath);
      } else if (stat.isDirectory()) {
        // 真目录（marketplace skill 或用户自定义）—— 不动
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

  return { configDir, linked, skipped };
}

/**
 * 注入项目级 MCP 到 <projectPath>/.trae/mcp.json
 * 幂等合并：不覆盖既有 mcpServers，仅补 yondermesh server。
 */
function injectProjectMcp(
  projectPath: string,
  ymeshBin: string,
): { injected: boolean; path: string; alreadyPresent?: boolean } {
  const mcpDir = path.join(projectPath, TRAE_PROJECT_MCP_DIR);
  const mcpPath = path.join(mcpDir, TRAE_PROJECT_MCP_FILE);

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(mcpPath)) {
    try {
      config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    } catch {
      // 损坏 → 备份后重建
      try {
        fs.copyFileSync(mcpPath, `${mcpPath}.bak.${Date.now()}`);
      } catch {
        // ignore
      }
      config = {};
    }
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  if (config.mcpServers.yondermesh) {
    return { injected: true, path: mcpPath, alreadyPresent: true };
  }

  const nodeBin = process.execPath;
  config.mcpServers.yondermesh = {
    command: nodeBin,
    args: [ymeshBin, 'mcp'],
  };

  fs.mkdirSync(mcpDir, { recursive: true });
  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return { injected: true, path: mcpPath, alreadyPresent: false };
}

/**
 * 检测并修复 isMounted bug：
 *   skill-config.json 的 managedSkills 列出某 skill（标记为 marketplace / disabled），
 *   但 ~/.trae[-cn]/skills/<name>/ 目录实际不存在。
 *
 * 修复策略：
 *   - 仅修复 ymesh 自带 skill（yondermesh-diagnose / trae-awareness）的缺失
 *   - marketplace skill 缺失 → 仅报告，不自动创建（用户需在 Trae 内重新安装）
 */
function detectAndFixMountedBug(configDir: string): {
  configDir: string;
  missingSkills: string[];
  fixed: string[];
} {
  const skillsDir = path.join(configDir, 'skills');
  const skillConfigPath = path.join(configDir, 'skill-config.json');
  const missing: string[] = [];
  const fixed: string[] = [];

  if (!fs.existsSync(skillConfigPath)) {
    return { configDir, missingSkills: missing, fixed };
  }

  let config: { managedSkills?: Record<string, string> };
  try {
    config = JSON.parse(fs.readFileSync(skillConfigPath, 'utf-8'));
  } catch {
    return { configDir, missingSkills: missing, fixed };
  }

  // 检查每个 managed skill 是否实际存在
  const managed = config.managedSkills ?? {};
  for (const skillName of Object.keys(managed)) {
    const skillPath = path.join(skillsDir, skillName);
    if (!fs.existsSync(skillPath)) {
      missing.push(skillName);
    }
  }

  // 检查 ymesh 自带 skill 是否在 managedSkills 中标记但目录缺失
  for (const ymeshSkill of YONDERMESH_SKILLS_FOR_TRAE) {
    const skillPath = path.join(skillsDir, ymeshSkill);
    if (fs.existsSync(skillPath)) continue;

    // 缺失 → 尝试修复（创建 symlink）
    const currentRelease = resolveCurrentSymlink();
    const skillSource = path.join(currentRelease, 'skills', ymeshSkill);
    if (!fs.existsSync(skillSource)) continue;

    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.symlinkSync(skillSource, skillPath, 'dir');
      fixed.push(ymeshSkill);
    } catch {
      // 修复失败 → 仅记录
    }
  }

  return { configDir, missingSkills: missing, fixed };
}

/**
 * 移除 yondermesh 注入（uninstall 时调用）
 * 仅移除 ymesh 自己写的部分，保留用户其他配置
 */
export function uninstallTraeIdeInjection(options: {
  configDirs?: string[];
  projectPath?: string;
} = {}): {
  rules: string[];
  skills: string[];
  mcp: boolean;
} {
  const configDirs = options.configDirs ?? TRAE_CONFIG_DIRS.filter((d) => fs.existsSync(d));
  const rulesRemoved: string[] = [];
  const skillsRemoved: string[] = [];

  // Rules：移除 ymesh 段（保留文件其他内容）
  for (const configDir of configDirs) {
    const rulesPath = path.join(configDir, 'project_rules.md');
    if (!fs.existsSync(rulesPath)) continue;
    try {
      const content = fs.readFileSync(rulesPath, 'utf-8');
      const cleaned = content.replace(
        new RegExp(
          `${escapeRegex(TRAE_RULES_START)}[\\s\\S]*?${escapeRegex(TRAE_RULES_END)}\\n*`,
          'g',
        ),
        '',
      );
      if (cleaned !== content) {
        fs.writeFileSync(rulesPath, cleaned, 'utf-8');
        rulesRemoved.push(configDir);
      }
    } catch {
      // ignore
    }
  }

  // Skills：移除 ymesh 自带 skill 的 symlink
  for (const configDir of configDirs) {
    const skillsDir = path.join(configDir, 'skills');
    for (const skillName of YONDERMESH_SKILLS_FOR_TRAE) {
      const linkPath = path.join(skillsDir, skillName);
      try {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(linkPath);
          skillsRemoved.push(`${configDir}:${skillName}`);
        }
      } catch {
        // ignore
      }
    }
  }

  // MCP：移除项目级 .trae/mcp.json 中的 yondermesh server
  let mcpRemoved = false;
  if (options.projectPath) {
    const mcpPath = path.join(options.projectPath, TRAE_PROJECT_MCP_DIR, TRAE_PROJECT_MCP_FILE);
    if (fs.existsSync(mcpPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
        if (config.mcpServers?.yondermesh) {
          delete config.mcpServers.yondermesh;
          fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
          mcpRemoved = true;
        }
      } catch {
        // ignore
      }
    }
  }

  return { rules: rulesRemoved, skills: skillsRemoved, mcp: mcpRemoved };
}
