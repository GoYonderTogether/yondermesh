/**
 * Windsurf wrapper —— Cascade Hook 事件处理 + session 提取 + 转交
 *
 * Windsurf（Codeium IDE）的 Cascade 12 Hooks 实测（本机 v3.x，2026-07）：
 *   - HookAgentAction enum (exa.cortex_pb) 完整列表（12 个 actionable，UNSPECIFIED 不计）：
 *       1  PRE_READ_CODE
 *       2  POST_READ_CODE
 *       3  PRE_WRITE_CODE
 *       4  POST_WRITE_CODE
 *       5  PRE_MCP_TOOL_USE
 *       6  POST_MCP_TOOL_USE
 *       7  PRE_RUN_COMMAND
 *       8  POST_RUN_COMMAND
 *       9  PRE_USER_PROMPT
 *       10 POST_CASCADE_RESPONSE
 *       11 POST_SETUP_WORKTREE
 *       12 POST_CASCADE_RESPONSE_WITH_TRANSCRIPT  ← A 级采集入口
 *   - 配置路径（实测）：per-workspace `<workspace>/hooks/hooks.json`
 *     （备选 `<workspace>/custom-hooks/hooks.json`）
 *     Windsurf workbench 源码：`hookConfigPaths=["hooks/hooks.json"]`
 *     注：atlas 标「~/.codeium/windsurf/hooks.json」严重过时 —— 全局 hooks 不存在，
 *     hooks 只能 per-workspace 配置。inject.ts 同时写全局模板 + 提供 workspace 注入。
 *
 * Hook 调用约定（实测 workbench parseHooks）：每个 hook 是 shell command 字符串，
 * 支持 `${CLAUDE_PLUGIN_ROOT}` 变量替换；command 字段含 windows/linux/osx 三平台分支。
 * Windsurf 在事件发生时执行 command，把事件 payload 通过 stdin（JSON）传入。
 *
 * Hook payload 字段（POST_CASCADE_RESPONSE_WITH_TRANSCRIPT，实测推断 + 保守解析）：
 *   - cascadeId / cascade_id (UUID)
 *   - workspace / cwd
 *   - projectPath
 *   - model
 *   - transcript: [{role, content, timestamp}, ...]
 *   - title / startedAt / lastUpdatedAt
 *
 * wrapper 把 payload 归一化为 TranscriptFile 写到 ~/.yondermesh/windsurf-transcripts/<cascade_id>.json
 * 供 extractor.ts 入库。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { defaultDataDir } from '../daemon/config.js';
import { SessionStore } from '../store/session-store.js';
import { WindsurfExtractor, WINDSURF_TRANSCRIPTS_DIR } from './extractor.js';

/** ymesh 管理的事件日志（审计 / 活跃度统计） */
export const WINDSURF_EVENTS_FILE = path.join(defaultDataDir(), 'ide-events.ndjsonl');

/**
 * 12 个 Cascade Hook 事件名常量（HookAgentAction enum，按 no 排序）。
 * 注：UNSPECIFIED(0) 不在列表中，12 个 actionable hooks。
 */
export const WINDSURF_CASCADE_HOOK_EVENTS = [
  'PRE_READ_CODE',
  'POST_READ_CODE',
  'PRE_WRITE_CODE',
  'POST_WRITE_CODE',
  'PRE_MCP_TOOL_USE',
  'POST_MCP_TOOL_USE',
  'PRE_RUN_COMMAND',
  'POST_RUN_COMMAND',
  'PRE_USER_PROMPT',
  'POST_CASCADE_RESPONSE',
  'POST_SETUP_WORKTREE',
  'POST_CASCADE_RESPONSE_WITH_TRANSCRIPT',
] as const;

/** A 级采集入口 hook（含完整 transcript） */
export const WINDSURF_PRIMARY_HOOK_EVENT = 'POST_CASCADE_RESPONSE_WITH_TRANSCRIPT';

/** 默认注册的核心 hooks：采集入口 + 生命周期标记 */
export const WINDSURF_CORE_HOOK_EVENTS = [
  'PRE_USER_PROMPT',
  'POST_CASCADE_RESPONSE_WITH_TRANSCRIPT',
] as const;

/** Hook 事件载荷（Windsurf 通过 stdin JSON 传入，wrapper 归一化为对象） */
export interface WindsurfHookPayload {
  eventName: string;
  /** cascade id（UUID） */
  cascadeId?: string;
  /** workspace 路径 */
  workspace?: string;
  /** project path */
  projectPath?: string;
  /** 模型名 */
  model?: string;
  /** 会话标题 */
  title?: string;
  /** startedAt 毫秒 */
  startedAt?: number;
  /** lastUpdatedAt 毫秒 */
  lastUpdatedAt?: number;
  /** transcript（仅 POST_CASCADE_RESPONSE_WITH_TRANSCRIPT 有） */
  transcript?: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp?: number;
  }>;
  /** 原始 JSON（仅 debug 用） */
  raw?: unknown;
}

