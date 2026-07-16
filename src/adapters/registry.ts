/**
 * 统一适配器注册表（T1.1）
 *
 * 把散落在三处的 CLI 登记信息归并成一份：
 *   - src/mcp/tools.ts 的 WRAPPER_LOADERS（23 个 wrapper 动态加载器）
 *   - src/mount/registry.ts 的 CLI_REGISTRY（30 个挂载能力条目）
 *   - src/bin/ymesh.ts 的 cmdScan（27 个采集器）+ AGENT_TABLE 覆盖等级
 *
 * 对外暴露：
 *   - ADAPTERS         完整注册表数组
 *   - getAdapter(id)   按 id 查单个适配器
 *   - listAdapters()   返回全部
 *   - listImporters()  只返回有采集能力的
 *   - loadWrapper(id)  动态加载 wrapper 模块
 *
 * 本文件只做登记，不改变 tools.ts / cmdScan / mount 的现有调用行为。
 * T1.2 会把调用点切换到本注册表。
 */

import type { ExtensionType, MountStrategyType } from '../mount/types.js';
import type { TriggerChannel } from '../trigger/types.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 挂载能力（只保留策略与扩展类型，resolve 属 mount 实现细节） */
export interface AdapterMountCapability {
  strategy: MountStrategyType;
  extensionTypes: ExtensionType[];
}

/**
 * 统一适配器描述符 —— 一个 CLI 的全部能力集中在一处。
 *
 * 字段来源：
 *   id / displayName / mountCapabilities  ← CLI_REGISTRY (mount/registry.ts)
 *   coverage                             ← AGENT_TABLE.collectionLevel (ymesh.ts)
 *   importerLoader                       ← cmdScan 的 importer 模块路径 (ymesh.ts)
 *   wrapperLoader                        ← WRAPPER_LOADERS (tools.ts)
 *   injectLoader                         ← src/<cli>/inject.ts 是否存在
 *   channels                             ← trigger/adapter.ts 的 IDE / HTTP / WS 分类
 */
export interface AdapterDescriptor {
  /** 规范化 CLI ID */
  id: string;
  /** 展示名称 */
  displayName: string;
  /** 覆盖等级：A = 原生采集  B = 兼容采集  C = 仅发现 */
  coverage: 'A' | 'B' | 'C';
  /** 采集器动态加载器 */
  importerLoader?: () => Promise<unknown>;
  /** wrapper 动态加载器（launch / inject / transfer） */
  wrapperLoader?: () => Promise<unknown>;
  /** inject 动态加载器（配置注入） */
  injectLoader?: () => Promise<unknown>;
  /** 挂载能力 */
  mountCapabilities: AdapterMountCapability[];
  /** 触发通道（trigger 层分类） */
  channels: TriggerChannel[];
}

// ---------------------------------------------------------------------------
// 可复用的挂载能力与通道常量
// ---------------------------------------------------------------------------

const mcpJson: AdapterMountCapability = { strategy: 'mcp-json', extensionTypes: ['mcp-server'] };
const mcpToml: AdapterMountCapability = { strategy: 'mcp-toml', extensionTypes: ['mcp-server'] };
const mcpTomlArray: AdapterMountCapability = { strategy: 'mcp-toml-array', extensionTypes: ['mcp-server'] };
const claudeMcp: AdapterMountCapability = { strategy: 'claude-mcp', extensionTypes: ['mcp-server'] };
const skillSymlink: AdapterMountCapability = { strategy: 'skill-symlink', extensionTypes: ['skill'] };
const alwaysOn: AdapterMountCapability = { strategy: 'always-on', extensionTypes: ['plugin'] };
const cliInject: AdapterMountCapability = { strategy: 'cli-inject', extensionTypes: ['cli-inject'] };

const NO_MOUNT: AdapterMountCapability[] = [];

