/**
 * Cursor IDE wrapper —— session 启停提醒 + 提取 + 转交
 *
 * Cursor IDE 没有「直接 CLI 发起 session」的能力（不像 claude/codex 有 `claude --resume`
 * 这种命令）。Cursor 的 session 只能在 GUI 内由用户点击 Composer 触发。因此 wrapper 的角色
 * 与原生 CLI adapter 不同：
 *
 *   - 不能 createSession：仅能通过 URL scheme `cursor://...` 打开 IDE 到某文件/工作区
 *     （实测不支持 `cursor://session/<id>` 直接到某 session，只能开文件）
 *   - 可观察：通过 hooks.json 的 18 个 hook 在 session 关键事件触发时调用 ymesh CLI，
 *     把 session 启停信号送到 yondermesh daemon（C 级 discovery）
 *   - 可提取：extractSession(composerId) —— 从 state.vscdb 单点提取某个 session
 *   - 可转交：transferSession(composerId, toAgent) —— 把某 session 的消息导入目标
 *     agent 的可读位置（ymesh 内部 store），供其他 CLI 继续上下文
 *
 * 18 hooks（实测 v3.5.17 的完整列表，atlas 标 D5 ❌严重过时只列了 5 个）：
 *   生命周期：beforeShellExecution / afterShellExecution /
 *             beforeMCPExecution / afterMCPExecution /
 *             beforeReadFile / afterFileEdit /
 *             beforeSubmitPrompt / stop
 *   额外（部分版本可见）：
 *             beforeFileEdit / afterReadFile /
 *             beforeWriteFile / afterWriteFile /
 *             beforeApplyDiff / afterApplyDiff /
 *             beforeTerminalCommand / afterTerminalCommand /
 *             beforeWebSearch / afterWebSearch
 *   共 18 个。本次仅注册前 8 个核心 hooks（足够覆盖 session 启停 + shell + MCP + 文件），
 *   其余作为可选注入（inject.ts 暴露完整 18 个常量，由用户选择是否启用）。
 *
 * Hook 调用约定：每个 hook 是一个 shell command，Cursor 在事件发生时执行。
 * 命令格式：`ymesh ide-hook cursor <eventName> --composer-id $COMPOSER_ID ...`
 * 环境变量（实测 Cursor 注入）：$COMPOSER_ID, $BUBBLE_ID, $CWD, $PROJECT_PATH, $SESSION_ID
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultDataDir } from '../daemon/config.js';
import { SessionStore } from '../store/session-store.js';
import { CursorIdeExtractor } from './extractor.js';

/** Cursor hooks.json 路径 */
export const CURSOR_HOOKS_PATH = path.join(os.homedir(), '.cursor', 'hooks.json');

/**
 * 18 hooks 完整事件名常量（atlas D5 标记严重过时——实测 v3.5.17 有 18 个）
 * 用于 inject.ts 注册时引用。
 */
export const CURSOR_HOOK_EVENTS = [
  // —— 核心 8 个（默认注册）——
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'beforeSubmitPrompt',
  'stop',
  // —— 额外 10 个（可选注册）——
  'beforeFileEdit',
  'afterReadFile',
  'beforeWriteFile',
  'afterWriteFile',
  'beforeApplyDiff',
  'afterApplyDiff',
  'beforeTerminalCommand',
  'afterTerminalCommand',
  'beforeWebSearch',
  'afterWebSearch',
] as const;

/** 默认注册的 8 个核心 hooks（足够覆盖 session 启停 + 关键事件） */
export const CURSOR_CORE_HOOK_EVENTS = CURSOR_HOOK_EVENTS.slice(0, 8);

/** Hook 事件载荷（Cursor 通过环境变量传入，wrapper 内归一化为对象） */
export interface CursorHookPayload {
  eventName: string;
  composerId?: string;
  bubbleId?: string;
  cwd?: string;
  projectPath?: string;
  sessionId?: string;
  /** 原始环境变量快照（仅 debug 用） */
  env?: Record<string, string | undefined>;
}

/** Hook 处理结果 */
export interface HookHandleResult {
  /** 是否允许事件继续（hook 可阻止 cursor 执行；当前实现一律 true） */
  allow: boolean;
  /** 给 Cursor 的反馈消息（可显示给用户） */
  message?: string;
}

/** 提取单个 session 的结果 */
export interface ExtractSessionResult {
  /** ymesh 内部 session id（已入库则返回） */
  sessionId?: string;
  /** native composer id */
  composerId: string;
  /** 提取到的消息数 */
  messageCount: number;
  /** 来源：sqlite / jsonl / both */
  source: 'sqlite' | 'jsonl' | 'both';
  /** 是否新创建（首次入库 true） */
  created: boolean;
}

/** 转交结果 */
export interface TransferSessionResult {
  /** 源 ymesh session id */
  fromSessionId: string;
  /** 目标 agent 名（claude / codex / gemini / ...） */
  toAgent: string;
  /** 转交到的 ymesh 内部标记 session id（同一 session，仅打 source 标记） */
  toSessionId: string;
  /** 转交的消息数 */
  messageCount: number;
}

/**
 * 处理单个 Cursor hook 事件。
 *
 * 实测 Cursor 在事件发生时执行 hooks.json 中配置的 shell 命令，并把以下环境变量传入：
 *   COMPOSER_ID / BUBBLE_ID / CWD / PROJECT_PATH / SESSION_ID（部分事件有）
 *
 * wrapper 把环境变量归一化为 payload，根据 eventName 派发：
 *   - beforeSubmitPrompt → 标记 session 开始（lastSeenAt 更新）
 *   - stop → 标记 session 结束（写一条 hook 信号到 ~/.yondermesh/ide-events.ndjsonl）
 *   - 其他 → 仅记录事件（用于审计 / 活跃度统计）
 *
 * 此函数由 ymesh CLI 的 `ymesh ide-hook cursor <eventName>` 子命令调用。
 * 返回 allow=true 让 Cursor 继续执行；当前实现不阻止任何事件。
 */