/** Hook 处理结果 */
export interface HookHandleResult {
  /** 是否允许事件继续（hook 可阻止 Windsurf 执行；当前实现一律 true） */
  allow: boolean;
  /** 给 Windsurf 的反馈消息 */
  message?: string;
  /** 是否写入了 transcript 文件 */
  transcriptWritten: boolean;
  /** 写入的 transcript 文件路径 */
  transcriptPath?: string;
}

/** 提取单个 session 的结果 */
export interface ExtractSessionResult {
  /** ymesh 内部 session id（已入库则返回） */
  sessionId?: string;
  /** native cascade id */
  cascadeId: string;
  /** 提取到的消息数 */
  messageCount: number;
  /** 是否新创建（首次入库 true） */
  created: boolean;
}

/** 转交结果 */
export interface TransferSessionResult {
  /** 源 ymesh session id */
  fromSessionId: string;
  /** 目标 agent 名 */
  toAgent: string;
  /** 转交到的 ymesh 内部标记 session id（同一 session，仅打 source 标记） */
  toSessionId: string;
  /** 转交的消息数 */
  messageCount: number;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 从原始 payload 对象中保守提取字段（兼容多种命名）。
 * Windsurf hook payload 的字段名在不同版本可能为 camelCase / snake_case，
 * 这里两种都查。
 */
function normalizePayload(raw: unknown): WindsurfHookPayload {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const getString = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };
  const getNumber = (keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const getArray = (keys: string[]): unknown[] | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (Array.isArray(v)) return v;
    }
    return undefined;
  };

  const transcript = getArray(['transcript', 'messages', 'conversation']) ?? [];
  const normalizedTranscript = transcript
    .map((m) => {
      const mo = m as Record<string, unknown>;
      const role = mo.role;
      const content = typeof mo.content === 'string' ? mo.content : mo.text;
      const ts = typeof mo.timestamp === 'number' ? mo.timestamp : undefined;
      if (role !== 'user' && role !== 'assistant') return null;
      if (typeof content !== 'string' || content.length === 0) return null;
      return { role: role as 'user' | 'assistant', content, timestamp: ts };
    })
    .filter(
      (m): m is { role: 'user' | 'assistant'; content: string; timestamp: number | undefined } =>
        m !== null,
    );

  return {
    eventName: getString(['eventName', 'event', 'action', 'hookEvent']) ?? '',
    cascadeId: getString(['cascadeId', 'cascade_id', 'sessionId', 'session_id']),
    workspace: getString(['workspace', 'cwd', 'workspacePath']),
    projectPath: getString(['projectPath', 'project_path', 'project']),
    model: getString(['model', 'modelName']),
    title: getString(['title', 'name']),
    startedAt: getNumber(['startedAt', 'started_at', 'createdAt', 'created_at']),
    lastUpdatedAt: getNumber(['lastUpdatedAt', 'last_updated_at', 'updatedAt', 'updated_at']),
    transcript: normalizedTranscript,
    raw,
  };
}

/**
 * 处理单个 Windsurf hook 事件。
 *
 * Windsurf 在事件发生时执行 hooks/hooks.json 中配置的 shell 命令，把 payload 通过
 * stdin（JSON）传入。wrapper 从 stdin 读取 payload，根据 eventName 派发：
 *   - PRE_USER_PROMPT → 标记 session 开始（写事件日志）
 *   - POST_CASCADE_RESPONSE_WITH_TRANSCRIPT → 把 transcript 写到
 *     ~/.yondermesh/windsurf-transcripts/<cascade_id>.json（采集入口）
 *   - 其他 → 仅记录事件（用于审计 / 活跃度统计）
 *
 * 此函数由 ymesh CLI 的 `ymesh ide-hook windsurf <eventName>` 子命令调用。
 * 返回 allow=true 让 Windsurf 继续执行；当前实现不阻止任何事件。
 *
 * @param payloadFromStdin 从 stdin 读取的原始 JSON 对象（或字符串，会被解析）
 */
