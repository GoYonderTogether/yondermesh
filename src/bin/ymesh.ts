#!/usr/bin/env node
/**
 * yondermesh CLI 入口（LOOP-007）
 *
 * 极简命令行，不引入外部依赖：
 *   ymesh help / version / scan / status / sessions / daemon
 *
 * 支持 --json 全局标志，输出 JSON 格式。
 */

import '../prelude/quiet-sqlite-warning.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { execSync } from 'node:child_process';

import { SessionStore } from '../store/index.js';
import { detectAliveProcesses } from '../store/process-detector.js';
import type { ActiveSummary, SessionStats, SessionRecord } from '../store/index.js';
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
import { buildSessionHandoff, buildStoreHandoff } from '../mcp/codex-handoff.js';
import type { HandoffPackage } from '../mcp/codex-handoff.js';
import { MCP_TOOLS, listToolSchemas } from '../mcp/tools.js';
import { MailboxCore } from '../mailbox/index.js';
import type {
  MailKind,
  MailPriority,
  MessageFilter,
  PostMessageInput,
  SendMode,
  SendTarget,
} from '../mailbox/index.js';
import { MAIL_KINDS, MAIL_PRIORITIES, formatSelfSessionFailure, agentMessage } from '../mailbox/index.js';
import { observe } from '../mcp/observe.js';
import { orchestrate } from '../mcp/orchestrate.js';
import { workspace as workspaceCmd } from '../mcp/workspace.js';
import { loadWrapper as regLoadWrapper, listImporters } from '../adapters/registry.js';
import { scaffoldAdapter } from '../sdk/scaffold.js';
import { augmentProcessPath } from '../detect/cli-path.js';
import type { ScaffoldOptions } from '../sdk/scaffold.js';

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

/** help 命令（支持 zh/en 双语；en 供英文文档站生成器消费，默认 zh 不改变 CLI 行为） */
function cmdHelp(lang: 'zh' | 'en' = 'zh'): number {
  console.log(lang === 'en' ? helpTextEn() : helpTextZh());
  return 0;
}

/** 中文帮助文本 */
function helpTextZh(): string {
  return `
yondermesh v${VERSION} — 自托管 Agent 上下文总线

用法:
  ymesh <command> [options]

命令:
  help                显示此帮助信息
  version             显示版本号

  ── Agent 接口（4 个职能，MCP 与 CLI 同一套；优先用这 4 个）──────────
  observe             看：会诊本机所有 agent 的会话（scope=me|global|project|session|active|tree）
  message             说：跟其他 agent 会话通信（action=send|check）
  orchestrate         管：spawn 起会话 / assign 派活 / handoff 接力 / await 等结果 / discuss 多模型讨论 / stop 叫停 / prior 查旧账
  workspace           标：给工作目录起名、分组、看某目录下有哪些 agent 在跑

  ── 采集与查看 ───────────────────────────────────────────────────
  scan [--force]      扫描本机全部 session（--force 忽略增量指纹、全量重读）
                      27 个 adapter：cass/claude/codex/hermes/
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
  mcp call <tool> [args]  终端直接调用 MCP 工具（如 ymesh mcp call observe --scope active）
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
  mailbox <action>    [遗留，用 message] 跨 session 消息总线 (post|get|pop|list|mark-read|check|whoami|unread)
  launch              [遗留，用 orchestrate spawn] 启动新 agent session（--cli <agent> --prompt "text" [--model <m>]）
  inject              [遗留] 向运行中 session 注入消息（--cli <agent> --session <id> --message "text"）
  transfer            [遗留，用 orchestrate handoff] 跨 agent 转交 session（--cli <src> --session <id> --target <dst> [--output <path>]）
  send                同步注入 v3：发送消息到目标 agent 并同步拿回复（--cli <agent> [--session <id>] [--mode stopped|running|new] --message "text" [--model <m>] [--effort <e>] [--cwd <path>] [--timeout <ms>] [--json]）
  scaffold <name>     生成新 adapter 模板（importer/wrapper/inject/index）到 src/<name>/
                      选项: --config-dir <dir> --cli-binary <bin>
                            --session-format jsonl|sqlite|json|markdown --yes（覆盖已存在）
  sync fts            显式分批回填 messages_fts 全文索引（大库自动回填被跳过时用）
                      选项: --batch <n>（每批条数，默认 5000）[--json]
  compact             压缩数据库：回收被覆盖的历史 revision 正文 + 重建全文索引 + 归还磁盘
                      选项: --dry-run（只报告）--vacuum（回收磁盘，需独占）
                            --mode current-only|keep（切换历史正文保留策略）--json

  retain analyze      扫描数据库冗余（噪音/超长/老旧 session + session 级分类），报告可压缩量（只读）
  retain apply        执行筛除（L0 删噪音 + L2 截断 + SL0/SL1/SL2 session 级 + L3 归档），含去重备份
                      选项: --dry-run（预演）--no-backup（跳过备份）[--db <path>] [--json]
  reimport            重新扫描指定 source 补结构化 tool_calls（幂等；默认 dry-run）
                      选项: --source <name> [--limit <n>] [--dry-run] [--yes] [--db <path>] [--json]

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
  ymesh scaffold mycli --yes
`;
}