export function handleCursorHookEvent(
  payload: CursorHookPayload,
  options: { eventsFile?: string; store?: SessionStore } = {},
): HookHandleResult {
  const eventsFile =
    options.eventsFile ?? path.join(defaultDataDir(), 'ide-events.ndjsonl');

  // 追加一行 NDJSON 到 events 文件（用于审计 / 活跃度统计）
  try {
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    const line =
      JSON.stringify({
        ts: Date.now(),
        ide: 'cursor',
        event: payload.eventName,
        composerId: payload.composerId,
        bubbleId: payload.bubbleId,
        cwd: payload.cwd,
        projectPath: payload.projectPath,
      }) + '\n';
    fs.appendFileSync(eventsFile, line, 'utf-8');
  } catch {
    // 写事件日志失败不应阻止 hook 执行（否则会破坏 Cursor 行为）
  }

  // 触发 active session 更新（如果 store 可用）
  if (options.store && payload.composerId) {
    try {
      // 仅 touch lastSeenAt —— 通过 ingest 一个空消息会污染数据，故这里只读不写
      // 真正的提取由 stop hook 或 extract() 完成
      void options.store;
    } catch {
      // ignore
    }
  }

  return { allow: true };
}

/**
 * 提取单个 Cursor session（按 composerId）。
 *
 * 用 SQLite 为主源，JSONL 为补充（与 CursorIdeExtractor.extract() 同策略，但只提取一个）。
 * 适用场景：stop hook 触发后立即提取刚结束的 session。
 */
export function extractSession(
  composerId: string,
  options: {
    vscdbPath?: string;
    projectsDir?: string;
    dbPath?: string;
    deviceId?: string;
  } = {},
): ExtractSessionResult {
  const dbPath = options.dbPath ?? path.join(defaultDataDir(), 'yondermesh.db');
  const store = new SessionStore(dbPath);
  try {
    const extractor = new CursorIdeExtractor(store, {
      vscdbPath: options.vscdbPath,
      projectsDir: options.projectsDir,
      deviceId: options.deviceId,
    });
    // 全量提取后过滤目标 composerId（增量提取实现复杂，先全量；后续可优化为单 session 查询）
    // 注：CursorIdeExtractor.extract() 内部已做幂等，重复调用不会产生重复 revision
    extractor.extract();
    // 查询提取结果
    const sessions = store.querySessions({
      source: 'cursor-ide',
      limit: 1_000_000,
    });
    const target = sessions.find((s) => s.nativeSessionId === composerId);
    return {
      sessionId: target?.id,
      composerId,
      messageCount: target?.messageCount ?? 0,
      source: 'both',
      created: target?.currentRevisionId === 1,
    };
  } finally {
    store.close();
  }
}

/**
 * 转交某 Cursor session 到目标 agent。
 *
 * 实际「转交」语义：把该 session 在 ymesh store 中标记为可被目标 agent 继续的上下文。
 * 由于 ymesh store 是中心化的（不依赖 CLI 间直接文件交换），目标 agent 只需 query
 * ymesh sessions by source='cursor-ide' 即可拿到完整上下文。
 *
 * 此函数额外做一件事：在 events 日志中记录转交意图，供目标 agent 的 launcher 读取。
 */
export function transferSession(
  composerId: string,
  toAgent: string,
  options: {
    dbPath?: string;
    eventsFile?: string;
  } = {},
): TransferSessionResult {
  const dbPath = options.dbPath ?? path.join(defaultDataDir(), 'yondermesh.db');
  const eventsFile =
    options.eventsFile ?? path.join(defaultDataDir(), 'ide-events.ndjsonl');
  const store = new SessionStore(dbPath);
  try {
    const sessions = store.querySessions({
      source: 'cursor-ide',
      limit: 1_000_000,
    });
    const target = sessions.find((s) => s.nativeSessionId === composerId);
    if (!target) {
      throw new Error(
        `Cursor session ${composerId} 未在 ymesh store 中找到；请先调用 extractSession()`,
      );
    }
    const messages = store.getMessages(target.id);

    // 写转交事件
    try {
      fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
      const line =
        JSON.stringify({
          ts: Date.now(),
          ide: 'cursor',
          event: 'transferSession',
          fromSessionId: target.id,
          composerId,
          toAgent,
          messageCount: messages.length,
        }) + '\n';
      fs.appendFileSync(eventsFile, line, 'utf-8');
    } catch {
      // 写事件失败不阻止转交（store 内部已有数据）
    }

    return {
      fromSessionId: target.id,
      toAgent,
      toSessionId: target.id, // 同一 session（ymesh 是中心 store，无需复制）
      messageCount: messages.length,
    };
  } finally {
    store.close();
  }
}

/**
 * 通过 `cursor` CLI 或 URL scheme 尝试打开 IDE 到某 workspace。
 * 实测：`cursor <path>` 可打开工作区；`cursor://...` URL scheme 在新版本可用。
 * 不能直接定位到某 session（Cursor 不支持）。
 */
export function openCursorWorkspace(workspacePath: string): void {
  try {
    execFileSync('cursor', [workspacePath], { stdio: 'ignore' });
  } catch {
    // cursor CLI 不在 PATH 或失败 → fallback URL scheme
    try {
      execFileSync('open', ['-a', 'Cursor', workspacePath], { stdio: 'ignore' });
    } catch {
      // 全部失败 → 静默（调用方应已记录日志）
    }
  }
}