const chSpawn: TriggerChannel[] = ['cli-spawn'];
const chHttp: TriggerChannel[] = ['http-api'];
const chWs: TriggerChannel[] = ['ws-rpc'];
const chIde: TriggerChannel[] = ['tmux', 'applescript'];
const chNone: TriggerChannel[] = [];

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export const ADAPTERS: AdapterDescriptor[] = [
  // ── A 级（原生采集）─────────────────────────────────────────────────────

  {
    id: 'cass',
    displayName: 'Cass (ymesh meta-scanner)',
    coverage: 'A',
    importerLoader: () => import('../cass/index.js'),
    mountCapabilities: NO_MOUNT,
    channels: chNone,
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    coverage: 'A',
    importerLoader: () => import('../claude/index.js'),
    mountCapabilities: [claudeMcp, alwaysOn],
    channels: chSpawn,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    coverage: 'A',
    importerLoader: () => import('../codex/index.js'),
    mountCapabilities: [mcpToml, skillSymlink, alwaysOn],
    channels: chSpawn,
  },
  {
    id: 'hermes',
    displayName: 'Hermes Agent',
    coverage: 'A',
    importerLoader: () => import('../hermes/index.js'),
    wrapperLoader: () => import('../hermes/index.js'),
    injectLoader: () => import('../hermes/inject.js'),
    mountCapabilities: [alwaysOn],
    channels: chSpawn,
  },
  {
    id: 'continue',
    displayName: 'Continue CLI (@continuedev/cli, binary: cn)',
    coverage: 'A',
    importerLoader: () => import('../continue/index.js'),
    wrapperLoader: () => import('../continue/index.js'),
    injectLoader: () => import('../continue/inject.js'),
    mountCapabilities: [skillSymlink],
    channels: chSpawn,
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    coverage: 'A',
    importerLoader: () => import('../opencode/index.js'),
    wrapperLoader: () => import('../opencode/index.js'),
    injectLoader: () => import('../opencode/inject.js'),
    mountCapabilities: NO_MOUNT,
    channels: chHttp,
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    coverage: 'A',
    importerLoader: () => import('../copilot/index.js'),
    wrapperLoader: () => import('../copilot/index.js'),
    injectLoader: () => import('../copilot/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chWs,
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    coverage: 'A',
    importerLoader: () => import('../openclaw/index.js'),
    wrapperLoader: () => import('../openclaw/index.js'),
    injectLoader: () => import('../openclaw/inject.js'),
    mountCapabilities: [cliInject],
    channels: chWs,
  },
  {
    id: 'kimi',
    displayName: 'Kimi CLI',
    coverage: 'A',
    importerLoader: () => import('../kimi/index.js'),
    wrapperLoader: () => import('../kimi/index.js'),
    injectLoader: () => import('../kimi/inject.js'),
    mountCapabilities: [cliInject],
    channels: chWs,
  },
  {
    id: 'qwen',
    displayName: 'Qwen Code',
    coverage: 'A',
    importerLoader: () => import('../qwen/index.js'),
    wrapperLoader: () => import('../qwen/index.js'),
    injectLoader: () => import('../qwen/inject.js'),
    mountCapabilities: [mcpJson, alwaysOn],
    channels: chHttp,
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    coverage: 'A',
    importerLoader: () => import('../gemini/index.js'),
    wrapperLoader: () => import('../gemini/index.js'),
    injectLoader: () => import('../gemini/inject.js'),
    mountCapabilities: [mcpJson, alwaysOn],
    channels: chSpawn,
  },
  {
    id: 'pi',
    displayName: 'Pi Agent',
    coverage: 'A',
    importerLoader: () => import('../pi/index.js'),
    wrapperLoader: () => import('../pi/index.js'),
    injectLoader: () => import('../pi/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chWs,
  },
  // omp / gsd-pi 无独立 importer，由 PiImporter 共享采集
  {
    id: 'omp',
    displayName: 'Oh-My-Pi (omp)',
    coverage: 'A',
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chNone,
  },
  {
    id: 'gsd-pi',
    displayName: 'GSD-Pi',
    coverage: 'A',
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chNone,
  },
  {
    id: 'factory',
    displayName: 'Factory Droid (Factory AI)',
    coverage: 'A',
    importerLoader: () => import('../factory/index.js'),
    wrapperLoader: () => import('../factory/index.js'),
    injectLoader: () => import('../factory/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chSpawn,
  },
  {
    id: 'vibe',
    displayName: 'Vibe (Mistral AI)',
    coverage: 'A',
    importerLoader: () => import('../vibe/index.js'),
    wrapperLoader: () => import('../vibe/index.js'),
 injectLoader: () => import('../vibe/inject.js'),
    mountCapabilities: [mcpTomlArray, skillSymlink, alwaysOn],
    channels: chSpawn,
  },
  {
    id: 'codebuddy',
    displayName: 'WorkBuddy / CodeBuddy (Tencent)',
    coverage: 'A',
    importerLoader: () => import('../codebuddy/index.js'),
    wrapperLoader: () => import('../codebuddy/index.js'),
    injectLoader: () => import('../codebuddy/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chSpawn,
  },
  {
    id: 'cline',
    displayName: 'Cline',
    coverage: 'A',
    importerLoader: () => import('../cline/index.js'),
    wrapperLoader: () => import('../cline/index.js'),
    injectLoader: () => import('../cline/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chSpawn,
  },
  {
    id: 'crush',
    displayName: 'Crush (Charm)',
    coverage: 'A',
    importerLoader: () => import('../crush/index.js'),
    wrapperLoader: () => import('../crush/index.js'),
    injectLoader: () => import('../crush/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chSpawn,
  },
  {
    id: 'openhands',
    displayName: 'OpenHands',
    coverage: 'A',
    importerLoader: () => import('../openhands/index.js'),
    wrapperLoader: () => import('../openhands/index.js'),
    injectLoader: () => import('../openhands/inject.js'),
    mountCapabilities: [mcpToml, skillSymlink, alwaysOn],
    channels: chHttp,
  },
  {
    id: 'goose',
    displayName: 'Goose (Block)',
    coverage: 'A',
    importerLoader: () => import('../goose/index.js'),
    wrapperLoader: () => import('../goose/index.js'),
    injectLoader: () => import('../goose/inject.js'),
    mountCapabilities: [mcpToml, skillSymlink, alwaysOn],
    channels: chSpawn,
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity (Google IDE)',
    coverage: 'A',
    importerLoader: () => import('../antigravity/index.js'),
    wrapperLoader: () => import('../antigravity/index.js'),
    injectLoader: () => import('../antigravity/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chSpawn,
  },

  // ── B 级（兼容采集）─────────────────────────────────────────────────────

  {
    id: 'aider',
    displayName: 'Aider',
    coverage: 'B',
    importerLoader: () => import('../aider/index.js'),
    wrapperLoader: () => import('../aider/index.js'),
    injectLoader: () => import('../aider/inject.js'),
    mountCapabilities: [cliInject],
    channels: chSpawn,
  },
  {
    id: 'trae-cli',
    displayName: 'Trae CLI',
    coverage: 'B',
    importerLoader: () => import('../trae-cli/index.js'),
    wrapperLoader: () => import('../trae-cli/index.js'),
    injectLoader: () => import('../trae-cli/inject.js'),
    mountCapabilities: [mcpToml],
    channels: chSpawn,
  },
  {
    id: 'windsurf',
    displayName: 'Windsurf',
    coverage: 'B',
    importerLoader: () => import('../windsurf/index.js'),
    wrapperLoader: () => import('../windsurf/index.js'),
    injectLoader: () => import('../windsurf/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chIde,
  },
  {
    id: 'cursor-ide',
    displayName: 'Cursor IDE',
    coverage: 'B',
    importerLoader: () => import('../cursor-ide/index.js'),
    wrapperLoader: () => import('../cursor-ide/index.js'),
    injectLoader: () => import('../cursor-ide/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chIde,
  },
  {
    id: 'trae-ide',
    displayName: 'Trae IDE',
    coverage: 'B',
    importerLoader: () => import('../trae-ide/index.js'),
    wrapperLoader: () => import('../trae-ide/index.js'),
    injectLoader: () => import('../trae-ide/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chIde,
  },
  {
    id: 'amp',
    displayName: 'Amp (Sourcegraph)',
    coverage: 'B',
    importerLoader: () => import('../amp/index.js'),
    wrapperLoader: () => import('../amp/index.js'),
    injectLoader: () => import('../amp/inject.js'),
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chSpawn,
  },

  // ── C 级（仅发现）───────────────────────────────────────────────────────

  {
    id: 'chatgpt',
    displayName: 'ChatGPT Desktop',
    coverage: 'C',
    importerLoader: () => import('../chatgpt/index.js'),
    mountCapabilities: [cliInject],
    channels: chIde,
  },

  // ── 仅挂载（无独立采集器 / wrapper）──────────────────────────────────────
  // 以下 CLI 在 CLI_REGISTRY 中有挂载条目，但 cmdScan 无对应 importer。

  {
    id: 'cursor',
    displayName: 'Cursor',
    coverage: 'B',
    mountCapabilities: [mcpJson, skillSymlink, alwaysOn],
    channels: chNone,
  },
  {
    id: 'trae',
    displayName: 'Trae (International, covers IDE + Work)',
    coverage: 'B',
    mountCapabilities: [skillSymlink, alwaysOn],
    channels: chNone,
  },
  {
    id: 'trae-cn',
    displayName: 'Trae CN (Chinese, covers IDE + Work)',
    coverage: 'B',
    mountCapabilities: [skillSymlink, alwaysOn],
    channels: chNone,
  },
];

// ---------------------------------------------------------------------------
// 查询函数
// ---------------------------------------------------------------------------

/** 按 id 查找适配器，未找到返回 undefined */
export function getAdapter(id: string): AdapterDescriptor | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

/** 返回全部适配器 */
export function listAdapters(): AdapterDescriptor[] {
  return ADAPTERS;
}

/** 返回有采集器（importerLoader）的适配器 */
export function listImporters(): AdapterDescriptor[] {
  return ADAPTERS.filter((a) => a.importerLoader !== undefined);
}

/**
 * 动态加载 wrapper 模块。未注册 wrapper 的 CLI 返回 null。
 * 加载失败也返回 null（与 tools.ts 的 loadWrapper 行为一致）。
 */
export async function loadWrapper(id: string): Promise<unknown> {
  const adapter = getAdapter(id);
  if (!adapter?.wrapperLoader) return null;
  try {
    return await adapter.wrapperLoader();
  } catch {
    return null;
  }
}
