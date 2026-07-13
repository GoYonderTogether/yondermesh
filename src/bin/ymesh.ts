#!/usr/bin/env node
/**
 * yondermesh CLI 入口（LOOP-007）
 *
 * 极简命令行，不引入外部依赖：
 *   ymesh help / version / scan / status / sessions / daemon
 *
 * 支持 --json 全局标志，输出 JSON 格式。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { hostname } from 'node:os';

import { SessionStore } from '../store/index.js';
import { CassImporter } from '../cass/index.js';
import { ClaudeCodeImporter } from '../claude/index.js';
import { CodexImporter } from '../codex/index.js';
import { YondermeshDaemon, defaultDaemonConfig } from '../daemon/index.js';
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
  ENTRY_SYMLINK,
  LAUNCH_AGENT_PLIST,
} from '../install/index.js';

// 读取 package.json 的版本号
const projectRoot = dirname(dirname(dirname(new URL(import.meta.url).pathname)));
const packageJson = JSON.parse(readFileSync(`${projectRoot}/package.json`, 'utf-8'));
const VERSION = packageJson.version as string;

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
  scan                扫描本机全部 session（cass + claude + codex）
  status              显示 daemon 状态和最近扫描结果
  sessions            列出 session（支持过滤）
  daemon              启动后台 daemon（实时监听 + 定时 reconcile）
  install             本地构建 release 并安装
  service <action>    管理 LaunchAgent (install|uninstall|start|stop|status)
  releases            列出已安装的 release 版本
  update              从 Git 源码更新（构建失败自动回退）
  rollback            手动回退到上一个 release 版本

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

示例:
  ymesh scan
  ymesh sessions --limit 50
  ymesh sessions --source claude --topology root
  ymesh sessions --cwd-prefix /Users/zoran/projects --json
  ymesh status
  ymesh daemon
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

/** scan 命令 */
function cmdScan(flags: Record<string, string | boolean>): number {
  const deviceId = (flags.device as string) ?? hostname();
  const store = openStore(flags.db as string | undefined);

  const results: Array<{ source: string; scanned: number; inserted: number; updated: number }> = [];

  // cass
  try {
    const importer = new CassImporter(store, { deviceId });
    const stats = importer.import();
    results.push({ source: 'cass', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    results.push({ source: 'cass', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[cass] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // claude
  try {
    const importer = new ClaudeCodeImporter(store, { deviceId });
    const stats = importer.import();
    results.push({ source: 'claude', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    results.push({ source: 'claude', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[claude] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  // codex
  try {
    const importer = new CodexImporter(store, { deviceId });
    const stats = importer.import();
    results.push({ source: 'codex', scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated });
  } catch (err) {
    results.push({ source: 'codex', scanned: 0, inserted: 0, updated: 0 });
    if (!flags.json) {
      console.error(`[codex] 跳过: ${String(err).split('\n')[0]}`);
    }
  }

  store.close();

  if (flags.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    console.log('\n扫描完成：\n');
    for (const r of results) {
      console.log(`  ${r.source.padEnd(10)}  扫描 ${r.scanned}  新增 ${r.inserted}  更新 ${r.updated}`);
    }
    console.log();
  }
  return 0;
}

/** status 命令 */
function cmdStatus(flags: Record<string, string | boolean>): number {
  const config = defaultDaemonConfig();
  const dbPath = (flags.db as string) ?? config.dbPath;
  const pidFile = config.pidFile;

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
      stats,
      recentScans: lastScanRuns,
    }, null, 2));
  } else {
    console.log(`\nyondermesh 状态\n`);
    console.log(`  daemon:  ${daemonRunning ? `运行中 (PID ${daemonPid})` : '未运行'}`);
    console.log(`  DB 路径: ${dbPath}`);
    if (stats) {
      console.log(`\n  数据统计:`);
      console.log(`    总 session:  ${stats.totalSessions}`);
      console.log(`    根 session:  ${stats.rootSessions}`);
      console.log(`    子 agent:    ${stats.subagentSessions}`);
      console.log(`    总消息:      ${stats.totalMessages}`);
    } else {
      console.log(`\n  数据统计: (数据库未初始化)`);
    }
    console.log();
  }
  return 0;
}

/** sessions 命令 */
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
  };

  const sessions = store.querySessions(query);
  const stats = store.getSessionStats(query);
  store.close();

  if (flags.json) {
    console.log(JSON.stringify({ sessions, stats }, null, 2));
  } else {
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

/** daemon 命令 */
async function cmdDaemon(flags: Record<string, string | boolean>): Promise<number> {
  const config: Partial<DaemonConfig> = {};
  if (flags.db) config.dbPath = flags.db as string;
  if (flags['data-dir']) config.dataDir = flags['data-dir'] as string;

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
  console.log('[yondermesh] 开始本地构建...');

  try {
    const release = buildRelease(projectRoot, force);
    console.log(`[yondermesh] 构建 release ${release.version} → ${release.releasePath}`);

    installRelease(release);
    console.log(`[yondermesh] 已安装: ${ENTRY_SYMLINK} → ${release.entryPath}`);
    console.log('[yondermesh] 提示：将以下路径加入 PATH 以全局使用：');
    console.log('  export PATH="$HOME/.yondermesh/bin:$PATH"');
    return 0;
  } catch (err) {
    console.error(`[yondermesh] 安装失败: ${String(err)}`);
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
        console.log(`[yondermesh] LaunchAgent 已安装: ${LAUNCH_AGENT_PLIST}`);
        return 0;
      } catch (err) {
        console.error(`[yondermesh] 安装失败: ${String(err)}`);
        return 1;
      }
    }
    case 'uninstall': {
      try {
        uninstallService();
        console.log('[yondermesh] LaunchAgent 已卸载');
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
        return 0;
      } catch (err) {
        console.error(`[yondermesh] 启动失败: ${String(err)}`);
        return 1;
      }
    }
    case 'stop': {
      try {
        stopService();
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

// ─── update 命令（LOOP-009） ───────────────────────────────────────────

/** update 命令：从 Git 源码更新并自动回退 */
async function cmdUpdate(flags: Record<string, string | boolean>): Promise<number> {
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
  process.exit(code);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
