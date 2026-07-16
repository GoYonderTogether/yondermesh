/**
 * 集中检测模块：统一检测本机安装的所有 agent CLI 及其能力
 *
 * AGENT_REGISTRY 是中央注册表，定义每个 agent 的元数据（CLI 二进制名、配置目录、
 * 采集等级、挂载能力、GLM-5.2 支持等）。detectAgents() 遍历注册表，按优先级
 * 检测 CLI 二进制 → 配置目录 → macOS App，输出 AgentDetection[]。
 *
 * 检测逻辑：
 *   1. which <cliBinary>     → CLI 已安装
 *   2. ~/.<configDirName>    → 配置目录存在（排除 OpenSpace 残留）
 *      ~/.config/<configDirXDG>
 *      ~/Library/Application Support/<macOsAppSupportDir>
 *   3. /Applications/<appPath> → macOS App 已安装（IDE 类型）
 *
 * OpenSpace 残留：某些目录仅含 skills/ 子目录 + 指向 ~/.agents/skills/ 的 symlink，
 * 由 OpenSpace 创建但 agent 本身未安装，不应计为已安装。
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from '../store/session-store.js';
import { normalizeSource } from '../store/source-aliases.js';

// ─── 数据结构 ────────────────────────────────────────────────────────────

/** 单个 agent 的检测结果 */
export interface AgentDetection {
  /** canonical source 名称（如 'hermes', 'opencode'） */
  canonical: string;
  /** 显示名称（如 'Hermes Agent', 'OpenCode'） */
  displayName: string;
  /** 是否已安装 */
  installed: boolean;
  /** 安装类型 */
  installType: 'cli' | 'ide' | 'saas' | 'not-found';
  /** CLI 二进制路径（如已安装） */
  cliBinary?: string;
  /** 配置目录路径 */
  configDir?: string;
  /** Session 目录路径 */
  sessionDir?: string;
  /** 采集覆盖等级 */
  collectionLevel: 'A' | 'B' | 'C' | 'none';
  /** scan 状态 */
  scanStatus: 'active' | 'scan' | 'coded' | 'missing';
  /** 是否支持 MCP 挂载 */
  mountMcp: boolean;
  /** 是否支持 Skills 挂载 */
  mountSkills: boolean;
  /** 是否支持 Always-on 注入 */
  mountAlwaysOn: boolean;
  /** 是否有 wrapper（launch/inject/interrupt） */
  hasWrapper: boolean;
  /** 是否有 hooks 系统 */
  hasHooks: boolean;
  /** 是否支持 GLM-5.2 */
  glm52Supported: boolean;
  /** 已采集的 session 数（可选，需 store） */
  sessionCount?: number;
}

/** detectAgents 选项 */
export interface DetectOptions {
  /** 是否查询 session 数（需要打开 store） */
  withSessionCount?: boolean;
  /** store 路径 */
  dbPath?: string;
}

// ─── AgentMeta 与 AGENT_REGISTRY ─────────────────────────────────────────

/** agent 元数据（注册表条目） */
interface AgentMeta {
  canonical: string;
  displayName: string;
  /** which 命令查找的二进制名 */
  cliBinaryName?: string;
  /** ~/. 下的目录名（如 '.claude'） */
  configDirName?: string;
  /** ~/.config/ 下的目录名（XDG 路径，如 'opencode'） */
  configDirXDG?: string;
  /** macOS ~/Library/Application Support/ 下的相对路径 */
  macOsAppSupportDir?: string;
  installType: 'cli' | 'ide' | 'saas';
  collectionLevel: 'A' | 'B' | 'C' | 'none';
  scanStatus: 'active' | 'scan' | 'coded' | 'missing';
  mountMcp: boolean;
  mountSkills: boolean;
  mountAlwaysOn: boolean;
  hasWrapper: boolean;
  hasHooks: boolean;
  glm52Supported: boolean;
  /** macOS App 路径（IDE 类型，如 '/Applications/Cursor.app'） */
  appPath?: string;
}

/**
 * 中央 agent 注册表
 *
 * 新增 agent 只需在此数组追加一项。canonical 与 source-aliases.ts 的 canonical 对齐。
 */