export function handleWindsurfHookEvent(
  eventName: string,
  payloadFromStdin: unknown,
  options: { transcriptsDir?: string; eventsFile?: string } = {},
): HookHandleResult {
  const transcriptsDir = options.transcriptsDir ?? WINDSURF_TRANSCRIPTS_DIR;
  const eventsFile = options.eventsFile ?? WINDSURF_EVENTS_FILE;
  const normalized = normalizePayload(payloadFromStdin);
  normalized.eventName = eventName || normalized.eventName;

  // 1. 写事件日志（审计 / 活跃度统计）
  try {
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    const line =
      JSON.stringify({
        ts: Date.now(),
        ide: 'windsurf',
        event: normalized.eventName,
        cascadeId: normalized.cascadeId,
        workspace: normalized.workspace,
      }) + '\n';
    fs.appendFileSync(eventsFile, line, 'utf-8');
  } catch {
    // 写事件日志失败不应阻止 hook 执行
  }

  // 2. POST_CASCADE_RESPONSE_WITH_TRANSCRIPT → 写 transcript 文件
  if (normalized.eventName === WINDSURF_PRIMARY_HOOK_EVENT) {
    if (!normalized.cascadeId || !normalized.transcript || normalized.transcript.length === 0) {
      return { allow: true, transcriptWritten: false };
    }
    try {
      fs.mkdirSync(transcriptsDir, { recursive: true });
      const filePath = path.join(transcriptsDir, `${normalized.cascadeId}.json`);
      const content = JSON.stringify({
        cascadeId: normalized.cascadeId,
        title: normalized.title,
        workspace: normalized.workspace,
        projectPath: normalized.projectPath,
        model: normalized.model,
        startedAt: normalized.startedAt,
        lastUpdatedAt: normalized.lastUpdatedAt ?? Date.now(),
        messages: normalized.transcript,
      });
      // 原子写：先 tmp 再 rename
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, filePath);
      return { allow: true, transcriptWritten: true, transcriptPath: filePath };
    } catch (e) {
      return {
        allow: true,
        transcriptWritten: false,
        message: `failed to write transcript: ${errorMessage(e)}`,
      };
    }
  }

  return { allow: true, transcriptWritten: false };
}

/**
 * 提取单个 Windsurf cascade session（按 cascadeId）。
 * 触发一次 extractor.extract()（幂等），再从 store 查询目标 cascadeId。
 */
export function extractSession(
  cascadeId: string,
  options: {
    transcriptsDir?: string;
    cascadeDir?: string;
    dbPath?: string;
    deviceId?: string;
  } = {},
): ExtractSessionResult {
  const dbPath = options.dbPath ?? path.join(defaultDataDir(), 'yondermesh.db');
  const store = new SessionStore(dbPath);
  try {
    const extractor = new WindsurfExtractor(store, {
      transcriptsDir: options.transcriptsDir,
      cascadeDir: options.cascadeDir,
      deviceId: options.deviceId,
    });
    extractor.extract();
    const sessions = store.querySessions({
      source: 'windsurf',
      limit: 1_000_000,
    });
    const target = sessions.find((s) => s.nativeSessionId === cascadeId);
    return {
      sessionId: target?.id,
      cascadeId,
      messageCount: target?.messageCount ?? 0,
      created: target?.currentRevisionId === 1,
    };
  } finally {
    store.close();
  }
}

/**
 * 转交某 Windsurf cascade session 到目标 agent。
 *
 * ymesh store 是中心化的：目标 agent 只需 query ymesh sessions by source='windsurf'
 * 即可拿到完整上下文。此函数额外在 events 日志中记录转交意图。
 */
export function transferSession(
  cascadeId: string,
  toAgent: string,
  options: {
    dbPath?: string;
    eventsFile?: string;
  } = {},
): TransferSessionResult {
  const dbPath = options.dbPath ?? path.join(defaultDataDir(), 'yondermesh.db');
  const eventsFile = options.eventsFile ?? WINDSURF_EVENTS_FILE;
  const store = new SessionStore(dbPath);
  try {
    const sessions = store.querySessions({
      source: 'windsurf',
      limit: 1_000_000,
    });
    const target = sessions.find((s) => s.nativeSessionId === cascadeId);
    if (!target) {
      throw new Error(
        `Windsurf cascade ${cascadeId} 未在 ymesh store 中找到；请先调用 extractSession()`,
      );
    }
    const messages = store.getMessages(target.id);

    try {
      fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
      const line =
        JSON.stringify({
          ts: Date.now(),
          ide: 'windsurf',
          event: 'transferSession',
          fromSessionId: target.id,
          cascadeId,
          toAgent,
          messageCount: messages.length,
        }) + '\n';
      fs.appendFileSync(eventsFile, line, 'utf-8');
    } catch {
      // 写事件失败不阻止转交
    }

    return {
      fromSessionId: target.id,
      toAgent,
      toSessionId: target.id,
      messageCount: messages.length,
    };
  } finally {
    store.close();
  }
}

/**
 * 通过 `windsurf` CLI 尝试打开 IDE 到某 workspace。
 * 实测：`windsurf <path>` 可打开工作区（与 code/vscode 兼容）。
 * 不能直接定位到某 cascade session（Windsurf 不支持）。
 */
export function openWindsurfWorkspace(workspacePath: string): void {
  try {
    execFileSync('windsurf', [workspacePath], { stdio: 'ignore' });
  } catch {
    try {
      execFileSync('open', ['-a', 'Windsurf', workspacePath], { stdio: 'ignore' });
    } catch {
      // 全部失败 → 静默
    }
  }
}
