/**
 * Windsurf 注入器 —— MCP / Skills / Hooks / Always-on 四件套
 *
 * 实测 Windsurf（Codeium IDE）的扩展点路径（本机 2026-07）：
 *   - MCP 配置：~/.codeium/windsurf/mcp_config.json（Windsurf workbench 读取）
 *       备选：~/.windsurf/mcp_config.json（部分版本）
 *   - Skills：~/.codeium/windsurf/skills/<name>/（与 ~/.agents/skills/ 共享）
 *   - Hooks：per-workspace `<workspace>/hooks/hooks.json`（Windsurf 源码：
 *       hookConfigPaths=["hooks/hooks.json"]；备选 custom-hooks/hooks.json）
 *     注：atlas 标「~/.codeium/windsurf/hooks.json」严重过时 —— 全局 hooks 不存在。
 *     本注入器写一份全局模板 ~/.codeium/windsurf/hooks.template.json 供用户参考，
 *     并提供 injectHooksIntoWorkspace(workspacePath) 把 hooks 写到具体 workspace。
 *   - Always-on rules：~/.windsurfrules（用户级，Cascade 自动加载）
 *
 * 12 Cascade Hooks（exa.cortex_pb.HookAgentAction enum，实测完整列表）：
 *   PRE_READ_CODE / POST_READ_CODE / PRE_WRITE_CODE / POST_WRITE_CODE /
 *   PRE_MCP_TOOL_USE / POST_MCP_TOOL_USE / PRE_RUN_COMMAND / POST_RUN_COMMAND /
 *   PRE_USER_PROMPT / POST_CASCADE_RESPONSE / POST_SETUP_WORKTREE /
 *   POST_CASCADE_RESPONSE_WITH_TRANSCRIPT（A 级采集入口）
 *
 * Hooks.json 结构（实测 workbench parseHooks 解析）：
 *   {
 *     "hooks": [
 *       {
 *         "event": "POST_CASCADE_RESPONSE_WITH_TRANSCRIPT",
 *         "command": "node /path/to/ymesh ide-hook windsurf POST_CASCADE_RESPONSE_WITH_TRANSCRIPT",
 *         "enabled": true
 *       }
 *     ]
 *   }
 * 字段：event / command / windows / linux / osx / env / description / enabled
 * parseHooks 支持 windows/linux/osx 三平台分支（覆盖 command）。
 *
 * 设计：
 *   - 幂等：MCP 按 server name 去重；Skills 按 name 覆盖；Hooks 按 event+command 去重；
 *     Always-on 用 ymesh 专属标记段覆盖更新。
 *   - 不破坏用户既有配置：MCP 合并而非覆盖；.windsurfrules 保留非 ymesh 段。
 *   - 零依赖：仅用 node:fs / node:path。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveCurrentSymlink } from '../install/paths.js';
import { WINDSURF_CONFIG_DIR } from './extractor.js';
import {
  WINDSURF_CASCADE_HOOK_EVENTS,
  WINDSURF_CORE_HOOK_EVENTS,
} from './wrapper.js';

/** Windsurf MCP 配置文件（~/.codeium/windsurf/mcp_config.json） */
export const WINDSURF_MCP_PATH = path.join(WINDSURF_CONFIG_DIR, 'mcp_config.json');
/** 备选 MCP 路径（~/.windsurf/mcp_config.json，部分版本） */
export const WINDSURF_MCP_ALT_PATH = path.join(os.homedir(), '.windsurf', 'mcp_config.json');
/** Skills 目录（~/.codeium/windsurf/skills/） */
export const WINDSURF_SKILLS_DIR = path.join(WINDSURF_CONFIG_DIR, 'skills');
/** Hooks 全局模板（供用户参考；实际生效路径是 per-workspace） */
export const WINDSURF_HOOKS_TEMPLATE_PATH = path.join(WINDSURF_CONFIG_DIR, 'hooks.template.json');
/** Always-on rules（用户级，Cascade 自动加载） */
export const WINDSURF_RULES_PATH = path.join(os.homedir(), '.windsurfrules');

/** yondermesh 自带的 skill 列表（从 release/skills/ 中读取） */
const YONDERMESH_BUNDLED_SKILLS = ['yondermesh-diagnose'];