/** 英文帮助文本（结构与中文版镜像，供英文文档站生成器解析） */
function helpTextEn(): string {
  return `
yondermesh v${VERSION} — self-hosted Agent Context Bus

Usage:
  ymesh <command> [options]

Commands:
  help                Show this help
  version             Show version
  scan                Scan all local sessions (27 adapters: cass/claude/codex/hermes/
                      windsurf/continue/opencode/copilot/openclaw/kimi/qwen/gemini/pi/
                      factory/vibe/codebuddy/cline/crush/openhands/goose/antigravity/
                      aider/trae-cli/cursor-ide/trae-ide/amp/chatgpt)
  status              Show daemon status and last scan result
  agents              List detected agents and their support status
  sessions            List sessions (supports filtering)
  daemon              Start background daemon (live watch + periodic reconcile)
                      Options: --db <path> --data-dir <dir> --pid-file <path>
  install             Build a release locally and install it
    service <action>    LaunchAgent + menubar app (install|uninstall|start|stop|status)
  releases            List installed release versions
  update [--local]    Update from Git source (auto-rollback on build failure); --local packs from local source
  rollback            Roll back to the previous release manually
  mcp                 Start MCP server (stdio JSON-RPC, for other agents to mount)
  mcp call <tool> [args]  Call an MCP tool from the terminal (e.g. ymesh mcp call observe --scope active)
  mcp register        Register MCP server into Claude Code and Codex (auto-available in new sessions)
  mcp unregister      Unregister from Claude Code and Codex
  mcp status          Show MCP registration status
  active              Quickly see which sessions are running now (who is working)
  waiting             See sessions waiting for your review (agent has replied)
  doctor              Run system diagnostics (install, database, daemon, log health)
  mount [status|all|remove]  Manage cross-CLI mounts (MCP/Skill/Plugin into every installed CLI agent)
  extract             Extract a project's user requirements and assistant responses to NDJSONL (indexed by line/ID)
  handoff <id>        Extract a compacted handoff package (compacted summaries + tool calls + plan) for task takeover
  state <action>      Manage runtime state file (sync|show)
  observe             See: inspect sessions across all local agents (scope=me|global|project|session|active|tree)
  message             Say: talk to other agent sessions (action=send|check)
  orchestrate         Manage: spawn / assign / handoff / await / discuss / stop (cooperative) / prior
  workspace           Label: name and group working directories; see who is running where
  mailbox <action>    [legacy, use message] Cross-session message bus (post|get|pop|list|mark-read|check|whoami|unread)
  launch              Start a new agent session (--cli <agent> --prompt "text" [--model <m>])
  inject              Inject a message into a running session (--cli <agent> --session <id> --message "text")
  transfer            Transfer a session across agents (--cli <src> --session <id> --target <dst> [--output <path>])
  send                Sync injection v3: send a message to a target agent and get the reply synchronously (--cli <agent> [--session <id>] [--mode stopped|running|new] --message "text" [--model <m>] [--effort <e>] [--cwd <path>] [--timeout <ms>] [--json])
  scaffold <name>     Generate a new adapter template (importer/wrapper/inject/index) into src/<name>/
                      Options: --config-dir <dir> --cli-binary <bin>
                               --session-format jsonl|sqlite|json|markdown --yes (overwrite existing)
  sync fts            Explicitly backfill messages_fts full-text index in batches (use when large-DB auto-backfill is skipped)
                      Options: --batch <n> (batch size, default 5000) [--json]
  compact             Shrink the database: drop superseded revision bodies + rebuild the FTS index + return disk space
                      Options: --dry-run (report only) --vacuum (return disk, needs exclusive access)
                               --mode current-only|keep (revision body policy) [--json]
  retain analyze      Scan database for redundancy (noise/oversized/stale sessions + session-level classification), report compressible volume (read-only)
  retain apply        Execute retention (L0 drop noise + L2 truncate + SL0/SL1/SL2 session-level + L3 archive), with deduplicated backup
                      Options: --dry-run (preview) --no-backup (skip backup) [--db <path>] [--json]
  reimport            Re-scan a source to backfill structured tool_calls (idempotent; dry-run by default)
                      Options: --source <name> [--limit <n>] [--dry-run] [--yes] [--db <path>] [--json]

Install:
  curl -fsSL https://raw.githubusercontent.com/GoYonderTogether/yondermesh/main/install.sh | bash
  or: git clone ... && ./install.sh

Global Options:
  --json              Output as JSON (for script consumption)
  --db <path>         Database path (default ~/.yondermesh/yondermesh.db)

sessions filter options:
  --limit <n>         Limit output count (default 20)
  --source <name>     Filter by source (claude / codex / cass)
  --topology <type>   Filter by topology (root / subagent)
  --cwd <path>        Exact cwd match
  --cwd-prefix <path> cwd prefix match (directory-boundary safe)
  --project <path>    Exact projectPath match
  --from <time>       Start time (epoch ms or ISO date)
  --to <time>         End time (epoch ms or ISO date)
  --include-archived  Include deduplicated sessions (hidden by default)

extract options:
  --cwd-prefix <path>  Project dir prefix (default current cwd)
  --project <path>     Exact projectPath match (alternative to --cwd-prefix)
  --from / --to        Filter by session start-time range
  --requirements       Query requirements file (user messages)
  --responses          Query responses file (assistant messages)
  --id <n>             Take one entry by line/ID (1-based)
  --keyword <text>     Fuzzy keyword match (case-insensitive)
  --session <id>       Filter by yondermesh session ID
  --limit <n>          Max query results
  --offset <n>         Skip first N results
  --list               List all extracted projects

handoff options:
  --json              Output the handoff package as JSON
  --tail <n>          Number of tail messages (default 30)

Examples:
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
  ymesh scaffold mycli --yes
`;
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
/**
 * agent 名 → mount registry id 的**例外**映射。
 *
 * 注意：这里只需写「名字与 registry id 不同」的例外（如 claude → claude-code）。
 * 同名的一律走下面的 `?? entry.name` 兜底查找——
 * 之前只查这张表，导致表里没写的 agent（pi / omp / copilot / kimi / …）
 * 全部被误报成「不支持挂载」，而实际上它们早就挂载好了（实测 pi 4 项全 MOUNTED）。
 */
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
  'trae_cli': 'trae-cli', // agent 名用下划线，registry id 用连字符
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
  id: string;
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
    // 先查例外表，再按同名兜底（多数 agent 名字 == registry id）
    const mountSupport = !!findCli(registryId ?? entry.name);
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
      id: entry.name,
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

/**
 * cmdScan 采集器元信息：registry id → { label, scannedField, method }
 * label 与原硬编码 importStats 的 adapter 字段一致（'claude' 非 'claude-code'，'trae_cli' 非 'trae-cli'）。
 * scannedField 为各 importer/extractor 返回值中表示"扫描数"的字段名。
 */
const IMPORTER_META: Record<string, { label: string; scannedField: string; method: 'import' | 'extract' }> = {
  cass:          { label: 'cass',       scannedField: 'scanned',      method: 'import' },
  'claude-code': { label: 'claude',     scannedField: 'scanned',      method: 'import' },
  codex:         { label: 'codex',      scannedField: 'scanned',      method: 'import' },
  hermes:        { label: 'hermes',     scannedField: 'scanned',      method: 'import' },
  windsurf:      { label: 'windsurf',   scannedField: 'scanned',      method: 'extract' },
  continue:      { label: 'continue',   scannedField: 'scanned',      method: 'import' },
  opencode:      { label: 'opencode',   scannedField: 'scanned',      method: 'import' },
  copilot:       { label: 'copilot',    scannedField: 'scanned',      method: 'import' },
  openclaw:      { label: 'openclaw',   scannedField: 'scanned',      method: 'import' },
  kimi:          { label: 'kimi',       scannedField: 'scanned',      method: 'import' },
  qwen:          { label: 'qwen',       scannedField: 'scanned',      method: 'import' },
  gemini:        { label: 'gemini',     scannedField: 'scanned',      method: 'import' },
  pi:            { label: 'pi',         scannedField: 'scanned',      method: 'import' },
  factory:       { label: 'factory',    scannedField: 'scanned',      method: 'import' },
  vibe:          { label: 'vibe',       scannedField: 'scanned',      method: 'import' },
  codebuddy:     { label: 'codebuddy',  scannedField: 'scanned',      method: 'import' },
  cline:         { label: 'cline',      scannedField: 'scanned',      method: 'import' },
  crush:         { label: 'crush',      scannedField: 'scanned',      method: 'import' },
  openhands:     { label: 'openhands',  scannedField: 'scanned',      method: 'import' },
  goose:         { label: 'goose',      scannedField: 'scanned',      method: 'import' },
  antigravity:   { label: 'antigravity',scannedField: 'scanned',      method: 'import' },
  aider:         { label: 'aider',      scannedField: 'filesScanned', method: 'import' },
  'trae-cli':    { label: 'trae_cli',   scannedField: 'filesScanned', method: 'import' },
  'cursor-ide':  { label: 'cursor-ide', scannedField: 'scanned',      method: 'extract' },
  'trae-ide':    { label: 'trae-ide',   scannedField: 'scanned',      method: 'extract' },
  amp:           { label: 'amp',        scannedField: 'threadsSeen',  method: 'import' },
  chatgpt:       { label: 'chatgpt',    scannedField: 'scanned',      method: 'extract' },
};

/** scan 命令 */
async function cmdScan(flags: Record<string, string | boolean>): Promise<number> {
  const deviceId = (flags.device as string) ?? hostname();
  const store = openStore(flags.db as string | undefined);

  const importStats: Array<{ adapter: string; scanned: number; inserted: number; updated: number }> = [];

  // 经 registry 动态加载采集器（listImporters 按注册表顺序返回，与原硬编码顺序一致）
  for (const adapter of listImporters()) {
    const meta = IMPORTER_META[adapter.id];
    if (!meta) continue;
    try {
      const mod = await adapter.importerLoader!() as Record<string, unknown>;
      // 扫描导出找 *Importer / *Extractor 类
      let Cls: (new (store: unknown, opts: unknown) => { import?: () => unknown; extract?: () => unknown }) | null = null;
      for (const key of Object.keys(mod)) {
        if ((key.endsWith('Importer') || key.endsWith('Extractor')) && typeof mod[key] === 'function') {
          Cls = mod[key] as new (store: unknown, opts: unknown) => { import?: () => unknown; extract?: () => unknown };
          break;
        }
      }
      if (!Cls) throw new Error(`未找到 importer/extractor 类`);
      // 默认走增量指纹（未变的文件整批跳过）；`ymesh scan --force` 才强制重读
      const instance = new Cls(store, { deviceId, force: flags.force === true });
      const stats = (meta.method === 'extract' ? instance.extract?.() : instance.import?.()) as Record<string, unknown> | undefined;
      const scanned = (stats && typeof stats[meta.scannedField] === 'number') ? stats[meta.scannedField] as number : 0;
      const inserted = (stats && typeof stats.inserted === 'number') ? stats.inserted as number : 0;
      const updated = (stats && typeof stats.updated === 'number') ? stats.updated as number : 0;
     importStats.push({ adapter: meta.label, scanned, inserted, updated });
    } catch (err) {
      importStats.push({ adapter: meta.label, scanned: 0, inserted: 0, updated: 0 });
      if (!flags.json) {
        console.error(`[${meta.label}] 跳过: ${String(err).split('\n')[0]}`);
      }
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
    `  ${'AGENT'.padEnd(14)} ${'STATUS'.padEnd(8)} ${'COLL'.padEnd(5)} ${'CAN-MT'.padEnd(6)} ${'WRAPPER'.padEnd(8)} ${'SESSIONS'.padStart(8)}`,
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
  // 'trae_cli'（下划线）是 CLI 参数的别名，registry 用 'trae-cli'
  const regId = cli === 'trae_cli' ? 'trae-cli' : cli;
  const mod = await regLoadWrapper(regId);
  if (!mod) throw new Error(`Unknown CLI: ${cli}`);
  return mod;
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

/**
 * inject 命令：向已有 session 注入消息。
 *
 * 两个安全语义（P0）：
 *   · 默认对「最近有写入」的 session 拒绝注入（双写风险），需 `--force` 显式覆盖；
 *   · 成功必须**回读验证**——只是 RPC 没报错不算成功。
 */
async function cmdInject(flags: Record<string, string | boolean>): Promise<number> {
  const cli = flags.cli as string;
  const session = flags.session as string;
  const message = flags.message as string;
  if (!cli || !session || !message) {
    console.error('用法: ymesh inject --cli <agent> --session <id> --message "text" [--force] [--json]');
    return 1;
  }

  try {
    const mod = await loadWrapper(cli);
    let result: unknown;
    const wrapper = instantiateWrapper(cli, mod);
    const injectOpts = { force: flags.force === true };
    if (wrapper && typeof wrapper.inject === 'function') {
      result = await wrapper.inject(session, message, cli, injectOpts);
    } else if (typeof mod.inject === 'function') {
      result = await mod.inject(session, message);
    } else {
      throw new Error(`${cli} wrapper does not support inject()`);
    }

    if (flags.json) {
      console.log(JSON.stringify({ cli, session, status: 'injected', result }, null, 2));
    } else {
      const r = result as { verified?: boolean } | undefined;
      console.log(
        `[yondermesh] ${cli} session ${session} injected${r?.verified ? '（已回读验证）' : ''}`,
      );
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

    // FTS 未同步提示。
    // 成本说明：精确检查在大库上要几十秒（1300 万行实测 44s/次）→ **默认不查**，
    // 只给一行指针；`status --full` 才真去查（用户明确要看时才付这个成本）。
    const ftsStore = new SessionStore(dbPath);
    try {
      if (ftsStore.isFtsCheckDeferred() && flags.full !== true) {
        console.log(
          `\n  全文索引: 未检查（大库，精确检查约需数十秒）。` +
            `\n    想看: ymesh status --full   ·   想回填: ymesh sync fts`,
        );
      } else {
        ftsStore.ensureFtsChecked();
        const ftsStale = ftsStore.ftsStaleInfo();
        if (ftsStale) {
          console.log(`\n  ⚠️  全文索引未同步: ${SessionStore.formatFtsStaleHint(ftsStale)}`);
        } else {
          console.log(`\n  全文索引: 已同步`);
        }
      }
      // 库体积 + 空闲页（O(1) PRAGMA）。空闲页很大 = 删过数据但没 VACUUM，
      // 这时文件不会自己缩小，得跑 `ymesh compact --vacuum`。
      const sizeInfo = ftsStore.dbSizeInfo();
      if (sizeInfo.dbBytes > 0) {
        const freePct = sizeInfo.dbBytes > 0 ? (sizeInfo.freeBytes / sizeInfo.dbBytes) * 100 : 0;
        console.log(
          `\n  库文件:     ${fmtBytes(sizeInfo.dbBytes)}（空闲 ${fmtBytes(sizeInfo.freeBytes)}，${freePct.toFixed(0)}%）`,
        );
        if (freePct > 20) {
          console.log('    空闲页偏多 → ymesh compact --vacuum 可把空间还给磁盘');
        }
      }
    } finally {
      ftsStore.close();
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

/** active 命令：快速查看谁在跑（与 observe --scope active 同一份底层逻辑） */
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
    // start() 不等首扫（见 daemon.waitInitialScan 注释）。这里显式等一下，
    // 只是为了能把首轮扫描结果打出来给用户看 —— 期间 watcher/reconcile 已在跑。
    await daemon.waitInitialScan();
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
  // 优先走原始 jsonl 路径（有 tool_call 细节），失败则回退到 DB
  //——DB 回退覆盖全部 adapter（pi / omp / hermes / …），不再只有 claude/codex。
  let pkg = buildSessionHandoff(sessionId, claudePath, codexPath, { tailMessages: tailNum });
  if (!pkg) {
    const dataDir = resolveDataDir(flags);
    const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');
    try {
      const store = new SessionStore(dbPath);
      try {
        pkg = buildStoreHandoff(sessionId, store, { tailMessages: tailNum });
      } finally {
        store.close();
      }
    } catch (err) {
      console.error(`[yondermesh] handoff 读库失败: ${String(err)}`);
      return 1;
    }
  }
  if (!pkg) {
    console.error(
      `[yondermesh] 找不到 session ${sessionId}。\n` +
        `  说明：已在 codex/claude 目录与数据库中都查找过（DB 支持任意前缀）。\n` +
        `  用 \`ymesh sessions --json\` 查可用 id。`,
    );
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

/**
 * observe 命令 —— 看（与 MCP 的 observe 同一实现）。
 *
 * 用法：
 *   ymesh observe [--scope me|global|project|session|active|tree] [--target <id|path>]
 *                 [--shape list|detail|summary|tree|stats] [--roles user,assistant]
 *                 [--exclude tool] [--min-length 200] [--keyword X] [--since 7d] [--limit N]
 */
async function cmdObserve(flags: Record<string, string | boolean>): Promise<number> {
  const dataDir = resolveDataDir(flags);
  const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');
  const store = new SessionStore(dbPath);
  try {
    const csv = (v: unknown): string[] | undefined =>
      typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
    const res = await observe(
      { store },
      {
        scope: (typeof flags.scope === 'string' ? flags.scope : 'global') as never,
        target: typeof flags.target === 'string' ? flags.target : undefined,
        shape: typeof flags.shape === 'string' ? (flags.shape as never) : undefined,
        filter: {
          roles: csv(flags.roles),
          exclude: csv(flags.exclude),
          minLength: typeof flags['min-length'] === 'string' ? Number(flags['min-length']) : undefined,
          keyword: typeof flags.keyword === 'string' ? flags.keyword : undefined,
          since: typeof flags.since === 'string' ? flags.since : undefined,
          until: typeof flags.until === 'string' ? flags.until : undefined,
        },
        limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
        offset: typeof flags.offset === 'string' ? Number(flags.offset) : undefined,
        includeAgents: flags.agents === true,
        selfSessionId: typeof flags.self === 'string' ? flags.self : undefined,
      },
    );
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else console.log(res.text);
    return res.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

/**
 * orchestrate 命令 —— 管（与 MCP 的 orchestrate 同一实现）。
 *
 * 用法：ymesh orchestrate <action> [--target <id>] [--brief "..."] [--query "..."]
 *                              [--to a,b] [--cli <cli>] [--model <m>] [--cwd <path>]
 */
async function cmdOrchestrate(flags: Record<string, string | boolean>): Promise<number> {
  const positional = process.argv.slice(process.argv.indexOf('orchestrate') + 1);
  const action = positional[0] ?? '';
  if (!action) {
    console.error(
      '用法：ymesh orchestrate <spawn|assign|handoff|await|discuss|prior|stop> [选项]\n' +
        '  --target <id>  --brief "..."  --query "..."  --to a,b\n' +
        '  --cli <cli>  --model <m>  --effort <e>  --cwd <path>',
    );
    return 1;
  }
  const dataDir = resolveDataDir(flags);
  const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');
  const store = new SessionStore(dbPath);
  const core = new MailboxCore(dbPath, dataDir);
  try {
    const res = await orchestrate(
      { store, core },
      {
        action: action as never,
        target: typeof flags.target === 'string' ? flags.target : undefined,
        brief: typeof flags.brief === 'string' ? flags.brief : undefined,
        query: typeof flags.query === 'string' ? flags.query : undefined,
        to: typeof flags.to === 'string' ? flags.to.split(',').map((x) => x.trim()) : undefined,
        delivery: typeof flags.delivery === 'string' ? (flags.delivery as never) : undefined,
        config: {
          cli: typeof flags.cli === 'string' ? flags.cli : undefined,
          model: typeof flags.model === 'string' ? flags.model : undefined,
          effort: typeof flags.effort === 'string' ? flags.effort : undefined,
          cwd: typeof flags.cwd === 'string' ? flags.cwd : undefined,
        },
        limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
        selfSessionId: typeof flags.self === 'string' ? flags.self : undefined,
      } as never,
    );
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else console.log(res.text);
    return res.ok ? 0 : 1;
  } finally {
    core.close();
    store.close();
  }
}

/**
 * workspace 命令 —— 标（与 MCP 的 workspace 同一实现）。
 *
 * 用法：ymesh workspace <list|add|update|remove|status> [--path P] [--label L] [--group G] [--note N]
 */
function cmdWorkspace(flags: Record<string, string | boolean>): number {
  const positional = process.argv.slice(process.argv.indexOf('workspace') + 1);
  const action = positional[0] ?? 'list';
  const dataDir = resolveDataDir(flags);
  const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');
  const store = new SessionStore(dbPath);
  try {
    const res = workspaceCmd(store, {
      action: action as never,
      path: typeof flags.path === 'string' ? flags.path : positional[1],
      label: typeof flags.label === 'string' ? flags.label : undefined,
      group: typeof flags.group === 'string' ? flags.group : undefined,
      note: typeof flags.note === 'string' ? flags.note : undefined,
      withinMinutes: typeof flags['within-minutes'] === 'string' ? Number(flags['within-minutes']) : undefined,
    });
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else console.log(res.text);
    return res.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

/**
 * message 命令 —— 跨 session 通信的统一入口（与 MCP 的 agent_message 同一实现）。
 *
 * 用法：
 *   ymesh message check [--limit N] [--self <sid>]
 *   ymesh message send --to <sid|all> --body "..." [--delivery now|after_turn|on_reply] [--from <sid>]
 */
async function cmdMessage(flags: Record<string, string | boolean>): Promise<number> {
  const positional = process.argv.slice(process.argv.indexOf('message') + 1);
  const action = positional[0] === 'send' ? 'send' : positional[0] === 'check' ? 'check' : '';
  if (!action) {
    console.error(
      '用法：\n  ymesh message check [--limit N] [--self <sid>]\n' +
        '  ymesh message send --to <sid|all> --body "..." [--delivery now|after_turn|on_reply] [--from <sid>]',
    );
    return 1;
  }

  const dataDir = resolveDataDir(flags);
  const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');
  const store = new SessionStore(dbPath);
  const core = new MailboxCore(dbPath, dataDir);
  try {
    const result = await agentMessage(
      { core, store },
      {
        action,
        to: typeof flags.to === 'string' ? flags.to : undefined,
        body: typeof flags.body === 'string' ? flags.body : undefined,
        delivery:
          flags.delivery === 'after_turn' || flags.delivery === 'on_reply' || flags.delivery === 'now'
            ? flags.delivery
            : undefined,
        replyTo: typeof flags['reply-to'] === 'string' ? Number(flags['reply-to']) : undefined,
        selfSessionId: typeof flags.self === 'string' ? flags.self : undefined,
        limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
        markRead: flags['no-mark-read'] !== true,
        unreadOnly: flags.all !== true,
      },
    );

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }

    if (result.action === 'check') {
      if (!result.ok) {
        console.error(result.error);
        return 1;
      }
      console.log(`\n未读 ${result.unread ?? 0} 条（共 ${result.total ?? 0} 条）\n`);
      for (const m of result.messages ?? []) {
        const from = m.from ? m.from.slice(0, 12) : '匿名';
        const pending = m.pending ? ' [排队中，未送达]' : '';
        console.log(`  #${m.id}  来自 ${from}${pending}`);
        console.log(`    ${m.body.replace(/\n/g, '\n    ')}`);
        console.log();
      }
      return 0;
    }

    if (!result.ok) {
      console.error(`[yondermesh] ${result.error}`);
      if (result.hint) console.error(`  提示：${result.hint}`);
      return 1;
    }
    const t = result.to ? `${result.to.source} ${result.to.sessionId.slice(0, 12)}` : '广播';
    if (result.delivery === 'now') {
      console.log(`[yondermesh] 已发给 ${t}（同步）`);
      if (result.response) console.log(`\n回复：\n${result.response}`);
    } else {
      console.log(`[yondermesh] 已排队给 ${t}（${result.delivery}），daemon 会在合适时机投递`);
      if (result.hint) console.log(`  ${result.hint}`);
    }
    return 0;
  } finally {
    core.close();
    store.close();
  }
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
    const diag = mailbox.resolveSelfSessionDetailed({ explicit: explicitSid });
    const selfSid = diag.sid;
    if (!selfSid) {
      console.error(`[yondermesh] ${formatSelfSessionFailure(diag)}`);
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
    const diag = mailbox.resolveSelfSessionDetailed({ explicit: explicitSid });
    const selfSid = diag.sid;
    if (flags.json) {
      console.log(JSON.stringify({ sessionId: selfSid ?? null, resolved: !!selfSid, via: diag.via ?? null, reason: diag.reason ?? null, hints: diag.hints }, null, 2));
      return 0;
    }
    if (!selfSid) {
      console.error(`[yondermesh] ${formatSelfSessionFailure(diag)}`);
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

// ─── send 命令（v3 同步注入模型）──────────────────────────────────────────
//
// MailboxCore.send() 是 v3 同步注入入口：调用方提供 --cli + --message，
// 内部依次执行：审计写入 → TriggerAdapter.trigger() → ReplyAdapter.extractReply()
// → 审计写入回复 → 返回 SendResult。CLI 只做参数解析 + 输出格式化。

/** send 命令：同步注入 v3 */
async function cmdSend(flags: Record<string, string | boolean>): Promise<number> {
  const cli = typeof flags.cli === 'string' ? flags.cli : '';
  const message = typeof flags.message === 'string' ? flags.message : '';
  const session = typeof flags.session === 'string' ? flags.session : undefined;
  const rawMode = typeof flags.mode === 'string' ? flags.mode : 'new';

  if (!cli || !message) {
    console.error('用法: ymesh send --cli <agent> [--session <id>] [--mode stopped|running|new]');
    console.error('      --message "text" [--model <m>] [--effort <e>] [--cwd <path>]');
    console.error('      [--timeout <ms>] [--from <sid>] [--json]');
    return 1;
  }

  if (rawMode !== 'stopped' && rawMode !== 'running' && rawMode !== 'new') {
    console.error(`[yondermesh] 无效 --mode: ${rawMode}（合法: stopped | running | new）`);
    return 1;
  }
  if ((rawMode === 'stopped' || rawMode === 'running') && !session) {
    console.error(`[yondermesh] ${rawMode} 模式需要 --session <id>`);
    return 1;
  }

  const model = typeof flags.model === 'string' ? flags.model : undefined;
  const effort = typeof flags.effort === 'string' ? flags.effort : undefined;
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : undefined;
  const fromSid = typeof flags.from === 'string' ? flags.from : undefined;
  const timeoutMs = typeof flags.timeout === 'string' ? parseInt(flags.timeout, 10) : undefined;

  const target: SendTarget = {
    cli,
    sessionId: session,
    mode: rawMode as SendMode,
    message,
    model,
    effort,
    cwd,
    timeoutMs: !isNaN(timeoutMs as number) ? timeoutMs : undefined,
    fromSessionId: fromSid,
  };

  const mailbox = openMailbox(flags);
  // 设 busy_timeout=5s：在并发 ymesh mcp / 多个 send 进程同时写审计时，
  // SQLite 默认 busy_timeout=0 会立即抛 SQLITE_BUSY。设 5s 让写操作短暂等待
  // 锁释放，绝大多数情况下一次就能成功。MailboxCore 未暴露 busy_timeout
  // 配置，这里通过运行时访问私有 db 字段设置（TS private 仅编译期检查）。
  try {
    (mailbox as unknown as { db: { exec: (sql: string) => void } })
      .db.exec('PRAGMA busy_timeout = 5000');
  } catch { /* 忽略——最坏情况退回立即失败 + verifier 重试兜底 */ }
  try {
    const result = await mailbox.send(target);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return result.delivered ? 0 : 2;
    }

    // 人类可读输出
    const status = result.delivered ? '✓ delivered' : '✗ failed';
    console.log(`\n  [yondermesh] ${status}  cli=${cli}  mode=${rawMode}  channel=${result.channel}  latency=${result.latencyMs}ms`);
    if (result.newSessionId) {
      console.log(`  new session: ${result.newSessionId}`);
    }
    if (result.exitCode !== undefined) {
      console.log(`  exit code:   ${result.exitCode}`);
    }
    console.log(`  audit msg:   #${result.messageId}` + (result.replyMessageId ? ` (reply #${result.replyMessageId})` : ''));
    if (result.error) {
      console.log(`  error:       ${result.error}`);
    }
    if (result.response) {
      const preview = result.response.length > 500
        ? result.response.slice(0, 500) + ` … (+${result.response.length - 500} chars)`
        : result.response;
      console.log(`\n  reply:\n    ${preview.replace(/\n/g, '\n    ')}`);
    } else if (result.delivered) {
      console.log('\n  reply: (empty — agent produced no reply text)');
    }
    console.log();
    return result.delivered ? 0 : 2;
  } catch (err) {
    console.error(`[yondermesh] send 失败: ${String(err)}`);
    return 1;
  } finally {
    mailbox.close();
  }
}


// ─── 主入口 ──────────────────────────────────────────────────────────────



/** sync 命令：显式触发数据维护任务（目前支持 fts 回填） */
/** compact 命令：回收历史 revision 正文 + 重建 FTS + 归还磁盘 */
function cmdCompact(flags: Record<string, string | boolean>): number {
  const dataDir = resolveDataDir(flags);
  const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');
  const dryRun = flags['dry-run'] === true;
  const wantVacuum = flags.vacuum === true;
  const sessionLimit =
    typeof flags['session-limit'] === 'string'
      ? Math.max(1, parseInt(flags['session-limit'], 10) || 200)
      : 200;

  const store = openStore(dbPath);
  try {
    // --mode 可在压缩前切换保留策略（keep → current-only 是回收历史副本的前提）
    if (flags.mode === 'keep' || flags.mode === 'current-only') {
      store.setRevisionBodyMode(flags.mode as 'keep' | 'current-only');
    }
    const before = store.compactAnalyze();
    // 大库一次性回收必须重建 FTS（逐行走触发器删 FTS 会把时间花在索引上）；
    // 小规模增量回收走触发器更省事。
    const rebuildFts = before.prunableRevisionRows > 200_000;

    if (dryRun) {
      if (flags.json) {
        console.log(JSON.stringify({ dryRun: true, ...before, wouldRebuildFts: rebuildFts }, null, 2));
      } else {
        console.log('[yondermesh] compact 评估（只读）');
        console.log(`  保留策略:        ${before.revisionBodyMode}`);
        console.log(`  含历史副本的 session: ${before.sessionsWithSupersededRevisions}`);
        console.log(`  可回收历史副本行数:   ${before.prunableRevisionRows}`);
        console.log(`  消息总行数:           ${before.messageRowsTotal}`);
        if (before.orphanRows > 0) console.log(`  孤儿行（可清理）:     ${before.orphanRows}`);
        console.log(`  其中真正存活:         ${before.liveMessageRows}`);
        console.log(`  全文索引行数:         ${before.ftsRows}`);
        console.log(`  库文件:               ${fmtBytes(before.dbBytes)}（其中空闲 ${fmtBytes(before.freeBytes)}）`);
        console.log(`  执行时会重建 FTS:     ${rebuildFts ? '是' : '否（增量回收）'}`);
        if (before.revisionBodyMode === 'keep') {
          console.log('  ⚠️  当前是 keep 策略（保留每一版正文），compact 不会删任何东西。');
          console.log('     要回收就得先切回 current-only：ymesh compact --mode current-only');
        } else {
          console.log('  去掉 --dry-run 即执行；加 --vacuum 可把回收的空间还给磁盘。');
        }
      }
      return 0;
    }

    if (before.revisionBodyMode === 'keep' && before.prunableRevisionRows > 0) {
      const msg =
        '当前是 keep 策略（保留每一版正文），compact 不会删除。要回收请加 --mode current-only。';
      if (flags.json) console.log(JSON.stringify({ ok: false, skipped: true, reason: msg }, null, 2));
      else console.error(`[yondermesh] ${msg}`);
      return flags.json ? 0 : 1;
    }
    if (!flags.json) {
      console.error(`[yondermesh] 开始压缩：待回收 ${before.prunableRevisionRows} 行历史副本，库 ${fmtBytes(before.dbBytes)}`);
    }
    let lastPhase = '';
    const report = store.compactApply({
      sessionLimit,
      rebuildFts,
      vacuum: wantVacuum,
      onPhase: (phase) => {
        if (flags.json || phase === lastPhase) return;
        lastPhase = phase;
        const label: Record<string, string> = {
          prune: '回收历史 revision 正文',
          'purge-orphans': '清理孤儿行（session 已删除的历史遗留）',
          'rebuild-fts': '重建全文索引结构',
          'backfill-fts': '回填全文索引',
          vacuum: 'VACUUM 归还磁盘（可能数分钟）',
        };
        console.error(`[yondermesh] ${label[phase] ?? phase}…`);
      },
    });
    const after = store.compactAnalyze();

    if (flags.json) {
      console.log(JSON.stringify({ before, after, report }, null, 2));
    } else {
      console.log('[yondermesh] compact 完成');
      console.log(`  删除历史副本行数: ${report.deletedRevisionRows}`);
      if (report.purgedOrphanRows > 0) console.log(`  清理孤儿行:       ${report.purgedOrphanRows}`);
      if (report.ftsRebuilt) console.log(`  重建全文索引:     ${report.ftsBackfilled} 行`);
      console.log(`  库文件:           ${fmtBytes(before.dbBytes)} → ${fmtBytes(after.dbBytes)}`);
      console.log(`  耗时:             ${(report.elapsedMs / 1000).toFixed(1)}s`);
      if (!wantVacuum && before.dbBytes - after.dbBytes < before.dbBytes * 0.2) {
        console.log('  提示: 空间尚未归还磁盘（页进入空闲列表，后续写入会复用）。要真正缩小文件加 --vacuum。');
      }
    }
    return 0;
  } catch (err) {
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, error: String(err) }, null, 2));
    } else {
      console.error(`[yondermesh] compact 失败: ${String(err)}`);
    }
    return 1;
  } finally {
    store.close();
  }
}

/** 人类可读的字节数 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function cmdSync(flags: Record<string, string | boolean>): number {
  const positional = process.argv.slice(process.argv.indexOf('sync') + 1);
  const action = positional[0] ?? '';

  if (action !== 'fts') {
    console.error('用法: ymesh sync fts [--batch <n>] [--json]');
    console.error('  fts  显式分批回填 messages_fts 全文索引（大库自动回填被跳过时用）');
    return 1;
  }

  const dataDir = resolveDataDir(flags);
  const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');
  const batchSize = typeof flags.batch === 'string' ? Math.max(100, parseInt(flags.batch, 10) || 5000) : 5000;

  const store = openStore(dbPath);
  try {
    // 循环回填直到 remaining=0。每批打印进度到 stderr（不污染 --json stdout）。
    // 大库可能跑数十分钟，进度条让用户知道没卡死。
    let progress = store.syncFtsBatch(batchSize);
    const startDone = progress.done;
    const startTime = Date.now();

    if (progress.remaining === 0) {
      if (flags.json) {
        console.log(JSON.stringify({ total: progress.total, done: progress.done, remaining: 0, message: 'FTS 已同步，无需回填' }, null, 2));
      } else {
        console.log(`[yondermesh] FTS 已同步：${progress.done}/${progress.total}，无需回填`);
      }
      return 0;
    }

    if (!flags.json) {
      console.error(`[yondermesh] 开始回填 FTS：${progress.done}/${progress.total}（剩余 ${progress.remaining}），批大小 ${batchSize}`);
    }

    let lastReportAt = Date.now();
    while (progress.remaining > 0) {
      progress = store.syncFtsBatch(batchSize);
      const now = Date.now();
      // 每 3 秒或完成时打印进度，避免日志爆炸
      if (!flags.json && (now - lastReportAt > 3000 || progress.remaining === 0)) {
        const elapsedSec = ((now - startTime) / 1000).toFixed(1);
        const processed = progress.done - startDone;
        const rate = processed > 0 ? (processed / ((now - startTime) / 1000)).toFixed(0) : '0';
        const etaSec = progress.remaining > 0 && Number(rate) > 0
          ? (progress.remaining / Number(rate)).toFixed(0)
          : '?';
        console.error(`[yondermesh] 进度 ${progress.done}/${progress.total}（${processed} 条已回填，${rate} 条/秒，ETA ${etaSec}s）已用 ${elapsedSec}s`);
        lastReportAt = now;
      }
    }

    if (flags.json) {
      console.log(JSON.stringify({
        total: progress.total,
        done: progress.done,
        remaining: 0,
        elapsedMs: Date.now() - startTime,
      }, null, 2));
    } else {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[yondermesh] FTS 回填完成：${progress.done}/${progress.total}，用时 ${elapsedSec}s`);
    }
    return 0;
  } catch (err) {
    console.error(`[yondermesh] sync fts 失败: ${String(err)}`);
    return 1;
  } finally {
    store.close();
  }
}

/** retain 命令：数据库压缩/筛除/归档（控制膨胀） */
async function cmdRetain(flags: Record<string, string | boolean>): Promise<number> {
  const positional = process.argv.slice(process.argv.indexOf('retain') + 1);
  const action = positional[0] ?? '';

  const dataDir = resolveDataDir(flags);
  const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');
  const backupDir = join(dataDir, 'retention-backups');

  // 动态 import（ESM 环境，require 不可用）
  const retainMod = await import('../retain/index.js');
  const policy = { ...retainMod.DEFAULT_POLICY, backupDir };

  if (action === 'analyze' || action === '' || action === 'config') {
    let report;
    try {
      report = retainMod.analyze(dbPath, policy);
    } catch (err) {
      console.error(`[yondermesh] retain analyze 失败: ${String(err)}`);
      return 1;
    }

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }

    // 人类可读报告
    const fmtBytes = (b: number) => {
      if (b > 1_000_000_000) return `${(b / 1_000_000_000).toFixed(2)} GB`;
      if (b > 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
      if (b > 1_000) return `${(b / 1_000).toFixed(1)} KB`;
      return `${b} B`;
    };
    if (report.sampled) {
      console.log(
        `\n⚠️  这是**抽样估算**（样本 ${report.sampleSize.toLocaleString()} 条 / 全库约 ${report.totalMessages.toLocaleString()} 条）。` +
          `\n    大库精确分析要 8~9 分钟（15M 行 × 4.4GB 文本），所以按比例外推。` +
          `\n    归档 / session 级分类在抽样模式下不做（它们按 session 判定，抽样算不出来）。`,
      );
    }

    const fmtPct = (n: number, total: number) =>
      total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';

    console.log('=== Retention 分析报告 ===');
    console.log(`数据库: ${dbPath}`);
    console.log(`总消息: ${report.totalMessages.toLocaleString()} (${fmtBytes(report.totalBytes)})`);
    console.log();

    console.log('--- L0 噪音筛除 ---');
    if (report.noise.perRule.length === 0 && report.noise.shortHighFreq.length === 0) {
      console.log('  无噪音可删');
    } else {
      for (const r of report.noise.perRule) {
        console.log(`  [${r.name}] ${r.messages.toLocaleString()} 条 (${fmtBytes(r.bytes)})`);
      }
      for (const r of report.noise.shortHighFreq.slice(0, 10)) {
        const preview = r.content.length > 50 ? r.content.slice(0, 50) + '...' : r.content;
        console.log(`  [short-high-freq] "${preview}" ${r.occurrences.toLocaleString()} 次 (${fmtBytes(r.bytes)})`);
      }
      console.log(`  小计: ${report.noise.totalMessages.toLocaleString()} 条 (${fmtBytes(report.noise.totalBytes)}) - ${fmtPct(report.noise.totalMessages, report.totalMessages)} 消息`);
    }
    console.log();

    console.log('--- L2 长内容截断 ---');
    if (report.truncate.perRule.length === 0) {
      console.log('  无超长消息');
    } else {
      for (const r of report.truncate.perRule) {
        console.log(`  [${r.role}] > ${r.maxBytes}B 截断到 ${r.keepBytes}B: ${r.messages.toLocaleString()} 条，节省 ${fmtBytes(r.savedBytes)}`);
      }
      console.log(`  小计: ${report.truncate.totalMessages.toLocaleString()} 条，节省 ${fmtBytes(report.truncate.totalSavedBytes)}`);
    }
    console.log();

    console.log('--- Session 级分类（SL0/SL1/SL2） ---');
    const sess = report.session;
    if (sess.noiseSessions.length === 0 && sess.shortSessions.length === 0 && sess.duplicateSessions.length === 0) {
      console.log('  无 session 级冗余');
    } else {
      console.log(`  SL0 纯噪音 session: ${sess.noiseSessions.length.toLocaleString()} 个 (${sess.totalNoiseMessages.toLocaleString()} 消息 / ${fmtBytes(sess.totalNoiseBytes)})`);
      console.log(`  SL1 短问答 session: ${sess.shortSessions.length.toLocaleString()} 个 (${sess.totalShortMessages.toLocaleString()} 消息 / ${fmtBytes(sess.totalShortBytes)})`);
      console.log(`  SL2 重复 session:    ${sess.duplicateSessions.length.toLocaleString()} 个 (${sess.totalDuplicateMessages.toLocaleString()} 消息 / ${fmtBytes(sess.totalDuplicateBytes)})`);
      // 展示前 3 个 SL0 样例
      for (const s of sess.noiseSessions.slice(0, 3)) {
        console.log(`    [SL0 样例] ${s.id} — ${s.reason}`);
      }
      // 展示前 3 个 SL2 重复样例
      for (const s of sess.duplicateSessions.slice(0, 3)) {
        console.log(`    [SL2 样例] ${s.id} — ${s.reason}`);
      }
    }
    console.log();

    console.log('--- L3 老旧归档 ---');
    if (report.archive.sessionsToArchive === 0) {
      console.log('  无超 TTL session');
    } else {
      const cutoffDate = new Date(report.archive.cutoffTimestamp).toISOString().slice(0, 10);
      console.log(`  TTL: ${policy.archive.olderThanDays} 天 (截止 ${cutoffDate})`);
      console.log(`  待归档 session: ${report.archive.sessionsToArchive.toLocaleString()}`);
      console.log(`  涉及消息: ${report.archive.messagesAffected.toLocaleString()} (${fmtBytes(report.archive.bytesAffected)})`);
      console.log(`  ${policy.archive.keepSessionMetadata ? '保留 session 元数据' : '同时删 session 元数据'}`);
    }
    console.log();

    console.log('=== 综合预期 ===');
    const removedMsgs = report.totalMessages - report.projectedRemainingMessages;
    const removedBytes = report.totalBytes - report.projectedRemainingBytes;
    console.log(`可减少: ${removedMsgs.toLocaleString()} 消息 (${fmtPct(removedMsgs, report.totalMessages)})`);
    console.log(`        ${fmtBytes(removedBytes)} 字节 (${fmtPct(removedBytes, report.totalBytes)})`);
    console.log(`筛除后: ${report.projectedRemainingMessages.toLocaleString()} 消息 (${fmtBytes(report.projectedRemainingBytes)})`);
    console.log();
    console.log('执行: ymesh retain apply [--dry-run] [--no-backup]');
    return 0;
  }

  if (action === 'apply') {
    const dryRun = flags['dry-run'] === true || flags.dryRun === true;
    const skipBackup = flags['no-backup'] === true || flags.noBackup === true;

    if (dryRun) {
      console.log('[yondermesh] dry-run 模式：只报告，不修改数据库');
    }
    if (skipBackup) {
      console.log('[yondermesh] 跳过备份（被删数据不可恢复）');
    } else {
      console.log(`[yondermesh] 备份目录: ${backupDir}`);
    }

    let result;
    try {
      result = retainMod.apply(dbPath, policy, { dryRun, skipBackup });
    } catch (err) {
      console.error(`[yondermesh] retain apply 失败: ${String(err)}`);
      return 1;
    }

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    console.log('=== Retention 执行结果 ===');
    console.log(`模式: ${result.dryRun ? 'dry-run' : '实际执行'}`);
    console.log(`耗时: ${(result.elapsedMs / 1000).toFixed(1)}s`);
    console.log();
    console.log(`L0 噪音删除: ${result.noiseDeleted.toLocaleString()} 条`);
    if (!skipBackup && result.noiseBackupUniqueContents > 0) {
      console.log(`  备份唯一内容: ${result.noiseBackupUniqueContents.toLocaleString()} 条`);
    }
    console.log(`L2 长内容截断: ${result.truncated.toLocaleString()} 条`);
    console.log(`SL0 纯噪音 session 整场删: ${result.sessionNoiseDeleted.toLocaleString()} 个 (${result.sessionNoiseMessagesDeleted.toLocaleString()} 消息)`);
    console.log(`SL1 短问答 session 压缩: ${result.sessionShortCompacted.toLocaleString()} 个 (${result.sessionShortMessagesDeleted.toLocaleString()} 消息)`);
    console.log(`SL2 重复 session 压缩:    ${result.sessionDuplicateCompacted.toLocaleString()} 个 (${result.sessionDuplicateMessagesDeleted.toLocaleString()} 消息)`);
    console.log(`L3 归档 session: ${result.sessionsArchived.toLocaleString()} 个 (${result.archiveMessagesDeleted.toLocaleString()} 消息)`);
    if (result.backupFile) {
      console.log(`备份文件: ${result.backupFile}`);
    }
    if (result.backupError) {
      console.log(`备份错误: ${result.backupError}`);
    }
    return 0;
  }

  console.error('用法: ymesh retain <analyze|apply> [--db <path>] [--json]');
  console.error('  analyze           扫描报告（只读）');
  console.error('  apply             执行筛除（含备份）');
  console.error('  apply --dry-run   预演，不修改数据库');
  console.error('  apply --no-backup 跳过备份（不可恢复）');
  return 1;
}

// ─── scaffold 命令（adapter-sdk 收尾） ─────────────────────────────────

/**
 * scaffold 命令：用 SDK 的 scaffoldAdapter() 生成新 adapter 模板文件到 src/<name>/。
 *
 * 用法：
 *   ymesh scaffold <name> [--config-dir <dir>] [--cli-binary <bin>]
 *                  [--session-format jsonl|sqlite|json|markdown] [--yes]
 *
 * --yes 跳过覆盖确认（CI / verifier 用）。文件落在 resolveProjectRoot()/src/<name>/ 下。
 *
 * 说明：SDK 的 scaffoldAdapter() 会对 name 做规范化（小写 + 非法字符→连字符）用于
 * 内部标识（类名、source 字段）；但落盘目录用原始 name，保持「叫什么生成什么」的直觉。
 */
async function cmdScaffold(flags: Record<string, string | boolean>): Promise<number> {
  // 从 process.argv 取 scaffold 后的位置参数（name），与 cmdHandoff 模式一致
  const scaffoldIdx = process.argv.indexOf('scaffold');
  const name = scaffoldIdx >= 0 ? (process.argv[scaffoldIdx + 1] ?? '') : '';
  if (!name || name.startsWith('--')) {
    console.error('用法: ymesh scaffold <name> [--config-dir <dir>] [--cli-binary <bin>] [--session-format jsonl|sqlite|json|markdown] [--yes]');
    return 1;
  }

  // 收集 SDK 选项
  const options: ScaffoldOptions = {};
  if (typeof flags['config-dir'] === 'string') options.configDir = flags['config-dir'];
  if (typeof flags['cli-binary'] === 'string') options.cliBinary = flags['cli-binary'];
  if (typeof flags['session-format'] === 'string') {
    const fmt = flags['session-format'];
    if (fmt === 'jsonl' || fmt === 'sqlite' || fmt === 'json' || fmt === 'markdown') {
      options.sessionFormat = fmt;
    } else {
      console.error(`[yondermesh] --session-format 仅支持 jsonl|sqlite|json|markdown，收到: ${fmt}`);
      return 1;
    }
  }

  // SDK 生成内容（含规范化 id 用于类名/source），但目录名用原始 name
  const { files } = scaffoldAdapter(name, options);
  const sdkId = files[0]!.path.split('/')[1]!; // SDK 规范化后的 id（如 '__probe' → '--probe'）
  // 落盘路径：把 SDK 的 src/<id>/ 替换为 src/<name>/，保留文件名
  const writeFiles = files.map((f) => ({
    content: f.content,
    path: f.path.replace(`src/${sdkId}/`, `src/${name}/`),
  }));

  // 目标根：当前工作目录（scaffold 是代码生成器，落盘到用户当前项目根）
  // 不用 resolveProjectRoot()——从 release 跑时会指向 release 目录而非用户 cwd
  const root = process.cwd();

  // 检查是否已存在同名目录或文件
  const existingPaths = writeFiles
    .map((f) => join(root, f.path))
    .filter((p) => existsSync(p));

  if (existingPaths.length > 0 && flags.yes !== true) {
    console.error(`[yondermesh] 以下文件已存在，加 --yes 覆盖：`);
    for (const p of existingPaths) {
      console.error(`  ${p}`);
    }
    return 1;
  }

  // 写盘
  for (const f of writeFiles) {
    const absPath = join(root, f.path);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, f.content);
  }

  // 摘要输出
  if (flags.json) {
    console.log(JSON.stringify({
      name,
      id: sdkId,
      dir: `src/${name}/`,
      files: writeFiles.map((f) => f.path),
    }, null, 2));
  } else {
    console.log(`[yondermesh] 已生成 adapter 模板：${name}`);
    for (const f of writeFiles) {
      console.log(`  ${f.path}`);
    }
    console.log(`\n下一步：编辑 src/${name}/importer.ts 实现 scan/parse，再在 src/adapters/registry.ts 注册。`);
  }
  return 0;
}



/**
 * reimport 命令：重新扫描指定 source 的 session，把结构化工具调用补进 message_tool_calls 表
 *
 * 用法：ymesh reimport --source <name> [--limit <n>] [--dry-run] [--yes] [--db <path>] [--json]
 *
 * --source <name>     指定 source（支持 label 如 claude/codex/hermes/cass/trae_cli 或 id 如 claude-code）
 * --limit <n>         限制处理的 session 数（默认全部）
 * --dry-run           仅报告，不写入（默认 dry-run；需 --yes 确认才真正执行）
 * --yes               确认执行（非 dry-run）
 * --db <path>         数据库路径
 * --json              JSON 输出
 *
 * 内部机制（loop build-tool-calls-schema §D）：
 *   - 调用对应 adapter 的 importer 重新扫描
 *   - importer 的 ingestSession 现在会在内容幂等时调 attachToolCallsBySeq 补 toolCalls
 *   - 幂等：UNIQUE(message_id, call_seq) + INSERT OR IGNORE，重复跑不重复插入
 */
async function cmdReimport(flags: Record<string, string | boolean>): Promise<number> {
  if (flags.help === true) {
    console.log('用法: ymesh reimport --source <name> [--limit <n>] [--dry-run] [--yes] [--db <path>] [--json]');
    console.log('  --source <name>   指定 source（claude/codex/hermes/cass/trae_cli/trae-ide 等）');
    console.log('  --limit <n>       限制处理的 session 数（默认全部）');
    console.log('  --dry-run         仅报告，不写入（默认 dry-run）');
    console.log('  --yes             确认执行（非 dry-run）');
    console.log('  --db <path>       数据库路径（默认 ~/.yondermesh/yondermesh.db）');
    console.log('  --json            JSON 输出');
    return 0;
  }

  const sourceRaw = typeof flags.source === 'string' ? flags.source : '';
  if (!sourceRaw) {
    console.error('用法: ymesh reimport --source <name> [--limit <n>] [--dry-run] [--yes]');
    console.error('  必须指定 --source；可用值见 ymesh scan 输出的 adapter 列');
    return 1;
  }

  // label → id 映射（claude → claude-code，trae_cli → trae-cli）
  const labelToId: Record<string, string> = {
    claude: 'claude-code',
    codex: 'codex',
    hermes: 'hermes',
    cass: 'cass',
    trae_cli: 'trae-cli',
    'trae-ide': 'trae-ide',
    'trae-cli': 'trae-cli',
  };
  const sourceId = labelToId[sourceRaw] ?? sourceRaw;

  const meta = IMPORTER_META[sourceId];
  if (!meta) {
    console.error(`[yondermesh] 未知 source: ${sourceRaw}（id=${sourceId}）`);
    console.error(`  可用 source: claude, codex, hermes, cass, trae_cli, trae-ide`);
    return 1;
  }

  const isDryRun = flags['dry-run'] === true || flags.yes !== true;
  if (isDryRun && flags.yes !== true) {
    // 默认 dry-run
  }

  const dataDir = resolveDataDir(flags);
  const dbPath = typeof flags.db === 'string' ? flags.db : join(dataDir, 'yondermesh.db');
  const deviceId = (flags.device as string) ?? hostname();
  const limit = typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : undefined;

  // dry-run 模式：先查现有 toolCalls 数，报告将补多少
  const store = openStore(dbPath);
  try {
    // 查询该 source 的现有 session 数和 toolCalls 数
    const beforeRow = store.sourceToolCallStats([meta.label, sourceId]);

    if (isDryRun) {
      const msg = `[yondermesh] reimport dry-run: source=${meta.label}, sessions=${beforeRow.sessions}, existing_tool_calls=${beforeRow.toolCalls}`
        + (limit ? `, limit=${limit}` : '')
        + `\n  将重新扫描并补 attach 结构化 toolCalls到 message_tool_calls 表。`
        + `\n  加 --yes 确认执行。`;
      if (flags.json) {
        console.log(JSON.stringify({
          dryRun: true,
          source: meta.label,
          sessionsBefore: beforeRow.sessions,
          toolCallsBefore: beforeRow.toolCalls,
          limit: limit ?? null,
        }, null, 2));
      } else {
        console.log(msg);
      }
      return 0;
    }

    // 非 dry-run：执行 importer 重新扫描
    // 找到对应 adapter
    const adapter = listImporters().find((a) => a.id === sourceId);
    if (!adapter || !adapter.importerLoader) {
      console.error(`[yondermesh] source ${meta.label} 无 importer 加载器`);
      return 1;
    }

    const mod = await adapter.importerLoader() as Record<string, unknown>;
    let Cls: (new (store: unknown, opts: unknown) => { import?: () => unknown; extract?: () => unknown }) | null = null;
    for (const key of Object.keys(mod)) {
      if ((key.endsWith('Importer') || key.endsWith('Extractor')) && typeof mod[key] === 'function') {
        Cls = mod[key] as new (store: unknown, opts: unknown) => { import?: () => unknown; extract?: () => unknown };
        break;
      }
    }
    if (!Cls) {
      console.error(`[yondermesh] source ${meta.label} 未找到 importer/extractor 类`);
      return 1;
    }

    // force：reimport 的目的就是补历史数据（结构化 tool_calls），必须绕开增量指纹；
    // 否则文件没变就整批跳过，命令会「报成功但补 0 条」（实测踩到）
    const instance = new Cls(store, { deviceId, force: true });
    const stats = (meta.method === 'extract' ? instance.extract?.() : instance.import?.()) as Record<string, unknown> | undefined;

    // 统计 reimport 后的 toolCalls 数
    const afterRow = store.sourceToolCallStats([meta.label, sourceId]);

    const scanned = (stats && typeof stats[meta.scannedField] === 'number') ? stats[meta.scannedField] as number : 0;
    const inserted = (stats && typeof stats.inserted === 'number') ? stats.inserted as number : 0;
    const updated = (stats && typeof stats.updated === 'number') ? stats.updated as number : 0;
    const unchanged = (stats && typeof stats.unchanged === 'number') ? stats.unchanged as number : 0;
    const toolCallsAdded = afterRow.toolCalls - beforeRow.toolCalls;

    if (flags.json) {
      console.log(JSON.stringify({
        dryRun: false,
        source: meta.label,
        scanned,
        inserted,
        updated,
        unchanged,
        sessionsBefore: beforeRow.sessions,
        toolCallsBefore: beforeRow.toolCalls,
        toolCallsAfter: afterRow.toolCalls,
        toolCallsAdded: toolCallsAdded > 0 ? toolCallsAdded : 0,
      }, null, 2));
    } else {
      console.log(`[yondermesh] reimport ${meta.label}: scanned=${scanned}, inserted=${inserted}, updated=${updated}, unchanged=${unchanged}`);
      console.log(`  tool_calls: ${beforeRow.toolCalls} → ${afterRow.toolCalls} (+${toolCallsAdded > 0 ? toolCallsAdded : 0})`);
    }
    return 0;
  } finally {
    store.close();
  }
}






async function main(): Promise<number> {
  // 进程级 PATH 兜底：daemon 由 LaunchAgent 托管时 PATH 只有
  // /usr/bin:/bin:/usr/sbin:/sbin，而 CLI 装在 ~/.local/bin、fnm 目录下。
  // 不补这一步，「调用其他 CLI/子进程」类功能在后台会成片失败
  // （消息投递 exit -1、mount 失败、agent 检测漏报，都是同一个根因）。
  augmentProcessPath();

  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const { flags } = parsed;
  let { command } = parsed;

  // 全局动作型 flag 归一化：`--version` / `--help` 会被参数解析器吃进 flags，
  // 导致 command 为空而落到 help 分支（实测 `ymesh --version` 输出 111 行 help
  // 而不是一行版本号）。这里把纯「想问版本/帮助」的调用纠正回对应命令。
  if (!command && flags.version !== undefined) command = 'version';
  if (!command && flags.help !== undefined) command = 'help';

  switch (command) {
    case 'help':
    case undefined:
    case '':
      return cmdHelp(flags.lang === 'en' ? 'en' : 'zh');

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

    case 'observe':
      return await cmdObserve(flags);
    case 'orchestrate':
      return await cmdOrchestrate(flags);
    case 'workspace':
      return cmdWorkspace(flags);
    case 'message':
      return await cmdMessage(flags);

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

    case 'send':
      return await cmdSend(flags);




    case 'scaffold':
      return await cmdScaffold(flags);

    case 'sync':
      return cmdSync(flags);

    case 'compact':
      return cmdCompact(flags);

    case 'retain':
      return await cmdRetain(flags);


    case 'reimport':
      return await cmdReimport(flags);


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
