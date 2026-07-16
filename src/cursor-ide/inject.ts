/**
 * Cursor IDE 注入器 —— MCP / Skills / Hooks / Always-on 四件套
 *
 * Cursor 的「外部集成点」与 CLI adapter 不同：
 *   - 无 CLAUDE.md 这种 always-on context 文件 → 用 ~/.cursorrules（Composer 自动加载）
 *   - 无 CLI 命令 → 用 hooks.json 的 18 hooks 实现 session 启停观察
 *   - MCP 已支持（~/.cursor/mcp.json，yondermesh MCP 默认已注册）
 *   - Skills 通过 ~/.cursor/skills/<name>/ 目录挂载（文件式，symlink 即可）
 *
 * 已知 bug 修复：当前 ~/.cursor/skills/trae-awareness 错误地挂载了 trae-awareness
 * skill（该 skill 是为 Trae IDE 设计的，挂在 Cursor 上无意义且会让 Cursor Composer
 * 误以为自己在 Trae 环境里）。inject 时检测并移除该错误链接。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveCurrentSymlink } from '../install/paths.js';
import {
  CURSOR_CORE_HOOK_EVENTS,
  CURSOR_HOOK_EVENTS,
  CURSOR_HOOKS_PATH,
} from './wrapper.js';

/** Cursor 配置根目录 */
export const CURSOR_CONFIG_DIR = path.join(os.homedir(), '.cursor');
/** MCP 配置文件 */
export const CURSOR_MCP_PATH = path.join(CURSOR_CONFIG_DIR, 'mcp.json');
/** Skills 目录 */
export const CURSOR_SKILLS_DIR = path.join(CURSOR_CONFIG_DIR, 'skills');
/** Hooks 配置 */
export { CURSOR_HOOKS_PATH };
/** Always-on rules（用户级，Composer 自动加载） */
export const CURSOR_RULES_PATH = path.join(os.homedir(), '.cursorrules');
/** 备用 rules 路径（部分版本用 .cursor/.cursorrules） */
export const CURSOR_RULES_ALT_PATH = path.join(CURSOR_CONFIG_DIR, '.cursorrules');

/** yondermesh 自带的 skill 列表（从 release/skills/ 中读取） */
const YONDERMESH_BUNDLED_SKILLS = ['yondermesh-diagnose'];

/** 错误挂载在 Cursor 上的 skill（应移除） */
const WRONG_MOUNTED_SKILLS_IN_CURSOR = ['trae-awareness'];

/** Cursor hooks.json 结构 */
interface CursorHooksJson {
  version: number;
  hooks: Record<string, Array<{ type: string; command: string }>>;
}