/** Windsurf hooks.json 结构 */
interface WindsurfHooksJson {
  version: number;
  hooks: Array<{
    event: string;
    command: string;
    enabled?: boolean;
    windows?: string;
    linux?: string;
    osx?: string;
    env?: Record<string, string>;
    description?: string;
  }>;
}

/** ymesh 二进制路径 */
function resolveYmeshBin(): string {
  try {
    const out = execFileSync('which', ['ymesh'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const p = out.trim();
    if (p) return p;
  } catch {
    // which 失败 → fallback
  }
  return path.join(os.homedir(), '.yondermesh', 'bin', 'ymesh');
}

/** 注入选项 */
export interface WindsurfInjectOptions {
  /** 是否注册 MCP（默认 true） */
  mcp?: boolean;
  /** 是否链接 Skills（默认 true） */
  skills?: boolean;
  /** 是否注册 Hooks（默认 true，写全局模板） */
  hooks?: boolean;
  /** 是否写 Always-on rules（默认 true） */
  rules?: boolean;
  /** 是否注册全部 12 hooks（false=仅核心 2 个：PRE_USER_PROMPT + 采集入口，默认 true） */
  allHooks?: boolean;
  /** ymesh 二进制路径覆盖 */
  ymeshBin?: string;
  /** 同时把 hooks 写到指定 workspace（per-workspace 才生效） */
  workspacePath?: string;
}

/** 注入结果 */
export interface WindsurfInjectResult {
  mcp: { registered: boolean; path: string; alreadyPresent?: boolean };
  skills: { linked: string[]; skipped: string[] };
  hooks: { registered: string[]; templatePath: string; workspacePath?: string };
  rules: { written: boolean; path: string };
}

/**
 * 注入 yondermesh 集成到 Windsurf IDE。
 * 幂等：可重复执行，不会产生重复注册或破坏既有配置。
 */
export function injectWindsurf(options: WindsurfInjectOptions = {}): WindsurfInjectResult {
  const ymeshBin = options.ymeshBin ?? resolveYmeshBin();
  const doMcp = options.mcp ?? true;
  const doSkills = options.skills ?? true;
  const doHooks = options.hooks ?? true;
  const doRules = options.rules ?? true;

  fs.mkdirSync(WINDSURF_CONFIG_DIR, { recursive: true });

  const result: WindsurfInjectResult = {
    mcp: { registered: false, path: WINDSURF_MCP_PATH },
    skills: { linked: [], skipped: [] },
    hooks: { registered: [], templatePath: WINDSURF_HOOKS_TEMPLATE_PATH },
    rules: { written: false, path: WINDSURF_RULES_PATH },
  };

  if (doMcp) {
    result.mcp = injectMcp(ymeshBin);
  }
  if (doSkills) {
    result.skills = injectSkills();
  }
  if (doHooks) {
    result.hooks = injectHooks(ymeshBin, options.allHooks ?? true, options.workspacePath);
  }
  if (doRules) {
    result.rules = injectRules();
  }

  return result;
}

/** 注入 MCP 配置：确保 mcp_config.json 含 yondermesh server（幂等合并） */
function injectMcp(ymeshBin: string): {
  registered: boolean;
  path: string;
  alreadyPresent?: boolean;
} {
  // 优先 ~/.codeium/windsurf/mcp_config.json，备选 ~/.windsurf/mcp_config.json
  const configPath = fs.existsSync(path.dirname(WINDSURF_MCP_ALT_PATH))
    ? WINDSURF_MCP_PATH // 主路径，确保存在
    : WINDSURF_MCP_PATH;

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      try {
        fs.copyFileSync(configPath, `${configPath}.bak.${Date.now()}`);
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
    return { registered: true, path: configPath, alreadyPresent: true };
  }

  const nodeBin = process.execPath;
  config.mcpServers.yondermesh = {
    command: nodeBin,
    args: [ymeshBin, 'mcp'],
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return { registered: true, path: configPath, alreadyPresent: false };
}

/**
 * 注入 Skills：链接 yondermesh 自带 skill 到 ~/.codeium/windsurf/skills/
 * 同时动态扫描 release/skills/ 全部子目录。
 */
function injectSkills(): {
  linked: string[];
  skipped: string[];
} {
  const linked: string[] = [];
  const skipped: string[] = [];

  fs.mkdirSync(WINDSURF_SKILLS_DIR, { recursive: true });

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
    const linkPath = path.join(WINDSURF_SKILLS_DIR, skillName);

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

/**
 * 注入 Hooks：写全局模板 + （可选）写 per-workspace hooks/hooks.json
 *
 * 注：Windsurf 的 hooks 只能 per-workspace 生效（实测 workbench 源码
 * hookConfigPaths=["hooks/hooks.json"]）。全局模板仅作参考，需用户手动复制到
 * workspace 根目录的 hooks/hooks.json 才生效。
 *
 * @param ymeshBin ymesh 二进制路径
 * @param allHooks true=注册全部 12 hooks；false=仅核心 2 个
 * @param workspacePath 若提供，同时把 hooks 写到该 workspace
 */
function injectHooks(
  ymeshBin: string,
  allHooks: boolean,
  workspacePath?: string,
): {
  registered: string[];
  templatePath: string;
  workspacePath?: string;
} {
  const events = allHooks ? WINDSURF_CASCADE_HOOK_EVENTS : WINDSURF_CORE_HOOK_EVENTS;
  const nodeBin = process.execPath;

  // 1. 写全局模板（参考用）
  const templateConfig: WindsurfHooksJson = {
    version: 1,
    hooks: events.map((event) => ({
      event,
      command: `${nodeBin} ${ymeshBin} ide-hook windsurf ${event}`,
      enabled: true,
      description: `ymesh ${event} hook`,
    })),
  };
  fs.mkdirSync(path.dirname(WINDSURF_HOOKS_TEMPLATE_PATH), { recursive: true });
  fs.writeFileSync(
    WINDSURF_HOOKS_TEMPLATE_PATH,
    JSON.stringify(templateConfig, null, 2) + '\n',
    'utf-8',
  );

  // 2. 写 per-workspace hooks/hooks.json（若提供 workspacePath）
  if (workspacePath) {
    const wsHooksPath = path.join(workspacePath, 'hooks', 'hooks.json');
    let config: WindsurfHooksJson = { version: 1, hooks: [] };
    if (fs.existsSync(wsHooksPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(wsHooksPath, 'utf-8'));
        if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.hooks)) {
          config = {
            version: typeof parsed.version === 'number' ? parsed.version : 1,
            hooks: parsed.hooks,
          };
        }
      } catch {
        // 损坏 → 备份后重建
        try {
          fs.copyFileSync(wsHooksPath, `${wsHooksPath}.bak.${Date.now()}`);
        } catch {
          // ignore
        }
      }
    }

    for (const event of events) {
      const cmd = `${nodeBin} ${ymeshBin} ide-hook windsurf ${event}`;
      const exists = config.hooks.some(
        (h) => h.event === event && h.command && h.command.includes('ymesh ide-hook'),
      );
      if (!exists) {
        config.hooks.push({
          event,
          command: cmd,
          enabled: true,
          description: `ymesh ${event} hook`,
        });
      }
    }

    fs.mkdirSync(path.dirname(wsHooksPath), { recursive: true });
    fs.writeFileSync(wsHooksPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    return {
      registered: [...events],
      templatePath: WINDSURF_HOOKS_TEMPLATE_PATH,
      workspacePath: wsHooksPath,
    };
  }

  return { registered: [...events], templatePath: WINDSURF_HOOKS_TEMPLATE_PATH };
}

/** rules 内容版本 */
const WINDSURF_RULES_VERSION = 1;

/** 生成 yondermesh rules 段 */
function generateWindsurfRulesContent(): string {
  return [
    `<!-- yondermesh v${WINDSURF_RULES_VERSION} -->`,
    '# Yondermesh 集成',
    '',
    '本机已部署 yondermesh —— 一个 self-hosted agent context bus。',
    '通过它可以让本机的多个 AI agent（Claude Code / Codex / Windsurf / Continue 等）',
    '互相看到彼此的 session 历史、互相转交任务、跨设备同步上下文。',
    '',
    '可用 MCP 工具（已自动注册到 Windsurf）：',
    '- `yondermesh` MCP server：查询/检索/转交 session，详见 `ymesh mcp`',
    '',
    '可用 CLI 命令（在终端运行）：',
    '- `ymesh sessions` —— 列出所有 session',
    '- `ymesh scan` —— 扫描本机全部 session 入库',
    '',
    '注意事项：',
    '- Windsurf 的 Cascade session 通过 POST_CASCADE_RESPONSE_WITH_TRANSCRIPT hook 采集',
    '  （来源标记 `windsurf`，B 级兼容 importer）',
    '- 你的对话内容（user/assistant 文本）会被存入本地 ymesh SQLite，跨 agent 可读',
    '- 思维链 / tool_use / tool_result 不被采集（仅最终显示文本）',
    '<!-- /yondermesh -->',
  ].join('\n');
}

/**
 * 注入 Always-on rules：写 ~/.windsurfrules
 * 幂等：用 ymesh 专属标记段覆盖更新，保留非 ymesh 段。
 */
function injectRules(): { written: boolean; path: string } {
  const rulesContent = generateWindsurfRulesContent();
  let existing = '';
  if (fs.existsSync(WINDSURF_RULES_PATH)) {
    existing = fs.readFileSync(WINDSURF_RULES_PATH, 'utf-8');
  }

  // 已含 ymesh 段 → 检测版本
  if (existing.includes('<!-- yondermesh v')) {
    if (existing.includes(`<!-- yondermesh v${WINDSURF_RULES_VERSION} -->`)) {
      return { written: false, path: WINDSURF_RULES_PATH };
    }
    // 旧版本 → 替换 ymesh 段
    const replaced = existing.replace(
      /<!-- yondermesh v\d+ -->[\s\S]*?<!-- \/yondermesh -->/,
      rulesContent,
    );
    fs.writeFileSync(WINDSURF_RULES_PATH, replaced, 'utf-8');
    return { written: true, path: WINDSURF_RULES_PATH };
  }

  // 新增 ymesh 段（追加到末尾）
  const newContent =
    existing.endsWith('\n') || existing === ''
      ? existing + rulesContent + '\n'
      : existing + '\n\n' + rulesContent + '\n';
  fs.writeFileSync(WINDSURF_RULES_PATH, newContent, 'utf-8');
  return { written: true, path: WINDSURF_RULES_PATH };
}

/**
 * 移除 yondermesh 注入（uninstall 时调用）
 * 仅移除 ymesh 自己写的部分，保留用户其他配置
 */
export function uninstallWindsurfInjection(): {
  mcp: boolean;
  skills: string[];
  hooks: { templateRemoved: boolean; workspaceRemoved: string[] };
  rules: boolean;
} {
  // MCP：移除 yondermesh server
  let mcpRemoved = false;
  for (const p of [WINDSURF_MCP_PATH, WINDSURF_MCP_ALT_PATH]) {
    if (!fs.existsSync(p)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (config.mcpServers?.yondermesh) {
        delete config.mcpServers.yondermesh;
        fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
  if (fs.existsSync(WINDSURF_SKILLS_DIR) && fs.existsSync(skillsRoot)) {
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
      const linkPath = path.join(WINDSURF_SKILLS_DIR, name);
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

  // Hooks：移除全局模板
  let templateRemoved = false;
  if (fs.existsSync(WINDSURF_HOOKS_TEMPLATE_PATH)) {
    try {
      fs.unlinkSync(WINDSURF_HOOKS_TEMPLATE_PATH);
      templateRemoved = true;
    } catch {
      // ignore
    }
  }
  // 注：per-workspace hooks 不自动移除（避免破坏用户 workspace）

  // Rules：移除 ymesh 段
  let rulesRemoved = false;
  if (fs.existsSync(WINDSURF_RULES_PATH)) {
    try {
      const content = fs.readFileSync(WINDSURF_RULES_PATH, 'utf-8');
      const cleaned = content.replace(
        /<!-- yondermesh v\d+ -->[\s\S]*?<!-- \/yondermesh -->\n*/,
        '',
      );
      if (cleaned !== content) {
        fs.writeFileSync(WINDSURF_RULES_PATH, cleaned, 'utf-8');
        rulesRemoved = true;
      }
    } catch {
      // ignore
    }
  }

  return {
    mcp: mcpRemoved,
    skills: skillsRemoved,
    hooks: { templateRemoved, workspaceRemoved: [] },
    rules: rulesRemoved,
  };
}
