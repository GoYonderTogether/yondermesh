#!/usr/bin/env node
/**
 * yondermesh CLI 入口（LOOP-007）
 *
 * 极简命令行，不引入外部依赖：
 *   ymesh help / version / scan / status / sessions / daemon
 *
 * 支持 --json 全局标志，输出 JSON 格式。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

import { SessionStore } from '../store/index.js';
import { detectAliveProcesses } from '../store/process-detector.js';
import type { ActiveSummary, SessionStats, SessionRecord } from '../store/index.js';
import { CassImporter } from '../cass/index.js';
import { ClaudeCodeImporter } from '../claude/index.js';
import { CodexImporter } from '../codex/index.js';
import { HermesImporter } from '../hermes/index.js';
import { WindsurfExtractor } from '../windsurf/index.js';
import { ContinueImporter } from '../continue/index.js';
import { OpenCodeImporter } from '../opencode/index.js';
import { CopilotImporter } from '../copilot/index.js';
import { OpenClawImporter } from '../openclaw/index.js';
import { KimiImporter } from '../kimi/index.js';
import { QwenCodeImporter } from '../qwen/index.js';
import { GeminiImporter } from '../gemini/index.js';
import { PiImporter } from '../pi/index.js';
import { FactoryDroidImporter } from '../factory/index.js';
import { VibeImporter } from '../vibe/index.js';
import { CodeBuddyImporter } from '../codebuddy/index.js';
import { ClineImporter } from '../cline/index.js';
import { CrushImporter } from '../crush/index.js';
import { OpenHandsImporter } from '../openhands/index.js';
import { GooseImporter } from '../goose/index.js';
import { AntigravityImporter } from '../antigravity/index.js';
import { AiderImporter } from '../aider/index.js';
import { TraeCliImporter } from '../trae-cli/index.js';
import { CursorIdeExtractor } from '../cursor-ide/index.js';
import { TraeIdeExtractor } from '../trae-ide/index.js';
import { AmpImporter } from '../amp/index.js';
import { ChatGptExtractor } from '../chatgpt/index.js';
import { YondermeshDaemon, defaultDaemonConfig, defaultDataDir } from '../daemon/index.js';
import type { DaemonConfig } from '../daemon/index.js';

import {
  buildRelease,
  installRelease,
  listReleases,
  getCurrentRelease,
  rollbackRelease,
  installService,
  uninstallService,
  startService,
  stopService,
  getServiceStatus,
 updateFromGit,
 linkSkills,
 unlinkSkills,
 installMenuBarApp,
 uninstallMenuBarApp,
 startMenuBarApp,
 stopMenuBarApp,
 resolveEntrySymlink as ENTRY_SYMLINK,
  resolveLaunchAgentPlist as LAUNCH_AGENT_PLIST,
} from '../install/index.js';
import { mountAll, verifyAll, unmountAll, detectInstalledClis, findCli } from '../mount/index.js';
import {
  extractProject,
  queryExtracts,
  projectHashOf,
  listExtracts,
} from '../extract/index.js';
import type { ExtractKind } from '../extract/index.js';

import { McpServer } from '../mcp/server.js';
import {
  registerAll,
  unregisterAll,
  checkRegistration,
  buildYmeshArgs,
} from '../mcp/register.js';
import { buildSessionHandoff } from '../mcp/codex-handoff.js';
import type { HandoffPackage } from '../mcp/codex-handoff.js';
import { MCP_TOOLS, listToolSchemas } from '../mcp/tools.js';
import { MailboxCore } from '../mailbox/index.js';
import type {
  MailKind,
  MailPriority,
  MailboxMessage,
  MessageFilter,
  PostMessageInput,
} from '../mailbox/index.js';
import { MAIL_KINDS, MAIL_PRIORITIES } from '../mailbox/index.js';

// 读取 package.json 的版本号
const projectRoot = dirname(dirname(dirname(new URL(import.meta.url).pathname)));
const packageJson = JSON.parse(readFileSync(`${projectRoot}/package.json`, 'utf-8'));
const VERSION = packageJson.version as string;

/**
 * 解析源码根目录（用于 install / update --local）。
 *
 * 优先级：
 *   1. 环境变量 YONDERMESH_DEV_ROOT（用户显式指定源码根）
 *   2. 从当前文件向上查找 package.json，命中 name === 'yondermesh' 且同目录含 tsconfig.json
 *      （tsconfig.json 用于排除 release 目录——release 的 package.json 也有 name=yondermesh）
 *   3. 回退到 import.meta.url 推算的目录（dev 模式正确，release 模式指向 release 目录）
 */