/** ymesh 二进制路径（在 ~/.yondermesh/bin/ymesh，已在 PATH 中） */
function resolveYmeshBin(): string {
  // 优先用 PATH 中的 ymesh（开发期可能是 tsx）
  try {
    const out = execFileSync('which', ['ymesh'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const p = out.trim();
    if (p) return p;
  } catch {
    // which 失败 → fallback 到固定路径
  }
  return path.join(os.homedir(), '.yondermesh', 'bin', 'ymesh');
}

/** 注入选项 */
export interface CursorInjectOptions {
  /** 是否注册 MCP（默认 true） */
  mcp?: boolean;
  /** 是否链接 Skills（默认 true） */
  skills?: boolean;
  /** 是否注册 Hooks（默认 true） */
  hooks?: boolean;
  /** 是否写 Always-on rules（默认 true） */
  rules?: boolean;
  /** 是否注册全部 18 hooks（false=仅核心 8 个，默认 false） */
  allHooks?: boolean;
  /** ymesh 二进制路径覆盖 */
  ymeshBin?: string;
}

/** 注入结果 */
export interface CursorInjectResult {
  mcp: { registered: boolean; path: string; alreadyPresent?: boolean };
  skills: { linked: string[]; removedWrong: string[]; skipped: string[] };
  hooks: { registered: string[]; path: string };
  rules: { written: boolean; path: string };
}

/**
 * 注入 yondermesh 集成到 Cursor IDE。
 * 幂等：可重复执行，不会产生重复注册或破坏既有配置。
 */
export function injectCursorIde(options: CursorInjectOptions = {}): CursorInjectResult {
  const ymeshBin = options.ymeshBin ?? resolveYmeshBin();
  const doMcp = options.mcp ?? true;
  const doSkills = options.skills ?? true;
  const doHooks = options.hooks ?? true;
  const doRules = options.rules ?? true;

  fs.mkdirSync(CURSOR_CONFIG_DIR, { recursive: true });

  const result: CursorInjectResult = {
    mcp: { registered: false, path: CURSOR_MCP_PATH },
    skills: { linked: [], removedWrong: [], skipped: [] },
    hooks: { registered: [], path: CURSOR_HOOKS_PATH },
    rules: { written: false, path: CURSOR_RULES_PATH },
  };

  if (doMcp) {
    result.mcp = injectMcp(ymeshBin);
  }
  if (doSkills) {
    result.skills = injectSkills();
  }
  if (doHooks) {
    result.hooks = injectHooks(ymeshBin, options.allHooks ?? false);
  }
  if (doRules) {
    result.rules = injectRules();
  }

  return result;
}

/** 注入 MCP 配置：确保 ~/.cursor/mcp.json 含 yondermesh server（幂等合并） */
function injectMcp(ymeshBin: string): {
  registered: boolean;
  path: string;
  alreadyPresent?: boolean;
} {
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(CURSOR_MCP_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(CURSOR_MCP_PATH, 'utf-8'));
    } catch {
      // 损坏 → 备份后重建
      try {
        fs.copyFileSync(CURSOR_MCP_PATH, `${CURSOR_MCP_PATH}.bak.${Date.now()}`);
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
    return { registered: true, path: CURSOR_MCP_PATH, alreadyPresent: true };
  }

  // node 启动 ymesh mcp —— 用 node 直接跑（避免 shebang 兼容问题）
  const nodeBin = process.execPath;
  config.mcpServers.yondermesh = {
    command: nodeBin,
    args: [ymeshBin, 'mcp'],
  };

  fs.writeFileSync(CURSOR_MCP_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return { registered: true, path: CURSOR_MCP_PATH, alreadyPresent: false };
}

/**
 * 注入 Skills：链接 yondermesh 自带 skill 到 ~/.cursor/skills/
 * 同时修复 bug：移除错误挂载的 trae-awareness
 */
function injectSkills(): {
  linked: string[];
  removedWrong: string[];
  skipped: string[];
} {
  const linked: string[] = [];
  const removedWrong: string[] = [];
  const skipped: string[] = [];

  fs.mkdirSync(CURSOR_SKILLS_DIR, { recursive: true });

  // 1. 修复 bug：移除错误挂载的 trae-awareness（这是 Trae IDE 用的，不该在 Cursor 上）
  for (const wrongName of WRONG_MOUNTED_SKILLS_IN_CURSOR) {
    const linkPath = path.join(CURSOR_SKILLS_DIR, wrongName);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(linkPath);
        removedWrong.push(wrongName);
      } else if (stat.isDirectory()) {
        // 真目录（非 symlink）—— 用户可能手动放了，保守起见跳过，仅记录
        skipped.push(`${wrongName} is real dir (not removed)`);
      }
    } catch {
      // 不存在 → 无需修复
    }
  }

  // 2. 链接 yondermesh 自带 skill
  const currentRelease = resolveCurrentSymlink();
  const skillsRoot = path.join(currentRelease, 'skills');
  if (!fs.existsSync(skillsRoot)) {
    skipped.push('no skills directory in current release');
    return { linked, removedWrong, skipped };
  }

  // 扫描 release/skills/ 下所有子目录（动态发现，而非硬编码列表）
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
    const linkPath = path.join(CURSOR_SKILLS_DIR, skillName);

    // 移除旧链接（无论指向哪里）
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(linkPath);
      } else if (stat.isDirectory()) {
        // 真目录，不动（用户自定义）
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

  return { linked, removedWrong, skipped };
}

/**
 * 注入 Hooks：注册 8 个核心 hooks（或全部 18 个）到 ~/.cursor/hooks.json
 * 幂等：合并既有 hooks 配置，不覆盖用户自定义的其他 hook
 */
function injectHooks(ymeshBin: string, allHooks: boolean): {
  registered: string[];
  path: string;
} {
  const events = allHooks ? CURSOR_HOOK_EVENTS : CURSOR_CORE_HOOK_EVENTS;
  const nodeBin = process.execPath;

  let config: CursorHooksJson = { version: 1, hooks: {} };
  if (fs.existsSync(CURSOR_HOOKS_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CURSOR_HOOKS_PATH, 'utf-8'));
      if (typeof parsed === 'object' && parsed !== null) {
        config = {
          version: typeof parsed.version === 'number' ? parsed.version : 1,
          hooks: typeof parsed.hooks === 'object' && parsed.hooks !== null ? parsed.hooks : {},
        };
      }
    } catch {
      // 损坏 → 备份后重建
      try {
        fs.copyFileSync(CURSOR_HOOKS_PATH, `${CURSOR_HOOKS_PATH}.bak.${Date.now()}`);
      } catch {
        // ignore
      }
    }
  }

  for (const eventName of events) {
    if (!config.hooks[eventName]) {
      config.hooks[eventName] = [];
    }
    // 检查是否已注册 ymesh hook（避免重复）
    const exists = config.hooks[eventName].some(
      (h) => h.command && h.command.includes('ymesh ide-hook'),
    );
    if (!exists) {
      config.hooks[eventName].push({
        type: 'command',
        command: `${nodeBin} ${ymeshBin} ide-hook cursor ${eventName}`,
      });
    }
  }

  fs.writeFileSync(CURSOR_HOOKS_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return { registered: [...events], path: CURSOR_HOOKS_PATH };
}