const AGENT_REGISTRY: AgentMeta[] = [
  {
    canonical: 'claude', displayName: 'Claude Code',
    cliBinaryName: 'claude', configDirName: '.claude',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: false, hasHooks: true, glm52Supported: true,
  },
  {
    canonical: 'codex', displayName: 'Codex',
    cliBinaryName: 'codex', configDirName: '.codex',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: false, hasHooks: true, glm52Supported: true,
  },
  {
    canonical: 'cass', displayName: 'cass (history index)',
    cliBinaryName: 'cass',
    macOsAppSupportDir: 'com.coding-agent-search.coding-agent-search',
    installType: 'cli', collectionLevel: 'B', scanStatus: 'active',
    mountMcp: false, mountSkills: false, mountAlwaysOn: false,
    hasWrapper: false, hasHooks: false, glm52Supported: false,
  },
  {
    canonical: 'opencode', displayName: 'OpenCode',
    cliBinaryName: 'opencode', configDirXDG: 'opencode',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'hermes', displayName: 'Hermes Agent',
    cliBinaryName: 'hermes', configDirName: '.hermes',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: false, mountSkills: false, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'kimi', displayName: 'Kimi',
    cliBinaryName: 'kimi', configDirName: '.kimi',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'cursor', displayName: 'Cursor (CLI placeholder)',
    configDirName: '.cursor',
    installType: 'cli', collectionLevel: 'none', scanStatus: 'missing',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: false, hasHooks: false, glm52Supported: false,
  },
  {
    canonical: 'cursor-ide', displayName: 'Cursor IDE',
    configDirName: '.cursor', appPath: '/Applications/Cursor.app',
    installType: 'ide', collectionLevel: 'B', scanStatus: 'scan',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: true, glm52Supported: false,
  },
  {
    canonical: 'copilot', displayName: 'Copilot CLI / SDK',
    cliBinaryName: 'copilot', configDirName: '.copilot',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'gemini', displayName: 'Gemini CLI',
    cliBinaryName: 'gemini', configDirName: '.gemini',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'qwen', displayName: 'Qwen Code',
    cliBinaryName: 'qwen', configDirName: '.qwen',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'openclaw', displayName: 'OpenClaw',
    cliBinaryName: 'openclaw', configDirName: '.openclaw',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: false, mountSkills: false, mountAlwaysOn: false,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'aider', displayName: 'Aider',
    cliBinaryName: 'aider',
    installType: 'cli', collectionLevel: 'B', scanStatus: 'scan',
    mountMcp: false, mountSkills: false, mountAlwaysOn: false,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'trae', displayName: 'Trae (Intl, IDE + Work)',
    configDirName: '.trae',
    installType: 'cli', collectionLevel: 'none', scanStatus: 'coded',
    mountMcp: false, mountSkills: true, mountAlwaysOn: false,
    hasWrapper: false, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'trae-ide', displayName: 'Trae IDE (CN)',
    configDirName: '.trae-cn', appPath: '/Applications/Trae.app',
    installType: 'ide', collectionLevel: 'B', scanStatus: 'scan',
    mountMcp: false, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: true, glm52Supported: false,
  },
  {
    canonical: 'trae-cli', displayName: 'trae-cli (ByteDance trae-agent)',
    cliBinaryName: 'trae-agent', configDirName: '.trae-cli',
    installType: 'cli', collectionLevel: 'B', scanStatus: 'scan',
    mountMcp: false, mountSkills: false, mountAlwaysOn: false,
    hasWrapper: false, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'windsurf', displayName: 'Windsurf (Codeium)',
    configDirName: '.codeium/windsurf', appPath: '/Applications/Windsurf.app',
    installType: 'ide', collectionLevel: 'B', scanStatus: 'scan',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: true, glm52Supported: false,
  },
  {
    canonical: 'openhands', displayName: 'OpenHands',
    cliBinaryName: 'openhands', configDirName: '.openhands',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: false, mountAlwaysOn: false,
    hasWrapper: true, hasHooks: true, glm52Supported: true,
  },
  {
    canonical: 'goose', displayName: 'Goose (Block)',
    cliBinaryName: 'goose', configDirXDG: 'goose',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'antigravity', displayName: 'Antigravity (Google IDE)',
    cliBinaryName: 'agy',
    macOsAppSupportDir: 'Google/Antigravity',
    appPath: '/Applications/Antigravity.app',
    installType: 'ide', collectionLevel: 'A', scanStatus: 'scan',
    mountMcp: true, mountSkills: false, mountAlwaysOn: false,
    hasWrapper: true, hasHooks: true, glm52Supported: false,
  },
  {
    canonical: 'factory', displayName: 'Factory Droid (Factory AI)',
    cliBinaryName: 'droid', configDirName: '.factory',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'vibe', displayName: 'Vibe (Mistral AI)',
    cliBinaryName: 'vibe', configDirName: '.vibe',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'codebuddy', displayName: 'WorkBuddy / CodeBuddy (Tencent)',
    cliBinaryName: 'cbc', configDirName: '.codebuddy',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: true, glm52Supported: true,
  },
  {
    canonical: 'amp', displayName: 'Amp (Sourcegraph)',
    cliBinaryName: 'amp', configDirXDG: 'amp',
    installType: 'saas', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: true, glm52Supported: true,
  },
  {
    canonical: 'chatgpt', displayName: 'ChatGPT Desktop (Codex merged)',
    appPath: '/Applications/ChatGPT.app',
    installType: 'saas', collectionLevel: 'C', scanStatus: 'coded',
    mountMcp: false, mountSkills: false, mountAlwaysOn: false,
    hasWrapper: false, hasHooks: false, glm52Supported: false,
  },
  {
    canonical: 'pi', displayName: 'Pi Agent',
    cliBinaryName: 'pi', configDirName: '.pi',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'omp', displayName: 'oh-my-pi',
    cliBinaryName: 'omp', configDirName: '.omp',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'gsd-pi', displayName: 'gsd-pi',
    cliBinaryName: 'gsd', configDirName: '.gsd',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'crush', displayName: 'Crush (Charm)',
    cliBinaryName: 'crush', configDirXDG: 'crush',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'cline', displayName: 'Cline',
    cliBinaryName: 'cline', configDirName: '.cline',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: true, mountSkills: true, mountAlwaysOn: true,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
  {
    canonical: 'continue', displayName: 'Continue (@continuedev/cli)',
    cliBinaryName: 'cn', configDirName: '.continue',
    installType: 'cli', collectionLevel: 'A', scanStatus: 'active',
    mountMcp: false, mountSkills: true, mountAlwaysOn: false,
    hasWrapper: true, hasHooks: false, glm52Supported: true,
  },
];

// ─── 辅助函数 ────────────────────────────────────────────────────────────

/**
 * which 命令：查找 CLI 二进制路径
 * 用 execSync 调用 `which <cmd>`，失败返回 undefined。
 */
function whichSync(cmd: string): string | undefined {
  try {
    const result = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 检测目录是否是 OpenSpace 创建的空残留。
 *
 * OpenSpace 会在 agent 的配置目录下创建 skills/ 子目录 + 指向 ~/.agents/skills/
 * 的 symlink，但 agent 本身并未安装。此函数判断目录是否仅含这类残留。
 *
 * 判定标准：
 *   1. 目录为空，或仅含 skills/ 子目录（允许 .DS_Store 等隐藏文件）
 *   2. skills/ 子目录为空，或仅含 symlink 且目标指向 ~/.agents/skills/
 */
function isOpenSpaceResidual(configPath: string): boolean {
  const home = homedir();
  const agentsSkillsDir = join(home, '.agents', 'skills');

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(configPath, { withFileTypes: true });
  } catch {
    return false;
  }

  // 空目录 = 残留
  if (entries.length === 0) return true;

  // 过滤隐藏文件（.DS_Store 等），只看有意义的条目
  const meaningful = entries.filter((e) => !e.name.startsWith('.'));
  if (meaningful.length === 0) return true; // 只有隐藏文件 = 残留

  // 必须只有 skills/ 一个子目录
  if (meaningful.length !== 1) return false;
  if (meaningful[0]!.name !== 'skills' || !meaningful[0]!.isDirectory()) return false;

  // 检查 skills/ 内容：仅含 symlink 且指向 ~/.agents/skills/
  const skillsDir = join(configPath, 'skills');
  let skillEntries: import('node:fs').Dirent[];
  try {
    skillEntries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return true; // skills/ 不可读，但目录结构符合残留特征
  }

  // 空 skills/ = 残留
  const meaningfulSkills = skillEntries.filter((e) => !e.name.startsWith('.'));
  if (meaningfulSkills.length === 0) return true;

  for (const e of meaningfulSkills) {
    if (!e.isSymbolicLink()) return false;
    try {
      const target = readlinkSync(join(skillsDir, e.name));
      // symlink 目标必须指向 ~/.agents/skills/ 下的某处
      if (!target.includes('.agents/skills') && !target.includes(agentsSkillsDir)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * 解析 agent 的配置目录路径。
 * 优先级：configDirName (~/.) > configDirXDG (~/.config/) > macOsAppSupportDir
 */
function resolveConfigPath(meta: AgentMeta, home: string): string | null {
  if (meta.configDirName) {
    return join(home, meta.configDirName);
  }
  if (meta.configDirXDG) {
    return join(home, '.config', meta.configDirXDG);
  }
  if (meta.macOsAppSupportDir) {
    return join(home, 'Library', 'Application Support', meta.macOsAppSupportDir);
  }
  return null;
}

/**
 * 根据 agent meta 和 home 目录，返回 session 存储路径。
 * 某些 agent（aider, crush）是 per-project 存储，无全局 session 目录，返回 undefined。
 */
function resolveSessionDir(meta: AgentMeta, home: string): string | undefined {
  switch (meta.canonical) {
    case 'claude':
      return join(home, '.claude', 'projects');
    case 'codex':
      return join(home, '.codex', 'sessions');
    case 'cass':
      return join(home, 'Library', 'Application Support', 'com.coding-agent-search.coding-agent-search');
    case 'opencode':
      return join(home, '.local', 'share', 'opencode');
    case 'hermes':
      return join(home, '.hermes');
    case 'kimi':
      return join(home, '.kimi', 'sessions');
    case 'cursor':
      return undefined; // CLI placeholder, no sessions
    case 'cursor-ide':
      return join(home, '.cursor', 'projects');
    case 'copilot':
      return join(home, '.copilot', 'session-state');
    case 'gemini':
      return join(home, '.gemini', 'tmp');
    case 'qwen':
      return join(home, '.qwen', 'projects');
    case 'openclaw':
      return join(home, '.openclaw', 'sessions');
    case 'aider':
      return undefined; // per-project .aider.chat.history.md
    case 'trae':
      return undefined; // CLI placeholder
    case 'trae-ide': {
      // 优先 .trae-cn（CN 版），回退 .trae（国际版）
      const cn = join(home, '.trae-cn', 'memory', 'projects');
      if (existsSync(cn)) return cn;
      return join(home, '.trae', 'memory', 'projects');
    }
    case 'trae-cli':
      return undefined; // 无默认 session 目录（用户 -t 指定）
    case 'windsurf':
      return join(home, '.codeium', 'windsurf', 'cascade');
    case 'openhands':
      return join(home, '.openhands', 'workspace', 'conversations');
    case 'goose':
      return join(home, '.local', 'share', 'goose');
    case 'antigravity':
      return join(home, 'Library', 'Application Support', 'Google', 'Antigravity');
    case 'factory':
      return join(home, '.factory', 'sessions');
    case 'vibe':
      return join(home, '.vibe', 'logs', 'session');
    case 'codebuddy':
      return join(home, '.codebuddy');
    case 'amp':
      return join(home, '.cache', 'amp', 'logs', 'threads');
    case 'chatgpt':
      return undefined; // SaaS, no local sessions
    case 'pi':
      return join(home, '.pi', 'agent', 'sessions');
    case 'omp':
      return join(home, '.omp', 'agent', 'sessions');
    case 'gsd-pi': {
      // 新版 ~/.gsd/agent/sessions，旧版 ~/.gsd/sessions
      const primary = join(home, '.gsd', 'agent', 'sessions');
      if (existsSync(primary)) return primary;
      return join(home, '.gsd', 'sessions');
    }
    case 'crush':
      return undefined; // per-project .crush/crush.db
    case 'cline':
      return join(home, '.cline', 'data', 'db');
    case 'continue':
      return join(home, '.continue', 'sessions');
    default:
      return undefined;
  }
}

// ─── detectAgents ─────────────────────────────────────────────────────────

/**
 * 检测本机安装的所有 agent CLI 及其能力。
 *
 * @param options.withSessionCount 是否查询 session 数（需要打开 store）
 * @param options.dbPath store 路径（默认 ~/.yondermesh/yondermesh.db）
 * @returns AgentDetection[] — 每个 agent 一条检测记录
 */
export function detectAgents(options?: DetectOptions): AgentDetection[] {
  const home = homedir();
  const results: AgentDetection[] = [];

  for (const meta of AGENT_REGISTRY) {
    const detection: AgentDetection = {
      canonical: meta.canonical,
      displayName: meta.displayName,
      installed: false,
      installType: meta.installType,
      collectionLevel: meta.collectionLevel,
      scanStatus: meta.scanStatus,
      mountMcp: meta.mountMcp,
      mountSkills: meta.mountSkills,
      mountAlwaysOn: meta.mountAlwaysOn,
      hasWrapper: meta.hasWrapper,
      hasHooks: meta.hasHooks,
      glm52Supported: meta.glm52Supported,
    };

    // 1. 检测 CLI 二进制
    if (meta.cliBinaryName) {
      const binaryPath = whichSync(meta.cliBinaryName);
      if (binaryPath) {
        detection.installed = true;
        detection.installType = 'cli';
        detection.cliBinary = binaryPath;
      }
    }

    // 2. 检测配置目录（~/. 或 ~/.config/ 或 ~/Library/Application Support/）
    const configPath = resolveConfigPath(meta, home);
    if (configPath && existsSync(configPath)) {
      // 即使 CLI 已检测到，也记录 configDir
      detection.configDir = configPath;
      if (!detection.installed) {
        // 检查是否是 OpenSpace 残留
        if (!isOpenSpaceResidual(configPath)) {
          detection.installed = true;
          // installType 保持 meta.installType（配置目录存在说明对应类型已安装）
        }
      }
    }

    // 3. 检测 macOS App（IDE / SaaS 类型）
    if (!detection.installed && meta.appPath) {
      if (existsSync(meta.appPath)) {
        detection.installed = true;
        detection.installType = meta.installType === 'saas' ? 'saas' : 'ide';
      }
    }

    // 4. 设置 sessionDir
    if (detection.installed) {
      detection.sessionDir = resolveSessionDir(meta, home);
    } else {
      detection.installType = 'not-found';
    }

    results.push(detection);
  }

  // 5. 查询 session 数（可选）
  if (options?.withSessionCount) {
    const dataDir = process.env.YONDERMESH_HOME ?? join(home, '.yondermesh');
    const dbPath = options.dbPath ?? join(dataDir, 'yondermesh.db');
    try {
      const store = new SessionStore(dbPath);
      const breakdown = store.getSourceBreakdown();
      store.close();

      // 构建 source → count 映射（用 normalizeSource 归一化 key）
      const countMap = new Map<string, number>();
      for (const item of breakdown) {
        countMap.set(item.source, item.count);
      }

      for (const det of results) {
        // canonical 可能与 store 的 source 不同名（如 trae-cli vs trae_cli），
        // 用 normalizeSource 归一化后查找
        const storeCanonical = normalizeSource(det.canonical);
        det.sessionCount = countMap.get(storeCanonical) ?? 0;
      }
    } catch {
      // store 不可读时跳过 session 数查询
    }
  }

  return results;
}

// ─── 格式化输出 ────────────────────────────────────────────────────────────

/**
 * 表格格式化输出检测结果（人类可读）。
 *
 * 列说明：
 *   AGENT    — canonical 名称
 *   STATUS   — ✅/❌ + scanStatus
 *   LEVEL    — 采集覆盖等级（A/B/C/none）
 *   MCP      — 是否支持 MCP 挂载
 *   SKL      — 是否支持 Skills 挂载
 *   AON      — 是否支持 Always-on 注入
 *   WRAP     — 是否有 wrapper
 *   HOOK     — 是否有 hooks
 *   GLM      — 是否支持 GLM-5.2
 *   SESS     — 已采集 session 数（未查询时显示 —）
 */
export function formatAgentsTable(detections: AgentDetection[]): string {
  const icon = (v: boolean): string => (v ? '✅' : '—');
  const lines: string[] = [];

  // 表头
  lines.push(
    'AGENT                  STATUS      LEVEL  MCP   SKL   AON   WRAP  HOOK  GLM   SESS'
  );
  lines.push(
    '─────────────────────────────────────────────────────────────────────────────────'
  );

  for (const d of detections) {
    const agent = d.canonical.padEnd(22);
    const status = `${d.installed ? '✅' : '❌'} ${d.scanStatus}`.padEnd(11);
    const level = d.collectionLevel.padEnd(5);
    const mcp = icon(d.mountMcp).padEnd(5);
    const skl = icon(d.mountSkills).padEnd(5);
    const aon = icon(d.mountAlwaysOn).padEnd(5);
    const wrap = icon(d.hasWrapper).padEnd(5);
    const hook = icon(d.hasHooks).padEnd(5);
    const glm = icon(d.glm52Supported).padEnd(5);
    const sess = d.sessionCount !== undefined ? String(d.sessionCount) : '—';

    lines.push(`${agent}${status}${level}${mcp}${skl}${aon}${wrap}${hook}${glm}${sess}`);
  }

  // 汇总
  const installed = detections.filter((d) => d.installed).length;
  lines.push('');
  lines.push(`已安装: ${installed}/${detections.length}`);

  return lines.join('\n');
}

/**
 * JSON 格式化输出检测结果。
 */
export function formatAgentsJson(detections: AgentDetection[]): string {
  return JSON.stringify(detections, null, 2);
}