function resolveProjectRoot(): string {
  // 1. 环境变量
  const envRoot = process.env.YONDERMESH_DEV_ROOT;
  if (envRoot && existsSync(envRoot)) {
    return envRoot;
  }

  // 2. 向上查找 package.json + tsconfig.json
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'yondermesh' && existsSync(join(dir, 'tsconfig.json'))) {
          return dir;
        }
      } catch {
        /* package.json 解析失败，继续向上 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到达文件系统根
    dir = parent;
  }

  // 3. 回退
  return dirname(dirname(dirname(new URL(import.meta.url).pathname)));
}

// ─── 参数解析 ────────────────────────────────────────────────────────────

/** 解析后的命令行参数 */
interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

/** 极简参数解析：支持 --flag、--flag=value、--flag value、positional */
function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      // --flag=value
      if (arg.includes('=')) {
        const eqIdx = arg.indexOf('=');
        const key = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        flags[key] = value;
      } else {
        const key = arg.slice(2);
        // 检查下一个参数是否是值（不以 -- 开头且存在）
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

/** 解析 --from / --to 时间参数为 epoch ms */
function parseTime(value: string | boolean | undefined): number | undefined {
  if (value === undefined || typeof value === 'boolean') return undefined;
  const num = parseInt(value, 10);
  if (!isNaN(num)) return num; // epoch ms
  const parsed = Date.parse(value);
  return isNaN(parsed) ? undefined : parsed;
}

/** 解析 --limit 参数 */
function parseLimit(flags: Record<string, string | boolean>): number | undefined {
  const v = flags.limit;
  if (v === undefined || typeof v === 'boolean') return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

// ─── 命令实现 ────────────────────────────────────────────────────────────

/** 打开 store（确保 dataDir 存在） */
function openStore(dbPath?: string): SessionStore {
  const config = defaultDaemonConfig();
  const p = dbPath ?? config.dbPath;
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    /* 已存在 */
  }
  return new SessionStore(p);
}

/** help 命令 */
function cmdHelp(): number {
  console.log(`
yondermesh v${VERSION} — 自托管 Agent 上下文总线

用法:
  ymesh <command> [options]

命令:
  help                显示此帮助信息
  version             显示版本号
  scan                扫描本机全部 session（27 个 adapter：cass/claude/codex/hermes/
                      windsurf/continue/opencode/copilot/openclaw/kimi/qwen/gemini/pi/
                      factory/vibe/codebuddy/cline/crush/openhands/goose/antigravity/
                      aider/trae-cli/cursor-ide/trae-ide/amp/chatgpt）
  status              显示 daemon 状态和最近扫描结果
  agents              列出本机检测到的所有 agent 及其支持状态
  sessions            列出 session（支持过滤）
  daemon              启动后台 daemon（实时监听 + 定时 reconcile）
                      选项: --db <path> --data-dir <dir> --pid-file <path>
  install             本地构建 release 并安装
    service <action>    LaunchAgent + menubar app (install|uninstall|start|stop|status)
  releases            列出已安装的 release 版本
  update [--local]    从 Git 源码更新（构建失败自动回退）；--local 跳过 clone，从本地源码打包
  rollback            手动回退到上一个 release 版本
  mcp                 启动 MCP server（stdio JSON-RPC，供其他 agent 挂载）
  mcp call <tool> [args]  终端直接调用 MCP 工具（如 ymesh mcp call who_is_working）
  mcp register        注册 MCP server 到 Claude Code 和 Codex（安装后新 session 自动可用）
  mcp unregister      从 Claude Code 和 Codex 注销
  mcp status          查看 MCP 注册状态
  active              快速查看当前正在运行的 session（谁在干活）
  waiting             查看等待你审阅的 session（agent 已完成回复）
  doctor              运行系统诊断（检查安装、数据库、daemon、日志健康状态）
  mount [status|all|remove]  管理跨 CLI 挂载（MCP/Skill/Plugin 到所有已安装的 CLI agent）
  extract             提取项目全部 user 需求与 assistant 响应到 NDJSONL 文件（按行号/ID 索引）
  handoff <id>        提取 session 浓缩 handoff 包（compacted 摘要 + tool call + plan），用于任务接管
  state <action>      管理运行时状态文件 (sync|show)
  mailbox <action>    跨 session 消息总线 (post|get|pop|list|mark-read|check|whoami|unread)
  launch              启动新 agent session（--cli <agent> --prompt "text" [--model <m>]）
  inject              向运行中 session 注入消息（--cli <agent> --session <id> --message "text"）
  transfer            跨 agent 转交 session（--cli <src> --session <id> --target <dst> [--output <path>]）

安装方式:
  curl -fsSL https://raw.githubusercontent.com/GoYonderTogether/yondermesh/main/install.sh | bash
  或: git clone ... && ./install.sh

通用选项:
  --json              以 JSON 格式输出结果（便于脚本消费）
  --db <path>         指定数据库路径（默认 ~/.yondermesh/yondermesh.db）

sessions 过滤选项:
  --limit <n>         限制输出条数（默认 20）
  --source <name>     按来源过滤（claude / codex / cass）
  --topology <type>   按拓扑过滤（root / subagent）
  --cwd <path>        按 cwd 精确匹配
  --cwd-prefix <path> 按 cwd 前缀匹配（目录边界安全）
  --project <path>    按 projectPath 精确匹配
  --from <time>       起始时间（epoch ms 或 ISO 日期）
  --to <time>         截止时间（epoch ms 或 ISO 日期）
  --include-archived  包含被去重的 session（默认不显示）

extract 选项:
  --cwd-prefix <path>  项目目录前缀（默认当前 cwd）
  --project <path>     projectPath 精确匹配（与 --cwd-prefix 二选一）
  --from / --to        session 起始时间区间过滤
  --requirements       查询需求文件（user 消息）
  --responses          查询响应文件（assistant 消息）
  --id <n>             按行号/ID 精确取一条（1-based）
  --keyword <text>     关键词模糊匹配（大小写不敏感）
  --session <id>       按 yondermesh session ID 过滤
  --limit <n>          查询返回条数上限
  --offset <n>         查询跳过前 N 条
  --list               列出所有已提取过的项目

handoff 选项:
  --json              以 JSON 格式输出 handoff 包
  --tail <n>          尾部消息条数（默认 30）

示例:
  ymesh scan
  ymesh sessions --limit 50
  ymesh sessions --source claude --topology root
  ymesh sessions --cwd-prefix /Users/zoran/projects --json
  ymesh status
  ymesh daemon
  ymesh extract --cwd-prefix /Users/zoran/projects/yondermesh
  ymesh extract --requirements --id 3
  ymesh handoff 019f5fe4-b127-7de2-b8f1-efa45bee24cb
  ymesh handoff 019f5fe4-b127-7de2-b8f1-efa45bee24cb --json --tail 50
`);
  return 0;
}

/** version 命令 */
function cmdVersion(flags: Record<string, string | boolean>): number {
  if (flags.json) {
    console.log(JSON.stringify({ version: VERSION }));
  } else {
    console.log(`yondermesh v${VERSION}`);
  }
  return 0;
}

// ─── agent 检测基础设施 ──────────────────────────────────────────────────

/** 在 PATH 中查找 CLI 二进制，返回绝对路径或 null */
function which(bin: string): string | null {
  try {
    const result = execSync(`command -v ${bin} 2>/dev/null`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/** agent 元数据条目 */
interface AgentEntry {
  name: string;
  configDirs: string[];
  cliBinary?: string;
  collectionLevel: 'A' | 'B' | 'C';
  appPath?: string;
}

/** 全量 agent 注册表（与 source-aliases.ts 的 SOURCE_MAP 对齐） */
const AGENT_TABLE: AgentEntry[] = [
  { name: 'claude', configDirs: ['.claude'], cliBinary: 'claude', collectionLevel: 'A' },
  { name: 'codex', configDirs: ['.codex'], cliBinary: 'codex', collectionLevel: 'A' },
  { name: 'hermes', configDirs: ['.hermes'], cliBinary: 'hermes', collectionLevel: 'A' },
  { name: 'continue', configDirs: ['.continue'], cliBinary: 'cn', collectionLevel: 'A' },
  { name: 'opencode', configDirs: ['.local/share/opencode', '.opencode'], cliBinary: 'opencode', collectionLevel: 'A' },
  { name: 'copilot', configDirs: ['.copilot'], cliBinary: 'copilot', collectionLevel: 'A' },
  { name: 'openclaw', configDirs: ['.openclaw'], cliBinary: 'openclaw', collectionLevel: 'A' },
  { name: 'kimi', configDirs: ['.kimi'], cliBinary: 'kimi', collectionLevel: 'A' },
  { name: 'qwen', configDirs: ['.qwen'], cliBinary: 'qwen', collectionLevel: 'A' },
  { name: 'gemini', configDirs: ['.gemini'], cliBinary: 'gemini', collectionLevel: 'A' },
  { name: 'pi', configDirs: ['.pi/agent', '.pi'], cliBinary: 'pi', collectionLevel: 'A' },
  { name: 'omp', configDirs: ['.omp/agent', '.omp'], cliBinary: 'omp', collectionLevel: 'A' },
  { name: 'gsd-pi', configDirs: ['.gsd/agent', '.gsd'], cliBinary: 'gsd', collectionLevel: 'A' },
  { name: 'factory', configDirs: ['.factory'], cliBinary: 'droid', collectionLevel: 'A' },
  { name: 'vibe', configDirs: ['.vibe'], cliBinary: 'vibe', collectionLevel: 'A' },
  { name: 'codebuddy', configDirs: ['.codebuddy'], cliBinary: 'cbc', collectionLevel: 'A' },
  { name: 'cline', configDirs: ['.cline'], cliBinary: 'cline', collectionLevel: 'A' },
  { name: 'crush', configDirs: ['.config/crush', '.crush'], cliBinary: 'crush', collectionLevel: 'A' },
  { name: 'openhands', configDirs: ['.openhands'], cliBinary: 'openhands', collectionLevel: 'A' },
  { name: 'goose', configDirs: ['.local/share/goose', '.goose'], cliBinary: 'goose', collectionLevel: 'A' },
  { name: 'antigravity', configDirs: ['.antigravity'], cliBinary: 'agy', collectionLevel: 'A' },
  { name: 'aider', configDirs: ['.aider'], cliBinary: 'aider', collectionLevel: 'B' },
  { name: 'trae_cli', configDirs: ['.trae-cli', '.config/trae-cli'], cliBinary: 'trae', collectionLevel: 'B' },
  { name: 'windsurf', configDirs: ['.codeium/windsurf', '.windsurf'], cliBinary: 'windsurf', collectionLevel: 'B' },
  { name: 'cursor-ide', configDirs: ['.cursor'], collectionLevel: 'B' },
  { name: 'trae-ide', configDirs: ['.trae-cn', '.trae'], collectionLevel: 'B' },
  { name: 'amp', configDirs: ['.config/amp', '.cache/amp'], cliBinary: 'amp', collectionLevel: 'B' },
  { name: 'chatgpt', configDirs: [], collectionLevel: 'C', appPath: '/Applications/ChatGPT.app' },
];

/** canonical source → CLI_REGISTRY id 映射 */
const REGISTRY_ID_MAP: Record<string, string> = {
  'claude': 'claude-code',
  'codex': 'codex',
  'cursor-ide': 'cursor',
  'gemini': 'gemini',
  'windsurf': 'windsurf',
  'trae-ide': 'trae-cn',
  'continue': 'continue',
  'hermes': 'hermes',
  'factory': 'factory',
  'vibe': 'vibe',
  'codebuddy': 'codebuddy',
};

/** 有 wrapper.ts 的 agent 集合（claude/codex/chatgpt 无 wrapper） */
const WRAPPER_SUPPORTED = new Set<string>([
  'hermes', 'continue', 'opencode', 'copilot', 'openclaw',
  'kimi', 'qwen', 'gemini', 'pi', 'omp', 'gsd-pi', 'factory', 'vibe',
  'codebuddy', 'cline', 'crush', 'openhands', 'goose', 'antigravity',
  'aider', 'trae_cli', 'windsurf', 'cursor-ide', 'trae-ide', 'amp',
]);

/** 类式 wrapper 的导出类名映射 */
const WRAPPER_CLASS_NAME: Record<string, string> = {
  hermes: 'HermesController',
  continue: 'ContinueCliWrapper',
  opencode: 'OpenCodeController',
  copilot: 'CopilotWrapper',
  openclaw: 'OpenClawController',
  kimi: 'KimiController',
  pi: 'PiController',
  cline: 'ClineWrapper',
  crush: 'CrushWrapper',
  openhands: 'OpenHandsApiWrapper',
  goose: 'GooseCliWrapper',
  antigravity: 'AntigravityCliWrapper',
};

/** 检测 agent 是否已安装，返回匹配的配置目录（绝对路径）或 null */
function detectAgentConfigDir(home: string, entry: AgentEntry): string | null {
  for (const dir of entry.configDirs) {
    const abs = join(home, dir);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** 检测 daemon 是否运行 */
function isDaemonRunning(pidFile: string): boolean {
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 检测全部 agent，返回结果数组 */
interface AgentDetection {
  agent: string;
  installed: boolean;
  configDir: string | null;
  cliBinary: string | null;
  collectionLevel: string;
  scanStatus: string;
  mountSupport: boolean;
  wrapperSupport: boolean;
  sessionCount: number;
}

function detectAllAgents(dbPath: string): AgentDetection[] {
  const home = homedir();
  const config = defaultDaemonConfig();
  const daemonRunning = isDaemonRunning(config.pidFile);

  // 从 store 获取各 source 的 session 数
  const sessionCounts = new Map<string, number>();
  try {
    const store = new SessionStore(dbPath);
    const breakdown = store.getSourceBreakdown();
    for (const b of breakdown) {
      sessionCounts.set(b.source, b.count);
    }
    store.close();
  } catch {
    /* DB 不可读 */
  }

  return AGENT_TABLE.map((entry) => {
    const configDir = detectAgentConfigDir(home, entry);
    const cliBinary = entry.cliBinary ? which(entry.cliBinary) : null;
    const installed = !!configDir || !!cliBinary || (!!entry.appPath && existsSync(entry.appPath));

    const registryId = REGISTRY_ID_MAP[entry.name];
    const mountSupport = registryId ? !!findCli(registryId) : false;
    const wrapperSupport = WRAPPER_SUPPORTED.has(entry.name);
    const sessionCount = sessionCounts.get(entry.name) ?? 0;

    let scanStatus: string;
    if (!installed) {
      scanStatus = 'missing';
    } else if (daemonRunning) {
      scanStatus = 'active';
    } else {
      scanStatus = 'scan';
    }

    return {
      agent: entry.name,
      installed,
      configDir,
      cliBinary,
      collectionLevel: entry.collectionLevel,
      scanStatus,
      mountSupport,
      wrapperSupport,
      sessionCount,
    };
  });
}

/** scan 命令 */
function cmdScan(flags: Record<string, string | boolean>): number {
  const deviceId = (flags.device as string) ?? hostname();
  const store = openStore(flags.db as string | undefined);

  const importStats: Array<{ adapter: string; scanned: number; inserted: number; updated: number }> = [];

  // cass
  try {
    const importer = new CassImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'cass', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'cass', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[cass] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // claude
  try {
    const importer = new ClaudeCodeImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'claude', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'claude', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[claude] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // codex
  try {
    const importer = new CodexImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'codex', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'codex', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[codex] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // hermes
  try {
    const importer = new HermesImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'hermes', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'hermes', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[hermes] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // windsurf（B 级兼容 importer —— Cascade .pb 加密，hook transcript 采集）
  try {
    const extractor = new WindsurfExtractor(store, { deviceId });
    const stats = extractor.extract();
    importStats.push({ adapter: 'windsurf', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'windsurf', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[windsurf] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // continue（A 级原生 adapter —— @continuedev/cli，binary: cn）
  try {
    const importer = new ContinueImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'continue', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'continue', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[continue] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // opencode（A 级原生 adapter）
  try {
    const importer = new OpenCodeImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'opencode', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'opencode', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[opencode] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // copilot（A 级原生 adapter）
  try {
    const importer = new CopilotImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'copilot', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'copilot', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[copilot] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // openclaw（A 级原生 adapter）
  try {
    const importer = new OpenClawImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'openclaw', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'openclaw', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[openclaw] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // kimi（A 级原生 adapter）
  try {
    const importer = new KimiImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'kimi', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'kimi', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[kimi] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // qwen（A 级原生 adapter）
  try {
    const importer = new QwenCodeImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'qwen', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'qwen', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[qwen] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // gemini（A 级原生 adapter）
  try {
    const importer = new GeminiImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'gemini', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'gemini', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[gemini] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // pi（A 级原生 adapter —— Pi / oh-my-pi / gsd-pi 三 flavor 共享 importer）
  try {
    const importer = new PiImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'pi', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'pi', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[pi] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // factory（A 级原生 adapter —— Factory Droid）
  try {
    const importer = new FactoryDroidImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'factory', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'factory', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[factory] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // vibe（A 级原生 adapter —— Mistral AI）
  try {
    const importer = new VibeImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'vibe', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'vibe', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[vibe] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // codebuddy（A 级原生 adapter —— Tencent WorkBuddy/CodeBuddy）
  try {
    const importer = new CodeBuddyImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'codebuddy', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'codebuddy', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[codebuddy] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // cline（A 级原生 adapter）
  try {
    const importer = new ClineImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'cline', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'cline', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[cline] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // crush（A 级原生 adapter —— Charm）
  try {
    const importer = new CrushImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'crush', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'crush', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[crush] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // openhands（A 级原生 adapter）
  try {
    const importer = new OpenHandsImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'openhands', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'openhands', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[openhands] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // goose（A 级原生 adapter —— Block）
  try {
    const importer = new GooseImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'goose', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'goose', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[goose] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // antigravity（A 级原生 adapter —— Google IDE）
  try {
    const importer = new AntigravityImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'antigravity', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'antigravity', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[antigravity] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // aider（B 级兼容 adapter —— per-project markdown）
  try {
    const importer = new AiderImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'aider', scanned: stats.filesScanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'aider', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[aider] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // trae-cli（B 级兼容 adapter —— trae-agent trajectory JSON）
  try {
    const importer = new TraeCliImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'trae_cli', scanned: stats.filesScanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'trae_cli', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[trae_cli] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // cursor-ide（B 级兼容 importer —— state.vscdb 提取）
  try {
    const extractor = new CursorIdeExtractor(store, { deviceId });
    const stats = extractor.extract();
    importStats.push({ adapter: 'cursor-ide', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'cursor-ide', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[cursor-ide] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // trae-ide（B 级兼容 importer —— JSONL 摘要提取）
  try {
    const extractor = new TraeIdeExtractor(store, { deviceId });
    const stats = extractor.extract();
    importStats.push({ adapter: 'trae-ide', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'trae-ide', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[trae-ide] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // amp（B/C 级 adapter —— SaaS，amp threads export）
  try {
    const importer = new AmpImporter(store, { deviceId });
    const stats = importer.import();
    importStats.push({ adapter: 'amp', scanned: stats.threadsSeen, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    importStats.push({ adapter: 'amp', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[amp] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // chatgpt（C 级 discovery only —— 仅注册 source alias，不采集 session）
  try {
    const extractor = new ChatGptExtractor(store, { deviceId });
    extractor.extract();
    importStats.push({ adapter: 'chatgpt', scanned: 0, inserted: 0, updated: 0 });
  } catch (err) {
    importStats.push({ adapter: 'chatgpt', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[chatgpt] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // 跨源去重：cass (B) 与原生 adapter (A) 的重复 session 标记为 archived
  const dedup = store.deduplicateCrossSource();

  // 按真实 CLI agent 分组统计
  const breakdown = store.getSourceBreakdown();

  store.close();

  if (flags.json) {
    console.log(JSON.stringify({ importStats, dedup, breakdown }, null, 2));
  } else {
    console.log('\n扫描完成（已去重）：\n');
    for (const cli of breakdown) {
      const label = cli.source.padEnd(14);
      const topology = cli.subagentCount > 0 ? `  (root ${cli.rootCount} / sub ${cli.subagentCount})` : '';
      console.log(`  ${label} ${String(cli.count).padStart(5)} sessions${topology}`);
    }
    if (dedup.deduped > 0) {
      console.log(`\n  去重前 ${dedup.total} → 去重 ${dedup.deduped} → 去重后 ${dedup.unique}`);
    }
    console.log();
  }
  return 0;
}

/** status 命令 */
// ─── agents 命令 ──────────────────────────────────────────────────────────

/** agents 命令：检测本机所有 agent 及其支持状态 */
function cmdAgents(flags: Record<string, string | boolean>): number {
  const config = defaultDaemonConfig();
  const dbPath = (flags.db as string) ?? config.dbPath;
  const detections = detectAllAgents(dbPath);

  if (flags.json) {
    console.log(JSON.stringify(detections, null, 2));
    return 0;
  }

  console.log('\nDetected Agents:\n');
  console.log(
    `  ${'AGENT'.padEnd(14)} ${'STATUS'.padEnd(8)} ${'COLL'.padEnd(5)} ${'MOUNT'.padEnd(6)} ${'WRAPPER'.padEnd(8)} ${'SESSIONS'.padStart(8)}`,
  );
  for (const d of detections) {
    console.log(
      `  ${d.agent.padEnd(14)} ${d.scanStatus.padEnd(8)} ${d.collectionLevel.padEnd(5)} ${(d.mountSupport ? 'yes' : 'no').padEnd(6)} ${(d.wrapperSupport ? 'yes' : 'no').padEnd(8)} ${String(d.sessionCount).padStart(8)}`,
    );
  }
  const installed = detections.filter((d) => d.installed).length;
  console.log(`\n  已安装: ${installed}/${detections.length}`);
  console.log();
  return 0;
}

// ─── launch / inject / transfer 命令 ──────────────────────────────────────

/** 动态加载 agent wrapper 模块 */
async function loadWrapper(cli: string): Promise<any> {
  const wrapperMap: Record<string, () => Promise<any>> = {
    hermes: () => import('../hermes/index.js'),
    continue: () => import('../continue/index.js'),
    opencode: () => import('../opencode/index.js'),
    copilot: () => import('../copilot/index.js'),
    openclaw: () => import('../openclaw/index.js'),
    kimi: () => import('../kimi/index.js'),
    qwen: () => import('../qwen/index.js'),
    gemini: () => import('../gemini/index.js'),
    pi: () => import('../pi/index.js'),
    factory: () => import('../factory/index.js'),
    vibe: () => import('../vibe/index.js'),
    codebuddy: () => import('../codebuddy/index.js'),
    cline: () => import('../cline/index.js'),
    crush: () => import('../crush/index.js'),
    openhands: () => import('../openhands/index.js'),
    goose: () => import('../goose/index.js'),
    antigravity: () => import('../antigravity/index.js'),
    aider: () => import('../aider/index.js'),
    trae_cli: () => import('../trae-cli/index.js'),
    windsurf: () => import('../windsurf/index.js'),
    'cursor-ide': () => import('../cursor-ide/index.js'),
    'trae-ide': () => import('../trae-ide/index.js'),
    amp: () => import('../amp/index.js'),
  };
  const loader = wrapperMap[cli];
  if (!loader) throw new Error(`Unknown CLI: ${cli}`);
  return await loader();
}

/** 实例化类式 wrapper（若该 agent 使用类式 wrapper） */
function instantiateWrapper(cli: string, mod: any): any | null {
  const className = WRAPPER_CLASS_NAME[cli];
  if (className && mod[className]) {
    return new mod[className]();
  }
  return null;
}

/** launch 命令：启动新 session */
async function cmdLaunch(flags: Record<string, string | boolean>): Promise<number> {
  const cli = flags.cli as string;
  const prompt = flags.prompt as string;
  const model = flags.model as string | undefined;
  if (!cli || !prompt) {
    console.error('用法: ymesh launch --cli <agent> --prompt "text" [--model <model>] [--json]');
    return 1;
  }

  try {
    const mod = await loadWrapper(cli);
    const opts: Record<string, unknown> = {};
    if (model) opts.model = model;

    let result: unknown;
    const wrapper = instantiateWrapper(cli, mod);
    if (wrapper && typeof wrapper.launch === 'function') {
      result = await wrapper.launch(prompt, opts);
    } else if (typeof mod.launch === 'function') {
      result = await mod.launch({ prompt, ...opts });
    } else {
      throw new Error(`${cli} wrapper does not support launch()`);
    }

    if (flags.json) {
      console.log(JSON.stringify({ cli, prompt, status: 'launched', result }, null, 2));
    } else {
      console.log(`[yondermesh] ${cli} session launched`);
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if (r.sessionId) console.log(`  session: ${r.sessionId}`);
        else if (r.id) console.log(`  session: ${r.id}`);
      }
    }
    return 0;
  } catch (err) {
    console.error(`[yondermesh] launch 失败: ${String(err)}`);
    return 1;
  }
}

/** inject 命令：向运行中 session 注入消息 */
async function cmdInject(flags: Record<string, string | boolean>): Promise<number> {
  const cli = flags.cli as string;
  const session = flags.session as string;
  const message = flags.message as string;
  if (!cli || !session || !message) {
    console.error('用法: ymesh inject --cli <agent> --session <id> --message "text" [--json]');
    return 1;
  }

  try {
    const mod = await loadWrapper(cli);
    let result: unknown;
    const wrapper = instantiateWrapper(cli, mod);
    if (wrapper && typeof wrapper.inject === 'function') {
      result = await wrapper.inject(session, message);
    } else if (typeof mod.inject === 'function') {
      result = await mod.inject(session, message);
    } else {
      throw new Error(`${cli} wrapper does not support inject()`);
    }

    if (flags.json) {
      console.log(JSON.stringify({ cli, session, status: 'injected', result }, null, 2));
    } else {
      console.log(`[yondermesh] ${cli} session ${session} injected`);
    }
    return 0;
  } catch (err) {
    console.error(`[yondermesh] inject 失败: ${String(err)}`);
    return 1;
  }
}

/** transfer 命令：跨 agent 转交 session */
async function cmdTransfer(flags: Record<string, string | boolean>): Promise<number> {
  const cli = flags.cli as string;
  const session = flags.session as string;
  const target = flags.target as string;
  const output = flags.output as string | undefined;
  if (!cli || !session || !target) {
    console.error('用法: ymesh transfer --cli <source-agent> --session <id> --target <target-agent> [--output <path>] [--json]');
    return 1;
  }

  try {
    const mod = await loadWrapper(cli);
    let extractResult: unknown;
    let transferResult: unknown;

    const wrapper = instantiateWrapper(cli, mod);
    if (wrapper && typeof wrapper.extractSession === 'function') {
      extractResult = await wrapper.extractSession(session);
    } else if (typeof mod.extractSession === 'function') {
      extractResult = await mod.extractSession(session);
    } else {
      throw new Error(`${cli} wrapper does not support extractSession()`);
    }

    if (wrapper && typeof wrapper.transferSession === 'function') {
      transferResult = await wrapper.transferSession(session, target);
    } else if (typeof mod.transferSession === 'function') {
      transferResult = await mod.transferSession(session, target);
    } else {
      throw new Error(`${cli} wrapper does not support transferSession()`);
    }

    const handoffText =
      typeof transferResult === 'string'
        ? transferResult
        : JSON.stringify({ source: cli, target, session, extract: extractResult, transfer: transferResult }, null, 2);

    if (output) {
      writeFileSync(output, handoffText + '\n', 'utf-8');
      console.log(`[yondermesh] handoff 已写入 ${output}`);
    } else if (flags.json) {
      console.log(JSON.stringify({ cli, session, target, extract: extractResult, transfer: transferResult }, null, 2));
    } else {
      console.log(handoffText);
    }
    return 0;
  } catch (err) {
    console.error(`[yondermesh] transfer 失败: ${String(err)}`);
    return 1;
  }
}

/** status 命令 */
function cmdStatus(flags: Record<string, string | boolean>): number {
  const config = defaultDaemonConfig();
  const dbPath = (flags.db as string) ?? config.dbPath;
  const pidFile = (flags['pid-file'] as string) ?? config.pidFile;

  // 检查 daemon 是否运行
  let daemonRunning = false;
  let daemonPid: number | null = null;
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid) {
        try {
          process.kill(pid, 0);
          daemonRunning = true;
          daemonPid = pid;
        } catch {
          // 进程不存在
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  // 读取 daemon 持久化的 watchedPaths（仅在 daemon 运行时有效）
  let watchedPaths: string[] = [];
  if (daemonRunning) {
    try {
      const watchedPathsFile = join(config.dataDir, 'watched-paths.json');
      if (existsSync(watchedPathsFile)) {
        const parsed = JSON.parse(readFileSync(watchedPathsFile, 'utf-8')) as { paths?: string[] };
        if (Array.isArray(parsed.paths)) {
          watchedPaths = parsed.paths;
        }
      }
    } catch {
      /* 文件不可读或格式错误时按空数组处理 */
    }
  }

  // 获取 DB 统计
  let stats: { totalSessions: number; rootSessions: number; subagentSessions: number; totalMessages: number } | null = null;
  let lastScanRuns: unknown[] = [];
  try {
    const store = new SessionStore(dbPath);
    stats = store.getSessionStats({});
    // 读取最近 5 条 scan_run
    const db = (store as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }).db;
    lastScanRuns = db.prepare('SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 5').all();
    store.close();
  } catch {
    /* DB 不存在或不可读 */
  }

  if (flags.json) {
    console.log(JSON.stringify({
      daemonRunning,
      daemonPid,
      dbPath,
      watchedPaths,
      stats,
      recentScans: lastScanRuns,
      agents: detectAllAgents(dbPath),
    }, null, 2));
  } else {
    console.log(`\nyondermesh 状态\n`);
    console.log(`  daemon:  ${daemonRunning ? `运行中 (PID ${daemonPid})` : '未运行'}`);
    console.log(`  DB 路径: ${dbPath}`);
    console.log(`\n  实时监听目录 (${watchedPaths.length}):`);
    if (watchedPaths.length > 0) {
      for (const p of watchedPaths) {
        console.log(`    ${p}`);
      }
    } else {
      console.log(`    (无)`);
    }
    if (stats) {
      console.log(`\n  数据统计:`);
      console.log(`    总 session:  ${stats.totalSessions}`);
      console.log(`    根 session:  ${stats.rootSessions}`);
      console.log(`    子 agent:    ${stats.subagentSessions}`);
      console.log(`    总消息:      ${stats.totalMessages}`);
    } else {
      console.log(`\n  数据统计: (数据库未初始化)`);
    }

    // Detected Agents 段：仅显示已安装的 agent
    const detections = detectAllAgents(dbPath);
    const installed = detections.filter((d) => d.installed);
    if (installed.length > 0) {
      console.log(`\n  Detected Agents (${installed.length}):`);
      for (const d of installed) {
        console.log(`    ${d.agent.padEnd(14)} ${d.collectionLevel}级  ${d.sessionCount} sessions`);
      }
    }
    console.log();
  }
  return 0;
}

/** sessions 命令 */
// ─── active 命令 ──────────────────────────────────────────────────────────

/** active 命令：快速查看谁在跑（复用 MCP list_active_sessions 的底层逻辑） */
function cmdActive(flags: Record<string, string | boolean>): number {
  const store = openStore(flags.db as string | undefined);
  const withinMin = typeof flags.within === 'string' ? parseInt(flags.within, 10) : 30;
  const withinMs = withinMin * 60_000;

  const summary = store.getActiveSessionsSummary(withinMs, detectAliveProcesses);
  const awaitingReview = store.getSessionsAwaitingReview(withinMs);
  store.close();
  const reviewIds = new Set(awaitingReview.map((s) => s.sessionId));

  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log();
  console.log(`  活跃 session: ${summary.totalActive} (live ${summary.liveCount})`);
  if (summary.idleCount || summary.staleCount) {
    const parts: string[] = [];
    if (summary.idleCount) parts.push(`idle ${summary.idleCount}`);
    if (summary.staleCount) parts.push(`stale ${summary.staleCount}`);
    if (summary.stoppedCount) parts.push(`stopped ${summary.stoppedCount}`);
    console.log(`  ${parts.join('  ')}`);
  }
  console.log(`  subagent:    ${summary.subagentActive}`);
  if (reviewIds.size > 0) {
    console.log(`  等待审阅:    ${reviewIds.size}`);
  }
  console.log();

  if (summary.sessions && summary.sessions.length > 0) {
    for (const s of summary.sessions) {
      const status =
        s.activityStatus === 'live' ? 'LIVE' :
        s.activityStatus === 'idle' ? 'idle' :
        s.activityStatus === 'stopped' ? 'STOP' : 'stale';
      const cwd = s.cwd ? s.cwd.replace(process.env.HOME ?? '', '~') : '-';
      const agoSec = Math.round((Date.now() - s.fileModifiedAt) / 1000);
      const review = reviewIds.has(s.sessionId) ? ' [REVIEW]' : '';
      console.log(`  [${status.padEnd(5)}] ${s.source.padEnd(8)} ${String(agoSec).padStart(5)}s ago  msgs=${s.messageCount}${review}  ${cwd}`);
    }
  } else {
    console.log('  (最近没有活跃 session)');
  }
  console.log();
  return 0;
}

function cmdWaiting(flags: Record<string, string | boolean>): number {
  const store = openStore(flags.db as string | undefined);
  const withinMin = typeof flags.within === 'string' ? parseInt(flags.within, 10) : 30;
  const withinMs = withinMin * 60_000;

  const sessions = store.getSessionsAwaitingReview(withinMs);
  store.close();

  if (flags.json) {
    console.log(JSON.stringify({ count: sessions.length, sessions }, null, 2));
    return 0;
  }

  if (sessions.length === 0) {
    console.log('\n  没有等待审阅的 session\n');
    return 0;
  }

  console.log(`\n  等待审阅: ${sessions.length} 个 session\n`);
  for (const s of sessions) {
    const agoSec = Math.round((Date.now() - s.fileModifiedAt) / 1000);
    const cwd = s.cwd ? s.cwd.replace(process.env.HOME ?? '', '~') : '-';
    const preview = s.lastMessagePreview.replace(/\n/g, ' ').slice(0, 80);
    console.log(`  ${s.source.padEnd(12)} ${String(agoSec).padStart(5)}s ago  ${cwd}`);
    console.log(`    "${preview}..."`);
    console.log();
  }
  return 0;
}

function cmdSessions(flags: Record<string, string | boolean>): number {
  const store = openStore(flags.db as string | undefined);

 const query = {
   limit: parseLimit(flags),
   source: flags.source as string | undefined,
   topology: flags.topology as 'root' | 'subagent' | 'sidechain' | undefined,
   cwd: flags.cwd as string | undefined,
   cwdPrefix: flags['cwd-prefix'] as string | undefined,
   projectPath: flags.project as string | undefined,
   projectPrefix: (flags['project-prefix'] as string | undefined),
   startedAtFrom: parseTime(flags.from),
   startedAtTo: parseTime(flags.to),
   includeArchived: flags['include-archived'] === true,
 };

  const sessions = store.querySessions(query);
const stats = store.getSessionStats(query);
const activeSummary = store.getActiveSessionsSummary(30 * 60_000, detectAliveProcesses);
store.close();

  if (flags.json) {
    console.log(JSON.stringify({ summary: activeSummary, sessions, stats }, null, 2));
  } else {
    printRuntimeSummary(activeSummary, stats);
    console.log(`\n共 ${sessions.length} 条 session（总计 ${stats.totalSessions}）\n`);
    for (const s of sessions) {
      const time = s.startedAt ? new Date(s.startedAt).toISOString().slice(0, 19) : '???';
      const cwd = s.cwd ? s.cwd.replace(process.env.HOME ?? '', '~') : '-';
      console.log(`  ${time}  ${s.source.padEnd(8)}  ${s.topology.padEnd(9)}  ${String(s.messageCount).padStart(4)} msg  ${cwd}`);
    }
    console.log();
  }
  return 0;
}

/** 打印运行时摘要：总 session 数 + 最近 30 分钟活跃 session 列表（最多 10 条） */
function printRuntimeSummary(
  summary: ActiveSummary,
  stats: SessionStats,
): void {
  const home = process.env.HOME ?? '';
  console.log('\n本机运行时状态：');
  console.log(`  总 session: ${stats.totalSessions} (root ${stats.rootSessions} / subagent ${stats.subagentSessions})`);
  console.log(`  最近 30 分钟活跃: ${summary.totalActive} 个 (其中 subagent ${summary.subagentActive} 个)`);
  const shown = summary.sessions.slice(0, 10);
  for (const s of shown) {
    const shortId = shortIdOf(s.sessionId);
    const cwd = s.cwd ? s.cwd.replace(home, '~') : '-';
    const time = formatHHMM(s.lastSeenAt);
    const source = s.source.padEnd(12);
    console.log(`    - ${shortId}  ${source}  ${cwd}  ${time} 最近活动`);
  }
  console.log();
}

/** 短 id：前 12 字符 + ...（不足则原样） */
function shortIdOf(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + '...' : id;
}

/** 格式化为本地时区 HH:MM */
function formatHHMM(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** daemon 命令 */
async function cmdDaemon(flags: Record<string, string | boolean>): Promise<number> {
  const config: Partial<DaemonConfig> = {};
  if (flags.db) config.dbPath = flags.db as string;
  if (flags['data-dir']) config.dataDir = flags['data-dir'] as string;
  if (flags['pid-file']) config.pidFile = flags['pid-file'] as string;

  const daemon = new YondermeshDaemon(config);

  // 优雅退出
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[yondermesh] 收到 ${signal}，正在停止...`);
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await daemon.start();
    const status = daemon.getStatus();
    console.log(`[yondermesh] daemon 已启动 (PID ${status.pid})`);
    console.log(`[yondermesh] DB: ${status.dbPath}`);

    // 输出首次扫描结果
    if (status.lastScan) {
      for (const r of status.lastScan.results) {
        if (r.skipped) {
          console.log(`[yondermesh] ${r.source}: 跳过${r.error ? ` (${r.error})` : ''}`);
        } else {
          console.log(`[yondermesh] ${r.source}: 扫描 ${r.scanned}, 新增 ${r.inserted}, 更新 ${r.updated}`);
        }
      }
    }

    console.log(`[yondermesh] 实时监听已启动，等待 session 变化...`);

    // 保持进程运行
    return new Promise<number>(() => {
      // daemon 命令不返回，直到收到信号
    });
  } catch (err) {
    console.error(`[yondermesh] daemon 启动失败: ${String(err)}`);
    return 1;
  }
}

// ─── install / service 命令 ─────────────────────────────────────────────

/** install 命令：本地构建 release 并安装 */
function cmdInstall(flags: Record<string, string | boolean>): number {
  const force = flags.force === true;
  const sourceRoot = resolveProjectRoot();
  console.log('[yondermesh] 开始本地构建...');
  console.log(`[yondermesh] 源码目录: ${sourceRoot}`);

  try {
    const release = buildRelease(sourceRoot, force);
    console.log(`[yondermesh] 构建 release ${release.version} → ${release.releasePath}`);

    installRelease(release);
    console.log(`[yondermesh] 已安装: ${ENTRY_SYMLINK()} → ${release.entryPath}`);
    console.log('[yondermesh] 提示：将以下路径加入 PATH 以全局使用：');
    console.log('  export PATH="$HOME/.yondermesh/bin:$PATH"');

   // 链接 skill 到已安装的 CLI
   const skillResult = linkSkills();
   // mountAll 已经包含 skill linking，这里 linkSkills 作为向后兼容保留
   console.log('[yondermesh] 挂载扩展到所有已安装 CLI...');
   const mountResults = mountAll();
   // unsupported 不算入分母——只统计实际尝试的挂载
   const mountAttempted = mountResults.filter((r) => r.strategy !== 'unsupported');
   const mountOk = mountAttempted.filter((r) => r.success).length;
   console.log(`[yondermesh] ${mountOk}/${mountAttempted.length} 个挂载成功`);
   void skillResult;
   if (skillResult.linked.length > 0) {
      console.log(`[yondermesh] 已链接 skill: ${skillResult.linked.join(', ')}`);
    }
    if (skillResult.skipped.length > 0) {
      console.log(`[yondermesh] skill 跳过: ${skillResult.skipped.join('; ')}`);
    }
    return 0;
  } catch (err) {
    console.error(`[yondermesh] 安装失败: ${String(err)}`);
    console.error('[yondermesh] 提示：如果从 release 跑 install 失败，请用 `npm run dev -- install --force` 从源码跑，或者 `ymesh update --local`');
    return 1;
  }
}

/** service 命令：管理 LaunchAgent */
function cmdService(flags: Record<string, string | boolean>): number {
  // 解析 service 子命令：service start / service stop / ...
  const positional = process.argv.slice(process.argv.indexOf('service') + 1);
  const svcAction = positional[0] ?? '';

  switch (svcAction) {
    case 'install': {
      try {
        installService();
        console.log(`[yondermesh] LaunchAgent 已安装: ${LAUNCH_AGENT_PLIST()}`);
        // 尝试安装菜单栏 app（仅 macOS）
        if (process.platform === 'darwin') {
          try {
            const sourceRoot = resolveProjectRoot();
            const swiftSource = join(sourceRoot, 'src', 'menubar', 'YondermeshMenuBar.swift');
            if (existsSync(swiftSource)) {
              installMenuBarApp(swiftSource);
              console.log('[yondermesh] 菜单栏 app 已安装');
            } else {
              console.log('[yondermesh] 未找到 Swift 源码，跳过菜单栏 app');
            }
          } catch (err) {
            console.log(`[yondermesh] 菜单栏 app 安装跳过: ${String(err)}`);
          }
        }
        return 0;
      } catch (err) {
        console.error(`[yondermesh] 安装失败: ${String(err)}`);
        return 1;
      }
    }
    case 'uninstall': {
      try {
        uninstallService();
        if (process.platform === 'darwin') {
          try { uninstallMenuBarApp(); } catch { /* noop */ }
        }
        console.log('[yondermesh] LaunchAgent 已卸载');
        const removed = unlinkSkills();
        if (removed.removed.length > 0) {
          console.log(`[yondermesh] 已移除 skill 链接: ${removed.removed.join(', ')}`);
        }
        return 0;
      } catch (err) {
        console.error(`[yondermesh] 卸载失败: ${String(err)}`);
        return 1;
      }
    }
    case 'start': {
      try {
        startService();
        console.log('[yondermesh] daemon service 已启动');
        if (process.platform === 'darwin') {
          try { startMenuBarApp(); } catch { /* noop */ }
        }
        return 0;
      } catch (err) {
        console.error(`[yondermesh] 启动失败: ${String(err)}`);
        return 1;
      }
    }
    case 'stop': {
      try {
        stopService();
        if (process.platform === 'darwin') {
          try { stopMenuBarApp(); } catch { /* noop */ }
        }
        console.log('[yondermesh] daemon service 已停止');
        return 0;
      } catch (err) {
        console.error(`[yondermesh] 停止失败: ${String(err)}`);
        return 1;
      }
    }
    case 'status': {
      const status = getServiceStatus();
      if (flags.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(`\n  LaunchAgent: ${status.loaded ? '已加载' : '未加载'}`);
        console.log(`  运行状态:    ${status.running ? `运行中 (PID ${status.pid})` : '未运行'}`);
        if (status.exitStatus !== null) {
          console.log(`  上次退出码:  ${status.exitStatus}`);
        }
        console.log();
      }
      return 0;
    }
    default:
      console.error('用法: ymesh service install|uninstall|start|stop|status');
      return 1;
  }
}

/** releases 命令：列出已安装的版本 */
function cmdReleases(flags: Record<string, string | boolean>): number {
  const releases = listReleases();
  const current = getCurrentRelease();

  if (flags.json) {
    console.log(JSON.stringify({ current, releases }, null, 2));
  } else {
    console.log('\n已安装的 release 版本：\n');
    for (const ver of releases) {
      const marker = ver === current ? ' ← current' : '';
      console.log(`  ${ver}${marker}`);
    }
    console.log();
  }
  return 0;
}

// --- mount command ---

/** mount: manage non-invasive extensions across all installed CLIs */
function cmdMount(flags: Record<string, string | boolean>): number {
  const subcommand = typeof flags._sub === "string" ? flags._sub : (process.argv[3] ?? "status");

  if (subcommand === "all" || subcommand === "add") {
    console.log("[yondermesh] Mounting extensions to all installed CLIs...");
    const results = mountAll();
    // unsupported 不算入分母，也不显示——只统计实际尝试的挂载
    const attempted = results.filter((r) => r.strategy !== "unsupported");
    for (const r of attempted) {
      const icon = r.success ? "  OK" : "  --";
      console.log("  " + icon + "  " + r.target + ": " + r.extension + " (" + r.strategy + ") " + r.message);
    }
    const ok = attempted.filter((r) => r.success).length;
    console.log("[yondermesh] " + ok + "/" + attempted.length + " mounts succeeded");
    return attempted.every((r) => r.success) ? 0 : 1;
  }

  if (subcommand === "remove" || subcommand === "unmount") {
    console.log("[yondermesh] Removing all mounts...");
    const results = unmountAll();
    for (const r of results) {
      if (r.strategy === "unsupported") continue; // 跳过不支持的扩展
      console.log("  " + r.target + ": " + r.extension + " " + r.message);
    }
    return 0;
  }

  // default: status
  console.log("[yondermesh] Mount status:");
  const clis = detectInstalledClis(homedir());
  console.log("  Installed CLIs: " + clis.map((c) => c.id).join(", ") + " (" + clis.length + " total)");
  const statuses = verifyAll();
  // 过滤掉 unsupported——CLI 不支持的扩展不应在 status 里误报
  const visibleStatuses = statuses.filter((s) => s.strategy !== "unsupported");
  for (const s of visibleStatuses) {
    const icon = s.mounted ? "  MOUNTED" : "  --";
    console.log("  " + icon + "  " + s.cli + ": " + s.extension + " [" + s.strategy + "]");
  }

  if (flags.json === true) {
    console.log(JSON.stringify({ clis: clis.map((c) => c.id), mounts: visibleStatuses }, null, 2));
  }
  return 0;
}

// --- extract command (LOOP-013) ---

/** extract 命令：提取项目需求/响应，或查询已提取的 NDJSONL 文件 */
function cmdExtract(flags: Record<string, string | boolean>): number {
  // --list：列出所有已提取过的项目
  if (flags.list === true) {
    const items = listExtracts();
    if (flags.json) {
      console.log(JSON.stringify({ projects: items }, null, 2));
    } else {
      console.log(`\n已提取项目（${items.length}）:\n`);
      for (const it of items) {
        const time = new Date(it.extractedAt).toISOString().slice(0, 19);
        console.log(`  ${it.projectHash}  ${time}  ${String(it.sessionCount).padStart(4)} sess  ${String(it.requirementCount).padStart(5)} req  ${String(it.responseCount).padStart(5)} resp  ${it.projectPath}`);
      }
      console.log();
    }
    return 0;
  }

  const wantsReqs = flags.requirements === true;
  const wantsResps = flags.responses === true;

  // 查询模式：--requirements 或 --responses
  if (wantsReqs || wantsResps) {
    const kind: ExtractKind = wantsReqs ? 'requirements' : 'responses';
    let projectHash = flags['project-hash'] as string | undefined;
    if (!projectHash) {
      const p = (flags['cwd-prefix'] as string | undefined) ?? process.cwd();
      projectHash = projectHashOf(p);
    }
    const idNum = flags.id !== undefined && flags.id !== true ? Number(flags.id) : undefined;
    const entries = queryExtracts(projectHash, kind, {
      id: idNum !== undefined && !isNaN(idNum) ? idNum : undefined,
      keyword: flags.keyword !== undefined && flags.keyword !== true ? (flags.keyword as string) : undefined,
      sessionId: flags.session !== undefined && flags.session !== true ? (flags.session as string) : undefined,
      limit: parseLimit(flags),
      offset: flags.offset !== undefined && flags.offset !== true ? Number(flags.offset) : undefined,
    });
    if (flags.json) {
      console.log(JSON.stringify({ kind, projectHash, count: entries.length, entries }, null, 2));
    } else {
      console.log(`\n${kind} (${projectHash}): ${entries.length} 条\n`);
      for (const e of entries) {
        const time = e.timestamp ? new Date(e.timestamp).toISOString().slice(0, 19) : '???';
        const preview = e.content.replace(/\n/g, ' ').slice(0, 120);
        console.log(`  [${e.id}] ${time} ${e.source.padEnd(8)} ${(e.sessionNativeId || '').slice(0, 12)}`);
        console.log(`      ${preview}`);
      }
      console.log();
    }
    return 0;
  }

  // 默认：提取模式
  const cwdPrefix = (flags['cwd-prefix'] as string | undefined) ?? process.cwd();
  try {
    const result = extractProject({
      cwdPrefix,
      projectPath: flags.project as string | undefined,
      startedAtFrom: parseTime(flags.from),
      startedAtTo: parseTime(flags.to),
      dbPath: flags.db as string | undefined,
    });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n提取完成 (${result.projectHash})`);
      console.log(`  项目:     ${result.projectPath}`);
      console.log(`  session:  ${result.sessionCount}`);
      console.log(`  需求:     ${result.requirementCount} → ${result.requirementsFile}`);
      console.log(`  响应:     ${result.responseCount} → ${result.responsesFile}`);
      console.log(`  索引:     ${result.indexFile}`);
      console.log(`  查询示例: ymesh extract --requirements --id 1\n`);
    }
    return 0;
  } catch (err) {
    console.error(`[yondermesh] 提取失败: ${String(err)}`);
    return 1;
  }
}

// --- handoff command (LOOP-014) ---

/** handoff 命令：提取 session 的浓缩 handoff 包，用于任务接管 */
function cmdHandoff(flags: Record<string, string | boolean>): number {
  // 从 process.argv 取 handoff 后的位置参数（session_id），与 cmdService/cmdMcp 模式一致
  const handoffIdx = process.argv.indexOf('handoff');
  const sessionId = handoffIdx >= 0 ? (process.argv[handoffIdx + 1] ?? '') : '';
  if (!sessionId || sessionId.startsWith('--')) {
    console.error('用法: ymesh handoff <session_id> [--json] [--tail <n>]');
    return 1;
  }

  const tailNum = (() => {
    const v = flags.tail;
    if (v === undefined || typeof v === 'boolean') return 30;
    const n = parseInt(v, 10);
    return isNaN(n) ? 30 : n;
  })();

  const claudePath = join(homedir(), '.claude', 'projects');
  const codexPath = join(homedir(), '.codex', 'sessions');
  const pkg = buildSessionHandoff(sessionId, claudePath, codexPath, { tailMessages: tailNum });
  if (!pkg) {
    console.error(`[yondermesh] 找不到 session ${sessionId} 的源文件`);
    return 1;
  }

  if (flags.json) {
    console.log(JSON.stringify(pkg, null, 2));
    return 0;
  }

  printHandoffHuman(pkg);
  return 0;
}

/** 人类可读格式打印 handoff 包 */
function printHandoffHuman(pkg: HandoffPackage): void {
  const meta = pkg.session_meta;
  console.log(`\n=== Session Handoff: ${pkg.session_id ?? '(unknown)'} ===`);
  console.log(`  来源:     ${pkg.source}`);
  console.log(`  Live:     ${pkg.is_live ? '是' : '否'}  最近活动: ${pkg.last_activity_sec_ago >= 0 ? pkg.last_activity_sec_ago + 's 前' : '?'}`);
  console.log(`  消息数:   ${pkg.message_count}`);
  if (meta.cwd) console.log(`  CWD:      ${meta.cwd}`);
  if (meta.topology) console.log(`  拓扑:     ${meta.topology}`);
  if (meta.model) console.log(`  Model:    ${meta.model}`);
  if (meta.cliVersion) console.log(`  CLI:      ${meta.cliVersion}`);
  if (meta.originator) console.log(`  Origin:   ${meta.originator}`);
  console.log(`  文件:     ${pkg.file_path}`);

  // compacted 摘要
  if (pkg.compacted_summaries.length > 0) {
    console.log(`\n--- Compacted 摘要 (${pkg.compacted_summaries.length}) ---`);
    for (const c of pkg.compacted_summaries) {
      console.log(`\n[window ${c.window_number}]`);
      console.log(c.message);
    }
  }

  // 最后 user 消息
  if (pkg.last_user_message) {
    console.log('\n--- 最后一条真实 user 消息 ---');
    console.log(pkg.last_user_message);
  }

  // 尾部近况
  if (pkg.recent_messages.length > 0) {
    console.log(`\n--- 尾部近况 (${pkg.recent_messages.length}) ---`);
    for (const m of pkg.recent_messages) {
      const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '';
      if (m.role === 'function_call') {
        console.log(`  [${m.seq}] ${ts} ${m.role}: ${m.name ?? '?'}`);
        if (m.arguments) console.log(`        args: ${m.arguments}`);
      } else if (m.role === 'function_call_output') {
        console.log(`  [${m.seq}] ${ts} ${m.role}:`);
        if (m.output) console.log(`        out:  ${m.output}`);
      } else if (m.role === 'custom_tool_call' || m.role === 'custom_tool_call_output') {
        console.log(`  [${m.seq}] ${ts} ${m.role}: ${m.name ?? '?'}`);
        if (m.arguments) console.log(`        args: ${m.arguments}`);
        if (m.output) console.log(`        out:  ${m.output}`);
      } else {
        const preview = m.content.replace(/\n/g, '\n        ');
        console.log(`  [${m.seq}] ${ts} ${m.role}: ${preview}`);
      }
    }
  }

  // task plan
  if (pkg.task_plan) {
    console.log('\n--- Task Plan ---');
    console.log(pkg.task_plan);
  }

  console.log('');
}

// --- doctor command ---

/** doctor: run system diagnostics */
function cmdDoctor(flags: Record<string, string | boolean>): number {
  const dataDir = process.env.YONDERMESH_HOME ?? join(homedir(), '.yondermesh');
  const scriptDir = dirname(new URL(import.meta.url).pathname);

  const candidates = [
    join(scriptDir, '..', '..', 'skills', 'yondermesh-diagnose', 'scripts', 'diagnose.sh'),
    join(dataDir, 'skills', 'yondermesh-diagnose', 'scripts', 'diagnose.sh'),
  ];

  let scriptPath = "";
  for (const c of candidates) {
    try { if (existsSync(c)) { scriptPath = c; break; } } catch { /* */ }
  }

  if (!scriptPath) {
    console.error("[yondermesh] diagnostic script not found.");
    for (const c of candidates) console.error("  expected: " + c);
    return 1;
  }

  const section = typeof flags.section === "string" ? flags.section : "all";
  const args = ["bash", scriptPath, "--section", section];
  if (flags.verbose === true) args.push("--verbose");

  try {
    execSync(args.join(" "), { encoding: "utf-8", stdio: "inherit", env: { ...process.env } });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

// ─── mcp 命令（LOOP-011）────────────────────────────────────────────────────────────────

/** mcp 命令：启动 server 或管理注册 */
async function cmdMcp(flags: Record<string, string | boolean>): Promise<number> {
  // 子命令：register / unregister / status
  const positional = process.argv.slice(process.argv.indexOf('mcp') + 1);
  const sub = positional[0] ?? '';

  if (sub === 'register') {
    const args = buildYmeshArgs();
    const result = registerAll(args);
    const targets: string[] = [];
    if (result.claude) targets.push('Claude Code');
    if (result.codex) targets.push('Codex');
    if (targets.length > 0) {
      console.log(`[yondermesh] MCP server 已注册到: ${targets.join(', ')}`);
      console.log('[yondermesh] 新 session 将自动加载。正在运行的 session 需要重启或使用 /mcp 重连。');
      return 0;
    }
    if (result.errors.length > 0) {
      console.error(`[yondermesh] 注册失败: ${result.errors.join('; ')}`);
    } else {
      console.log('[yondermesh] 未发现 Claude Code 或 Codex 配置，无需注册。');
    }
    return 1;
  }

  if (sub === 'unregister') {
    const result = unregisterAll();
    const targets: string[] = [];
    if (result.claude) targets.push('Claude Code');
    if (result.codex) targets.push('Codex');
    if (targets.length > 0) {
      console.log(`[yondermesh] 已从 ${targets.join(', ')} 注销`);
    } else {
      console.log('[yondermesh] 没有找到注册记录');
    }
    return 0;
  }

  if (sub === 'status') {
    const status = checkRegistration();
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`\n  Claude Code:  ${status.claude.registered ? '已注册' : '未注册'}  (${status.claude.path ?? '-'})`);
      console.log(`  Codex:        ${status.codex.registered ? '已注册' : '未注册'}  (${status.codex.path ?? '-'})\n`);
    }
    return 0;
  }

  // mcp tools：列出 yondermesh 暴露给其他 agent 的 MCP 工具（含新版 yondermesh_* 工具）
  if (sub === 'tools') {
    // 新版工具集（含 handler，来自 src/mcp/tools.ts）
    const newTools = listToolSchemas();
    // 旧版工具集（仅 schema，来自 McpServer 实例方法 listTools）
    const config = defaultDaemonConfig();
    const store = new SessionStore(config.dbPath);
    const mcp = new McpServer(store);
    const legacyTools = mcp.listTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    store.close();

    if (flags.json) {
      console.log(JSON.stringify({
        new_tools: newTools,
        legacy_tools: legacyTools,
        new_count: newTools.length,
        legacy_count: legacyTools.length,
        total: newTools.length + legacyTools.length,
      }, null, 2));
    } else {
      console.log(`\nyondermesh MCP 工具（共 ${newTools.length + legacyTools.length} 个）\n`);
      console.log(`  新版 yondermesh_* 工具（${newTools.length}）:`);
      for (const t of newTools) {
        console.log(`    - ${t.name}`);
        console.log(`        ${t.description.split('\n')[0]}`);
      }
      console.log(`\n  旧版查询工具（${legacyTools.length}）:`);
      for (const t of legacyTools) {
        console.log(`    - ${t.name}`);
        console.log(`        ${t.description.split('\n')[0]}`);
      }
      console.log(`\n  注：MCP_TOOLS 数组共 ${MCP_TOOLS.length} 个工具（含 handler）\n`);
    }
    return 0;
  }

  // mcp call <tool> <json_args>：终端直接调用 MCP 工具
  if (sub === 'call') {
    const toolName = positional[1];
    if (!toolName) {
      console.error('用法: ymesh mcp call <tool> [json_args]');
      console.error('示例: ymesh mcp call who_is_working');
      console.error('      ymesh mcp call search_sessions \'{"limit":5}\'');
      return 1;
    }
    const argsJson = positional[2] ?? '{}';
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(argsJson);
    } catch {
      console.error(`参数 JSON 解析失败: ${argsJson}`);
      return 1;
    }
    const config = defaultDaemonConfig();
    const store = new SessionStore(config.dbPath);
    const mcp = new McpServer(store);
    const result = await mcp.callTool(toolName, parsedArgs);
    store.close();
    // callTool 返回 content 是 JSON 字符串，直接输出
    try {
      const data = JSON.parse(result.content);
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.log(result.content);
    }
    return result.isError ? 1 : 0;
  }

  // 默认：启动 MCP server（stdio JSON-RPC）
  const config = defaultDaemonConfig();
  const dbPath = config.dbPath;
  const store = new SessionStore(dbPath);
  const mcp = new McpServer(store);
  await mcp.start();
  return new Promise((resolve) => {
   process.stdin.on("end", () => resolve(0));
  });
}

// ─── update 命令（LOOP-009） ───────────────────────────────────────────

/** update 命令：从 Git 源码或本地源码更新并自动回退 */
async function cmdUpdate(flags: Record<string, string | boolean>): Promise<number> {
  const useLocal = flags.local === true;

  // --local 模式：跳过 git clone，直接用本地源码打包
  if (useLocal) {
    const sourceRoot = resolveProjectRoot();
    const previousVersion = getCurrentRelease();

    console.log(`[yondermesh] 正在从本地源码更新...`);
    console.log(`  源码目录: ${sourceRoot}`);

    try {
      const release = buildRelease(sourceRoot, true);
      installRelease(release);

      // 重新链接 skill（current 已切换，symlink 自动指向新版本）
      try {
        linkSkills();
      } catch {
        // skill 链接失败不影响更新成功
      }

      console.log(`[yondermesh] 更新成功: ${previousVersion ?? '(none)'} → ${release.version}`);
      return 0;
    } catch (err) {
      // 失败时尝试自动回退到 previous release
      const rolled = rollbackRelease();
      console.error(`[yondermesh] 更新失败: ${String(err)}`);
      if (rolled) {
        console.error(`[yondermesh] 已自动回退到 ${basename(rolled)}`);
      } else if (previousVersion) {
        console.error(`[yondermesh] 当前版本仍为 ${previousVersion}（未切换）`);
      } else {
        console.error(`[yondermesh] 未能回退（没有 previous release）`);
      }
      return 1;
    }
  }

  // 默认模式：从 Git 拉取后打包
  const repoUrl = (flags.repo as string) ?? 'https://github.com/GoYonderTogether/yondermesh.git';
  const branch = (flags.branch as string) ?? 'main';

  console.log(`[yondermesh] 正在从 Git 更新...`);
  console.log(`  仓库: ${repoUrl}`);
  console.log(`  分支: ${branch}`);

  const result = updateFromGit(repoUrl, branch);

  if (result.success) {
    console.log(`[yondermesh] 更新成功: ${result.previousVersion ?? '(none)'} → ${result.newVersion}`);
    return 0;
  } else {
    if (result.rolledBack) {
      console.error(`[yondermesh] 更新失败，已自动回退到 ${result.previousVersion ?? 'previous'}`);
    } else {
      console.error(`[yondermesh] 更新失败，未能回退`);
    }
    console.error(`[yondermesh] 错误: ${result.error ?? '未知错误'}`);
    console.error('[yondermesh] 请手动检查并解决问题后重试。');
    return 1;
  }
}

// ─── state 命令（文件系统信号通道）─────────────────────────────────────────

/** 解析 data-dir，支持 --data-dir 覆盖（跟 daemon 一致） */
function resolveDataDir(flags: Record<string, string | boolean>): string {
  return typeof flags['data-dir'] === 'string' ? flags['data-dir'] : defaultDataDir();
}

/** state 命令：把运行时状态写到文件系统，或从文件系统读取状态 */
function cmdState(flags: Record<string, string | boolean>): number {
  // 子命令：sync / show（从 process.argv 直接取，与 cmdService/cmdMcp 模式一致）
  const positional = process.argv.slice(process.argv.indexOf('state') + 1);
  const action = positional[0] ?? '';

  const dataDir = resolveDataDir(flags);
  const stateDir = join(dataDir, 'state');
  const defaultStateFile = join(stateDir, 'current.json');

  switch (action) {
    case 'sync':
      return cmdStateSync(flags, dataDir, defaultStateFile);
    case 'show':
      return cmdStateShow(flags, defaultStateFile);
    default:
      console.error('用法: ymesh state sync|show [--output <path>] [--data-dir <dir>] [--json]');
      return 1;
  }
}

/** state sync：写当前状态到文件系统 */
function cmdStateSync(
  flags: Record<string, string | boolean>,
  dataDir: string,
  defaultStateFile: string,
): number {
  const outputFile = typeof flags.output === 'string' ? flags.output : defaultStateFile;
  const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');

  const store = openStore(dbPath);
  const activeSummary = store.getActiveSessionsSummary(30 * 60_000, detectAliveProcesses);
  const stats = store.getSessionStats({});
  const recentSessions = store.querySessions({ limit: 10 });
  store.close();

  const payload = {
    syncedAt: new Date().toISOString(),
    deviceId: hostname(),
    stats,
    activeSummary,
    recentSessions,
  };

  try {
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error(`[yondermesh] 写状态文件失败: ${String(err)}`);
    return 1;
  }

  console.log(`[yondermesh] 状态已同步到 ${outputFile}`);
  return 0;
}

/** state show：从文件系统读取状态 */
function cmdStateShow(flags: Record<string, string | boolean>, stateFile: string): number {
  if (!existsSync(stateFile)) {
    console.log('[yondermesh] 无状态文件，请先运行 ymesh state sync');
    return 1;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch (err) {
    console.error(`[yondermesh] 读取状态文件失败: ${String(err)}`);
    return 1;
  }

  // JSON 模式直接输出原始 JSON
  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  // 文本模式友好显示
  const p = payload as {
    syncedAt?: string;
    deviceId?: string;
    stats?: SessionStats;
    activeSummary?: ActiveSummary;
    recentSessions?: SessionRecord[];
  };
  console.log(`\nyondermesh 状态快照\n`);
  console.log(`  同步时间: ${p.syncedAt ?? '???'}`);
  console.log(`  设备:     ${p.deviceId ?? '???'}`);
  if (p.stats) {
    console.log(`\n  数据统计:`);
    console.log(`    总 session:  ${p.stats.totalSessions}`);
    console.log(`    根 session:  ${p.stats.rootSessions}`);
    console.log(`    子 agent:    ${p.stats.subagentSessions}`);
    console.log(`    总消息:      ${p.stats.totalMessages}`);
  }
  if (p.activeSummary) {
    console.log(`\n  最近 30 分钟活跃: ${p.activeSummary.totalActive} 个 (live ${p.activeSummary.liveCount})`);
  }
  if (p.recentSessions && p.recentSessions.length > 0) {
    console.log(`\n  最近 session (${p.recentSessions.length}):\n`);
    for (const s of p.recentSessions) {
      const time = s.startedAt ? new Date(s.startedAt).toISOString().slice(0, 19) : '???';
      const cwd = s.cwd ? s.cwd.replace(process.env.HOME ?? '', '~') : '-';
      console.log(`    ${time}  ${s.source.padEnd(8)}  ${s.topology.padEnd(9)}  ${String(s.messageCount).padStart(4)} msg  ${cwd}`);
    }
  }
  console.log();
  return 0;
}

// ─── mailbox 命令（SQLite 后端，薄壳交互层）─────────────────────────────
//
// 所有业务逻辑在 src/mailbox/core.ts 的 MailboxCore 里。CLI 只是参数解析
// 与输出格式化。daemon 注册 Notifier 后，postMessage 自动触发推送通道。

/** 用 flags 解析 dataDir + dbPath，打开 MailboxCore */
function openMailbox(flags: Record<string, string | boolean>): MailboxCore {
  const dataDir = resolveDataDir(flags);
  const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');
  return new MailboxCore(dbPath, dataDir);
}

/** 解析 --since-minutes flag 为 ms 截止时间 */
function parseSinceMs(flags: Record<string, string | boolean>, defaultMin = 60): number {
  const v = flags['since-minutes'];
  if (typeof v !== 'string') return Date.now() - defaultMin * 60_000;
  const n = parseInt(v, 10);
  return isNaN(n) ? Date.now() - defaultMin * 60_000 : Date.now() - n * 60_000;
}

/** 把 ISO 时间戳格式化为本地时区 'YYYY-MM-DD HH:MM' */
function fmtLocalTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** mailbox 命令：跨 session 消息总线入口 */
function cmdMailbox(flags: Record<string, string | boolean>): number {
  const positional = process.argv.slice(process.argv.indexOf('mailbox') + 1);
  const action = positional[0] ?? '';

  switch (action) {
    case 'post':
      return cmdMailboxPost(flags);
    case 'get':
    case 'peek':
      return cmdMailboxPeek(flags, /* pop */ false);
    case 'pop':
      return cmdMailboxPeek(flags, /* pop */ true);
    case 'list':
      return cmdMailboxList(flags);
    case 'mark-read':
      return cmdMailboxMarkRead(flags);
    case 'check':
      return cmdMailboxCheck(flags);
    case 'whoami':
      return cmdMailboxWhoami(flags);
    case 'unread':
      return cmdMailboxUnread(flags);
    default:
      console.error('用法: ymesh mailbox post|get|pop|list|mark-read|check|whoami|unread [--json]');
      return 1;
  }
}

/** mailbox post：投递消息 */
function cmdMailboxPost(flags: Record<string, string | boolean>): number {
  const to = typeof flags.to === 'string' ? flags.to : '';
  const toProject = typeof flags['to-project'] === 'string' ? flags['to-project'] : '';
  const body = typeof flags.body === 'string' ? flags.body : '';
  if ((!to && !toProject) || !body) {
    console.error('用法: ymesh mailbox post --to <sid> | --to-project <path> --body <内容>');
    console.error('      [--from <sid>] [--kind info|warning|question|task_update]');
    console.error('      [--priority low|normal|high|urgent] [--expires-min N]');
    console.error('      [--thread <id>] [--reply-to <msg_id>] [--json]');
    return 1;
  }

  const from = typeof flags.from === 'string' ? flags.from : undefined;
  const rawKind = typeof flags.kind === 'string' ? flags.kind : 'info';
  if (!MAIL_KINDS.includes(rawKind as MailKind)) {
    console.error(`[yondermesh] 无效 kind: ${rawKind}（可选: ${MAIL_KINDS.join(', ')}）`);
    return 1;
  }
  const rawPriority = typeof flags.priority === 'string' ? flags.priority : 'normal';
  if (!MAIL_PRIORITIES.includes(rawPriority as MailPriority)) {
    console.error(`[yondermesh] 无效 priority: ${rawPriority}（可选: ${MAIL_PRIORITIES.join(', ')}）`);
    return 1;
  }

  const expiresMin = typeof flags['expires-min'] === 'string' ? parseInt(flags['expires-min'], 10) : NaN;
  const expiresAt = !isNaN(expiresMin) && expiresMin > 0 ? Date.now() + expiresMin * 60_000 : undefined;
  const replyTo = typeof flags['reply-to'] === 'string' ? parseInt(flags['reply-to'], 10) : undefined;

  const input: PostMessageInput = {
    toSessionId: to || undefined,
    toProject: toProject || undefined,
    fromSessionId: from,
    body,
    kind: rawKind as MailKind,
    priority: rawPriority as MailPriority,
    expiresAt,
    threadId: typeof flags.thread === 'string' ? flags.thread : undefined,
    replyToId: !isNaN(replyTo as number) ? replyTo : undefined,
  };

  const mailbox = openMailbox(flags);
  try {
    const id = mailbox.postMessage(input);
    if (flags.json) {
      console.log(JSON.stringify({ messageId: id, posted: true }, null, 2));
    } else {
      const target = to || `project:${toProject}`;
      console.log(`[yondermesh] 消息已投递到 ${target} (id: ${id})`);
    }
    return 0;
  } catch (err) {
    console.error(`[yondermesh] 投递失败: ${String(err)}`);
    return 1;
  } finally {
    mailbox.close();
  }
}

/** mailbox get / peek / pop：读取消息 */
function cmdMailboxPeek(flags: Record<string, string | boolean>, pop: boolean): number {
  const forSession = typeof flags.for === 'string' ? flags.for : '';
  const forProject = typeof flags['for-project'] === 'string' ? flags['for-project'] : '';
  if (!forSession && !forProject) {
    console.error('用法: ymesh mailbox get|pop --for <sid> | --for-project <path>');
    console.error('      [--unread-only] [--since-minutes 60] [--limit 50] [--json]');
    return 1;
  }

  const filter: MessageFilter = {
    forSessionId: forSession || undefined,
    forProject: forProject || undefined,
    sinceMs: parseSinceMs(flags),
    unreadOnly: flags['unread-only'] === true,
    limit: typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : undefined,
  };

  const mailbox = openMailbox(flags);
  try {
    const messages = pop ? mailbox.popMessages(filter) : mailbox.peekMessages(filter);
    if (flags.json) {
      console.log(JSON.stringify({ messages, count: messages.length }, null, 2));
      return 0;
    }
    if (messages.length === 0) {
      const target = forSession || `project:${forProject}`;
      console.log(`[yondermesh] 邮箱 ${target} 无消息（匹配当前过滤条件）`);
      return 0;
    }
    const target = forSession || `project:${forProject}`;
    console.log(`\n邮箱 ${target}（${messages.length} 条消息）\n`);
    for (const m of messages) {
      const time = fmtLocalTime(m.createdAt);
      const from = m.fromSessionId ? shortIdOf(m.fromSessionId) : '(unknown)';
      const read = m.readAt ? '[已读]' : '[未读]';
      const pri = m.priority !== 'normal' ? `[${m.priority}] ` : '';
      console.log(`  ${time}  ${m.kind.padEnd(12)}  ${read}  ${pri}from: ${from}`);
      console.log(`    ${m.body.replace(/\n/g, '\n    ')}`);
    }
    console.log();
    return 0;
  } finally {
    mailbox.close();
  }
}

/** mailbox list：列出所有有消息的 session 邮箱 */
function cmdMailboxList(flags: Record<string, string | boolean>): number {
  const mailbox = openMailbox(flags);
  try {
    const mailboxes = mailbox.listMailboxes();
    if (flags.json) {
      console.log(JSON.stringify({ mailboxes, count: mailboxes.length }, null, 2));
      return 0;
    }
    if (mailboxes.length === 0) {
      console.log('[yondermesh] 无邮箱记录');
      return 0;
    }
    console.log(`\n邮箱列表（${mailboxes.length}）:\n`);
    console.log(`  ${'session_id'.padEnd(40)}  ${'total'.padStart(5)}  ${'unread'.padStart(6)}  last`);
    for (const mb of mailboxes) {
      const time = fmtLocalTime(mb.lastPostedAt);
      console.log(`  ${mb.sessionId.padEnd(40)}  ${String(mb.messageCount).padStart(5)}  ${String(mb.unreadCount).padStart(6)}  ${time}`);
    }
    console.log();
    return 0;
  } finally {
    mailbox.close();
  }
}

/** mailbox mark-read：标记已读 */
function cmdMailboxMarkRead(flags: Record<string, string | boolean>): number {
  const id = typeof flags.id === 'string' ? parseInt(flags.id, 10) : undefined;
  const forSession = typeof flags.for === 'string' ? flags.for : undefined;
  const forProject = typeof flags['for-project'] === 'string' ? flags['for-project'] : undefined;

  if (isNaN(id as number) && !forSession && !forProject) {
    console.error('用法: ymesh mailbox mark-read --id <msg_id> | --for <sid> | --for-project <path>');
    return 1;
  }

  const mailbox = openMailbox(flags);
  try {
    const count = mailbox.markRead({
      id: !isNaN(id as number) ? id : undefined,
      allForSession: forSession,
      allForProject: forProject,
    });
    if (flags.json) {
      console.log(JSON.stringify({ markedRead: count }, null, 2));
    } else {
      console.log(`[yondermesh] 标记 ${count} 条消息为已读`);
    }
    return 0;
  } finally {
    mailbox.close();
  }
}

/** mailbox check：消费 daemon tray 通知 + 返回未读消息 */
function cmdMailboxCheck(flags: Record<string, string | boolean>): number {
  const explicitSid = typeof flags.for === 'string' ? flags.for : undefined;

  const mailbox = openMailbox(flags);
  try {
    const selfSid = mailbox.resolveSelfSession({ explicit: explicitSid });
    if (!selfSid) {
      console.error('[yondermesh] 无法解析 self session id。请用 --for <sid> 显式指定，或设置 YONDERMESH_SELF_SESSION_ID 环境变量。');
      return 2;
    }

    // 消费 daemon 写的 tray 文件（push 通知），不存在则空数组
    const trayNotices = mailbox.consumeTray(selfSid);
    // 取未读消息（不标记已读，让 agent 决定是否 pop）
    const messages = mailbox.peekMessages({
      forSessionId: selfSid,
      unreadOnly: true,
      limit: 50,
    });
    const unread = mailbox.countUnread(selfSid);

    if (flags.json) {
      console.log(JSON.stringify({
        sessionId: selfSid,
        trayNotices,
        unread,
        messages,
      }, null, 2));
      return 0;
    }

    console.log(`\n  self: ${selfSid}`);
    console.log(`  unread: ${unread.total}（direct ${unread.direct}, broadcast ${unread.broadcast}）`);
    console.log(`  tray notices: ${trayNotices.length}`);
    if (messages.length > 0) {
      console.log(`\n  未读消息:\n`);
      for (const m of messages) {
        const time = fmtLocalTime(m.createdAt);
        const from = m.fromSessionId ? shortIdOf(m.fromSessionId) : '(unknown)';
        const pri = m.priority !== 'normal' ? `[${m.priority}] ` : '';
        console.log(`  ${time}  ${m.kind.padEnd(12)}  ${pri}from: ${from}`);
        console.log(`    ${m.body.replace(/\n/g, '\n    ')}`);
      }
    }
    console.log();
    return 0;
  } finally {
    mailbox.close();
  }
}

/** mailbox whoami：解析当前调用方的 self session id */
function cmdMailboxWhoami(flags: Record<string, string | boolean>): number {
  const explicitSid = typeof flags.for === 'string' ? flags.for : undefined;

  const mailbox = openMailbox(flags);
  try {
    const selfSid = mailbox.resolveSelfSession({ explicit: explicitSid });
    if (flags.json) {
      console.log(JSON.stringify({ sessionId: selfSid ?? null, resolved: !!selfSid }, null, 2));
      return 0;
    }
    if (!selfSid) {
      console.log('[yondermesh] 无法解析 self session id');
      return 2;
    }
    console.log(`[yondermesh] self session id: ${selfSid}`);
    return 0;
  } finally {
    mailbox.close();
  }
}

/** mailbox unread：统计未读消息数 */
function cmdMailboxUnread(flags: Record<string, string | boolean>): number {
  const forSession = typeof flags.for === 'string' ? flags.for : '';
  const forProject = typeof flags['for-project'] === 'string' ? flags['for-project'] : '';
  if (!forSession && !forProject) {
    console.error('用法: ymesh mailbox unread --for <sid> | --for-project <path>');
    return 1;
  }

  const mailbox = openMailbox(flags);
  try {
    const unread = mailbox.countUnread(forSession || undefined, forProject || undefined);
    if (flags.json) {
      console.log(JSON.stringify(unread, null, 2));
    } else {
      const target = forSession || `project:${forProject}`;
      console.log(`[yondermesh] ${target}: ${unread.total} unread (direct ${unread.direct}, broadcast ${unread.broadcast})`);
    }
    return 0;
  } finally {
    mailbox.close();
  }
}

// ─── 主入口 ──────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { command, flags } = parseArgs(argv);

  switch (command) {
    case 'help':
    case undefined:
    case '':
      return cmdHelp();

    case 'version':
    case '--version':
    case '-v':
      return cmdVersion(flags);

    case 'scan':
      return cmdScan(flags);

    case 'status':
      return cmdStatus(flags);

    case 'sessions':
    case 'query':
      return cmdSessions(flags);

    case 'active':
      return cmdActive(flags);
    case 'waiting':
      return cmdWaiting(flags);

    case 'daemon':
      return await cmdDaemon(flags);

    case 'install':
      return cmdInstall(flags);

    case 'service':
      return cmdService(flags);

    case 'releases':
      return cmdReleases(flags);

    case 'update':
      return await cmdUpdate(flags);

    case 'mcp':
      return await cmdMcp(flags);

    case 'doctor':
      return cmdDoctor(flags);

    case 'mount':
      return cmdMount(flags);

    case 'extract':
      return cmdExtract(flags);

    case 'handoff':
      return cmdHandoff(flags);

    case 'state':
      return cmdState(flags);

    case 'mailbox':
      return cmdMailbox(flags);

    case 'agents':
      return cmdAgents(flags);

    case 'launch':
      return await cmdLaunch(flags);

    case 'inject':
      return await cmdInject(flags);

    case 'transfer':
      return await cmdTransfer(flags);

    case 'rollback':
      {
        const rolled = rollbackRelease();
        if (rolled) {
          console.log(`[yondermesh] 已回退到 ${basename(rolled)}`);
          return 0;
        } else {
          console.error('[yondermesh] 没有 previous release 可回退');
          return 1;
        }
      }

    default:
      console.error(`未知命令: ${command}\n`);
      cmdHelp();
      return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