/**
 * 注入 Always-on rules：写 ~/.cursorrules
 * 让每个 Composer 都知道 yondermesh 的存在与可用 MCP / 命令。
 * 幂等：检测已有 ymesh 段，已有则不重复写
 */
function injectRules(): { written: boolean; path: string } {
  const rulesContent = generateCursorRulesContent();
  let existing = '';
  if (fs.existsSync(CURSOR_RULES_PATH)) {
    existing = fs.readFileSync(CURSOR_RULES_PATH, 'utf-8');
  }
  // 已含 ymesh 段 → 不重复写
  if (existing.includes('<!-- yondermesh -->')) {
    // 但可能内容已更新 → 检测版本标记
    if (existing.includes(`<!-- yondermesh v${CURSOR_RULES_VERSION} -->`)) {
      return { written: false, path: CURSOR_RULES_PATH };
    }
    // 旧版本 → 替换 ymesh 段
    const replaced = existing.replace(
      /<!-- yondermesh v\d+ -->[\s\S]*?<!-- \/yondermesh -->/,
      rulesContent,
    );
    fs.writeFileSync(CURSOR_RULES_PATH, replaced, 'utf-8');
    return { written: true, path: CURSOR_RULES_PATH };
  }
  // 新增 ymesh 段（追加到末尾）
  const newContent = existing.endsWith('\n') || existing === ''
    ? existing + rulesContent + '\n'
    : existing + '\n\n' + rulesContent + '\n';
  fs.writeFileSync(CURSOR_RULES_PATH, newContent, 'utf-8');
  return { written: true, path: CURSOR_RULES_PATH };
}

/** rules 内容版本（用于检测是否需要更新） */
const CURSOR_RULES_VERSION = 1;

/** 生成 yondermesh rules 段（嵌入到 ~/.cursorrules） */
function generateCursorRulesContent(): string {
  return [
    `<!-- yondermesh v${CURSOR_RULES_VERSION} -->`,
    '# Yondermesh 集成',
    '',
    '本机已部署 yondermesh —— 一个 self-hosted agent context bus。',
    '通过它可以让本机的多个 AI agent（Claude Code / Codex / Cursor / Trae 等）',
    '互相看到彼此的 session 历史、互相转交任务、跨设备同步上下文。',
    '',
    '可用 MCP 工具（已自动注册到 Cursor）：',
    '- `yondermesh` MCP server：查询/检索/转交 session，详见 `ymesh mcp`',
    '',
    '可用 CLI 命令（在终端运行）：',
    '- `ymesh sessions list` —— 列出所有 session',
    '- `ymesh sessions show <id>` —— 查看某 session 详情',
    '- `ymesh search "<query>"` —— 全文搜索 session 内容',
    '- `ymesh extract --cwd-prefix <path>` —— 提取某项目的需求/响应',
    '',
    '注意事项：',
    '- Cursor 的 session 会被 yondermesh 自动提取（来源标记 `cursor-ide`，B 级兼容 importer）',
    '- 你的对话内容（user/assistant 文本）会被存入本地 ymesh SQLite，跨 agent 可读',
    '- 思维链 / tool_use / tool_result 不被采集（仅最终显示文本）',
    '<!-- /yondermesh -->',
  ].join('\n');
}

/**
 * 移除 yondermesh 注入（uninstall 时调用）
 * 仅移除 ymesh 自己写的部分，保留用户其他配置
 */
export function uninstallCursorIdeInjection(): {
  mcp: boolean;
  skills: string[];
  hooks: string[];
  rules: boolean;
} {
  // MCP：移除 yondermesh server
  let mcpRemoved = false;
  if (fs.existsSync(CURSOR_MCP_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CURSOR_MCP_PATH, 'utf-8'));
      if (config.mcpServers?.yondermesh) {
        delete config.mcpServers.yondermesh;
        fs.writeFileSync(CURSOR_MCP_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        mcpRemoved = true;
      }
    } catch {
      // ignore
    }
  }

  // Skills：移除所有 release/skills/ 来源的 symlink
  const skillsRemoved: string[] = [];
  const currentRelease = resolveCurrentSymlink();
  const skillsRoot = path.join(currentRelease, 'skills');
  if (fs.existsSync(CURSOR_SKILLS_DIR) && fs.existsSync(skillsRoot)) {
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
      const linkPath = path.join(CURSOR_SKILLS_DIR, name);
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

  // Hooks：移除所有 ymesh hook
  const hooksRemoved: string[] = [];
  if (fs.existsSync(CURSOR_HOOKS_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CURSOR_HOOKS_PATH, 'utf-8'));
      for (const eventName of CURSOR_HOOK_EVENTS) {
        const arr = config.hooks?.[eventName];
        if (Array.isArray(arr)) {
          config.hooks[eventName] = arr.filter(
            (h: { command?: string }) => !h.command?.includes('ymesh ide-hook'),
          );
          if (config.hooks[eventName].length === 0) {
            delete config.hooks[eventName];
            hooksRemoved.push(eventName);
          }
        }
      }
      fs.writeFileSync(CURSOR_HOOKS_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    } catch {
      // ignore
    }
  }

  // Rules：移除 ymesh 段
  let rulesRemoved = false;
  if (fs.existsSync(CURSOR_RULES_PATH)) {
    try {
      const content = fs.readFileSync(CURSOR_RULES_PATH, 'utf-8');
      const cleaned = content.replace(
        /<!-- yondermesh v\d+ -->[\s\S]*?<!-- \/yondermesh -->\n*/,
        '',
      );
      if (cleaned !== content) {
        fs.writeFileSync(CURSOR_RULES_PATH, cleaned, 'utf-8');
        rulesRemoved = true;
      }
    } catch {
      // ignore
    }
  }

  return {
    mcp: mcpRemoved,
    skills: skillsRemoved,
    hooks: hooksRemoved,
    rules: rulesRemoved,
  };
}
