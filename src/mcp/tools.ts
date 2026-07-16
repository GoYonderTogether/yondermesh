/**
 * yondermesh MCP 工具定义 — 暴露给其他 agent 的 MCP 工具集
 *
 * 每个工具含 name / description / inputSchema / handler，可被任意 MCP 客户端
 * (Claude Code / Codex / Gemini CLI 等) 通过 ymesh MCP server 调用。
 *
 * 工具分类：
 *   - 查询类：list_agents / query_sessions / get_session / mount_status
 *     直读 SessionStore / mount registry，无副作用
 *   - 控制类：launch_agent / inject_session / transfer_session
 *     通过动态 import 加载对应 CLI 的 wrapper（hermes/opencode/...），执行实际 CLI 调用
 *
 * handler 自包含：每次调用自己打开 SessionStore（用 defaultDaemonConfig），避免
 * 跨调用共享连接状态。控制类 handler 用 loadWrapper(cli) 按需加载 wrapper 模块。
 */

import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';

import { SessionStore } from '../store/index.js';
import type { SessionQuery } from '../store/types.js';
import { defaultDaemonConfig } from '../daemon/index.js';
import {
  CLI_REGISTRY,
  detectInstalledClis,
} from '../mount/registry.js';
import { verifyAll } from '../mount/manager.js';
import { MailboxCore } from '../mailbox/index.js';
import type { PostMessageInput, SendMode, SendTarget } from '../mailbox/index.js';
import { loadWrapper as regLoadWrapper } from '../adapters/registry.js';

// detectAgents 可能尚未创建（src/detect/agents.ts），用动态 import 兜底；
// 若加载失败则回退到 mount/registry 的 detectInstalledClis。
// 注意：使用变量路径绕过 TypeScript 静态模块解析，因为该文件可能尚未存在。
type DetectAgentsFn = () => Array<{
  id: string;
  displayName: string;
  installed: boolean;
  coverage: string;
  mountStrategies: string[];
  wrapperSupported: boolean;
}>;

async function loadDetectAgents(): Promise<DetectAgentsFn | null> {
  // 路径用变量，避免 TypeScript 在编译期静态解析找不到的模块。
  const modulePath = '../detect/agents.js';
  try {
    const mod = (await import(modulePath)) as {
      detectAgents?: DetectAgentsFn;
    };
    return mod.detectAgents ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpToolHandler {
  (args: Record<string, unknown>): Promise<McpToolResponse>;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler: McpToolHandler;
}

// ---------------------------------------------------------------------------
// 辅助：打开 store
// ---------------------------------------------------------------------------

function openStore(): SessionStore {
  const config = defaultDaemonConfig();
  return new SessionStore(config.dbPath);
}

/** 包装 JSON 输出为 MCP 文本 content */
function jsonContent(data: unknown): McpToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** 包装错误为 MCP isError 响应 */
function errorContent(message: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** 打开 MailboxCore（用 defaultDaemonConfig 的 dbPath + dataDir） */
function openMailbox(): MailboxCore {
  const config = defaultDaemonConfig();
  return new MailboxCore(config.dbPath, config.dataDir);
}

// ---------------------------------------------------------------------------
// 动态 wrapper 加载
// ---------------------------------------------------------------------------

/**
 * wrapper 模块的统一接口（实际 wrapper 各自有更丰富的方法，这里只取控制类需要的）。
 * 通过动态 import 按需加载，避免在启动时把所有 CLI wrapper 都拉进来。
 */
interface WrapperModule {
  /** 构造器：返回 controller 实例（或 null 表示该 CLI 不支持 wrapper） */
  createController?: () => unknown;
  /** 直接函数式 API：launch(prompt, opts) → { sessionId, response, exitCode } */
  launch?: (
    prompt: string,
    opts: { model?: string; cwd?: string },
  ) => { sessionId: string; response: string; exitCode: number };
  /** 直接函数式 API：inject(sessionId, message) → { response, exitCode }，支持 sync/async */
  inject?: (
    sessionId: string,
    message: string,
  ) => Promise<{ response: string; exitCode: number }> | { response: string; exitCode: number };
  /** 直接函数式 API：extract + transfer → handoff prompt */
  transferSession?: (
    sessionId: string,
    targetCli: string,
  ) => { handoffPrompt: string; session: unknown } | null;
}

/**
 * 归一化各 wrapper 的异构 inject 返回值为统一 { response, exitCode }。
 *
 * 各 wrapper 返回值差异：
 * - hermes: { response, exitCode }（原生匹配）
 * - goose/antigravity: { ok, exitCode, stdout, stderr }（stdout→response）
 * - kimi/openclaw: { channel, ok }（无 response，ok→exitCode）
 * - pi: { ok: true }
 * - opencode: void
 * - copilot: { child, sessionId? }
 * - openhands: { ok, status, data? }（status→exitCode, data→response）
 * - crush/cline: void
 */
function normalizeInjectResult(raw: unknown): { response: string; exitCode: number } {
  if (raw == null) {
    return { response: '', exitCode: 0 };
  }
  if (typeof raw === 'string') {
    return { response: raw, exitCode: 0 };
  }
  if (typeof raw !== 'object') {
    return { response: String(raw), exitCode: 0 };
  }
  const r = raw as Record<string, unknown>;
  const response =
    (typeof r.response === 'string' && r.response) ||
    (typeof r.stdout === 'string' && r.stdout) ||
    (typeof r.data === 'string' && r.data) ||
    (r.data != null && typeof r.data === 'object' ? JSON.stringify(r.data) : '') ||
    '';
  const exitCode =
    typeof r.exitCode === 'number'
      ? r.exitCode
      : r.ok === false || r.success === false || r.status != null
        ? r.ok === false || r.success === false
          ? 1
          : (r.status as number) >= 400
            ? 1
            : 0
        : 0;
 return { response, exitCode };
}

/**
 * 从注册表加载 wrapper 原始模块，再经 mapper 转成 WrapperModule。
 * registry.loadWrapper 内部已 try/catch（失败返回 null），
 * mod 为 null 时返回空 {} 与原 mapper 对缺失导出的行为一致。
 */
function wrapLoader(id: string, mapper: (mod: Record<string, unknown>) => WrapperModule): () => Promise<WrapperModule> {
  return async () => {
    const mod = await regLoadWrapper(id);
    return mod ? mapper(mod as Record<string, unknown>) : {};
  };
}

const WRAPPER_LOADERS: Record<string, () => Promise<WrapperModule>> = {
  hermes: wrapLoader('hermes', mapHermesWrapper),
  opencode: wrapLoader('opencode', mapOpenCodeWrapper),
  kimi: wrapLoader('kimi', mapKimiWrapper),
  pi: wrapLoader('pi', mapPiWrapper),
  aider: wrapLoader('aider', mapAiderWrapper),
  amp: wrapLoader('amp', mapAmpWrapper),
  antigravity: wrapLoader('antigravity', mapGenericWrapper),
  cline: wrapLoader('cline', mapGenericWrapper),
  codebuddy: wrapLoader('codebuddy', mapGenericWrapper),
  continue: wrapLoader('continue', mapGenericWrapper),
  copilot: wrapLoader('copilot', mapGenericWrapper),
  crush: wrapLoader('crush', mapGenericWrapper),
  'cursor-ide': wrapLoader('cursor-ide', mapGenericWrapper),
  factory: wrapLoader('factory', mapGenericWrapper),
  gemini: wrapLoader('gemini', mapGenericWrapper),
  goose: wrapLoader('goose', mapGenericWrapper),
  openclaw: wrapLoader('openclaw', mapGenericWrapper),
  openhands: wrapLoader('openhands', mapGenericWrapper),
  qwen: wrapLoader('qwen', mapGenericWrapper),
  'trae-cli': wrapLoader('trae-cli', mapGenericWrapper),
  'trae-ide': wrapLoader('trae-ide', mapGenericWrapper),
  vibe: wrapLoader('vibe', mapGenericWrapper),
  windsurf: wrapLoader('windsurf', mapGenericWrapper),
};

/** Hermes wrapper：HermesController 类，封装为函数式 API */
function mapHermesWrapper(mod: Record<string, unknown>): WrapperModule {
  const HermesController = mod.HermesController as
    | (new () => {
        launch: (
          prompt: string,
          opts?: { model?: string; cwd?: string },
        ) => { sessionId: string; response: string; exitCode: number };
        inject: (
          sessionId: string,
          message: string,
        ) => { response: string; exitCode: number };
        transferSession: (
          sessionId: string,
          targetCli: string,
        ) => { handoffPrompt: string; session: unknown } | null;
      })
    | undefined;

  if (!HermesController) return {};
  return {
    createController: () => new HermesController(),
    launch: (prompt, opts) => new HermesController().launch(prompt, opts ?? {}),
    inject: (sessionId, message) =>
      new HermesController().inject(sessionId, message),
    transferSession: (sessionId, targetCli) =>
      new HermesController().transferSession(sessionId, targetCli),
  };
}

/** OpenCode wrapper：OpenCodeController 类 */
function mapOpenCodeWrapper(mod: Record<string, unknown>): WrapperModule {
  const OpenCodeController = mod.OpenCodeController as
    | (new () => unknown)
    | undefined;
  if (!OpenCodeController) return {};
  // OpenCode controller 通过 HTTP API 工作，方法签名与 hermes 略有不同。
  // 这里只暴露 createController，handler 内部按需调用方法。
  return {
    createController: () => new OpenCodeController(),
  };
}

/** Kimi wrapper：与 hermes 同模式 */
function mapKimiWrapper(mod: Record<string, unknown>): WrapperModule {
  return mapControllerWrapper(mod, 'KimiController');
}

/** Pi wrapper */
function mapPiWrapper(mod: Record<string, unknown>): WrapperModule {
  return mapControllerWrapper(mod, 'PiController');
}

/** Aider wrapper */
function mapAiderWrapper(mod: Record<string, unknown>): WrapperModule {
  return mapControllerWrapper(mod, 'AiderController');
}

/** Amp wrapper */
function mapAmpWrapper(mod: Record<string, unknown>): WrapperModule {
  return mapControllerWrapper(mod, 'AmpController');
}

/** 通用 wrapper mapper：按后缀优先级扫描所有类导出 */
function mapGenericWrapper(mod: Record<string, unknown>): WrapperModule {
  // 优先级：*Controller > *Wrapper > *CliWrapper > *ApiWrapper
  const suffixes = ['Controller', 'Wrapper', 'CliWrapper', 'ApiWrapper'];
  for (const suffix of suffixes) {
    for (const id of Object.keys(mod)) {
      if (id.endsWith(suffix) && typeof mod[id] === 'function') {
        const result = mapControllerWrapper(mod, id);
        // 只在有 launch/inject/transferSession 之一时返回
        if (result.inject || result.launch || result.transferSession) {
          return result;
        }
      }
    }
  }
  return {};
}

/** 通用：把 controller 类映射为函数式 API（按 launch/inject/transferSession 方法签名探测） */
function mapControllerWrapper(
  mod: Record<string, unknown>,
  className: string,
): WrapperModule {
  const Controller = mod[className] as
    | (new () => {
        launch?: (
          prompt: string,
          opts?: { model?: string; cwd?: string },
        ) => { sessionId: string; response: string; exitCode: number } | Promise<{ sessionId: string; response: string; exitCode: number }>;
        inject?: (
          sessionId: string,
          message: string,
        ) => unknown;
        transferSession?: (
          sessionId: string,
          targetCli: string,
        ) => { handoffPrompt: string; session: unknown } | null;
      })
    | undefined;

  if (!Controller) return {};
  return {
    createController: () => new Controller(),
    launch: (prompt, opts) => {
      const c = new Controller();
      if (typeof c.launch !== 'function') {
        throw new Error(`${className} 不支持 launch`);
      }
      return c.launch(prompt, opts ?? {}) as { sessionId: string; response: string; exitCode: number };
    },
    inject: (sessionId, message) => {
      const c = new Controller();
      if (typeof c.inject !== 'function') {
        throw new Error(`${className} 不支持 inject`);
      }
      const raw = c.inject(sessionId, message);
      // 支持 sync 和 async
      if (raw instanceof Promise) {
        return raw.then((r) => normalizeInjectResult(r));
      }
      return normalizeInjectResult(raw);
    },
    transferSession: (sessionId, targetCli) => {
      const c = new Controller();
      if (typeof c.transferSession !== 'function') {
        throw new Error(`${className} 不支持 transferSession`);
      }
      return c.transferSession(sessionId, targetCli);
    },
  };
}

/**
 * 按 cli id 加载 wrapper 模块。未注册的 CLI 返回 null。
 */
export async function loadWrapper(cli: string): Promise<WrapperModule | null> {
  const loader = WRAPPER_LOADERS[cli];
  if (!loader) return null;
  try {
    return await loader();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. yondermesh_list_agents
// ---------------------------------------------------------------------------

const listAgentsHandler: McpToolHandler = async (args) => {
  const installedOnly = args.installed_only !== false; // default true

  const detect = await loadDetectAgents();
  if (detect) {
    const agents = detect();
    const filtered = installedOnly ? agents.filter((a) => a.installed) : agents;
    return jsonContent({ agents: filtered, count: filtered.length });
  }

  // 回退：基于 mount/registry 的 CLI_REGISTRY + detectInstalledClis 推导
  const home = homedir();
  const installed = detectInstalledClis(home).map((c) => c.id);
  const installedSet = new Set(installed);

  // 已知 wrapper 支持的 CLI 列表（与 WRAPPER_LOADERS 同步）
  const wrapperSupported = new Set(Object.keys(WRAPPER_LOADERS));

  const agents = CLI_REGISTRY.map((cli) => ({
    id: cli.id,
    displayName: cli.displayName,
    installed: installedSet.has(cli.id),
    coverage: 'B', // registry 只声明 mount 能力，覆盖等级未知，默认 B
    mountStrategies: cli.capabilities.map((cap) => cap.strategy),
    wrapperSupported: wrapperSupported.has(cli.id),
  }));

  const filtered = installedOnly ? agents.filter((a) => a.installed) : agents;
  return jsonContent({ agents: filtered, count: filtered.length });
};

// ---------------------------------------------------------------------------
// 2. yondermesh_query_sessions
// ---------------------------------------------------------------------------

const querySessionsHandler: McpToolHandler = async (args) => {
  const store = openStore();
  try {
    const query: SessionQuery = {};

    if (typeof args.source === 'string' && args.source) query.source = args.source;
    // args.search 暂未应用：store 当前无原生全文检索，留作未来扩展。
    if (typeof args.since === 'string') {
      const since = Date.parse(args.since);
      if (!Number.isNaN(since)) query.startedAtFrom = since;
    }
    if (typeof args.until === 'string') {
      const until = Date.parse(args.until);
      if (!Number.isNaN(until)) query.startedAtTo = until;
    }
    // include_subagents=false（默认）时仅返回 root session；true 时返回全部拓扑。
    if (args.include_subagents !== true) {
      query.topology = 'root';
    }

    const rawLimit = typeof args.limit === 'number' ? args.limit : 50;
    query.limit = Math.min(Math.max(1, rawLimit), 500);

    const sessions = store.querySessions(query);

    // 应用 offset（store 层未支持，在 handler 层切片）
    const offset =
      typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
    const paged = offset > 0 ? sessions.slice(offset) : sessions;

    const stats = store.getSessionStats(query);
    return jsonContent({ sessions: paged, stats, count: paged.length });
  } finally {
    store.close();
  }
};

// ---------------------------------------------------------------------------
// 3. yondermesh_get_session
// ---------------------------------------------------------------------------

const getSessionHandler: McpToolHandler = async (args) => {
  const sessionId = args.session_id;
  if (typeof sessionId !== 'string' || !sessionId) {
    return errorContent('缺少必填参数 session_id');
  }
  const format =
    typeof args.format === 'string' &&
    (args.format === 'json' || args.format === 'markdown')
      ? args.format
      : 'json';

  const store = openStore();
  try {
    const session = store.getSession(sessionId);
    if (!session) {
      return errorContent(`会话 ${sessionId} 不存在`);
    }
    const messages = store.getMessages(sessionId);

    if (format === 'markdown') {
      const lines: string[] = [];
      lines.push(`# Session ${session.id}`);
      lines.push('');
      lines.push(`- source: ${session.source}`);
      lines.push(`- topology: ${session.topology}`);
      if (session.cwd) lines.push(`- cwd: ${session.cwd}`);
      if (session.projectPath) lines.push(`- project: ${session.projectPath}`);
      if (session.model) lines.push(`- model: ${session.model}`);
      if (session.cliVersion) lines.push(`- cli: ${session.cliVersion}`);
      lines.push(
        `- messages: ${session.messageCount} (started ${session.startedAt ? new Date(session.startedAt).toISOString() : '?'})`,
      );
      lines.push('');
      lines.push('## Messages');
      lines.push('');
      for (const m of messages) {
        lines.push(`### ${m.role.toUpperCase()}`);
        lines.push(m.content);
        lines.push('');
      }
      return jsonContent({ markdown: lines.join('\n') });
    }

    return jsonContent({ session, messages });
  } finally {
    store.close();
  }
};

// ---------------------------------------------------------------------------
// 4. yondermesh_launch_agent
// ---------------------------------------------------------------------------

const launchAgentHandler: McpToolHandler = async (args) => {
  const cli = args.cli;
  const prompt = args.prompt;
  if (typeof cli !== 'string' || !cli) {
    return errorContent('缺少必填参数 cli');
  }
  if (typeof prompt !== 'string' || !prompt) {
    return errorContent('缺少必填参数 prompt');
  }

  const opts: { model?: string; cwd?: string } = {};
  if (typeof args.model === 'string' && args.model) opts.model = args.model;
  if (typeof args.cwd === 'string' && args.cwd) opts.cwd = args.cwd;

  const wrapper = await loadWrapper(cli);
  if (!wrapper) {
    return errorContent(
      `CLI "${cli}" 没有注册的 wrapper，无法 launch。已支持：${Object.keys(WRAPPER_LOADERS).join(', ')}`,
    );
  }
  if (typeof wrapper.launch !== 'function') {
    return errorContent(
      `CLI "${cli}" 的 wrapper 不支持 launch 操作（仅部分 wrapper 实现了 launch）`,
    );
  }

  try {
    const result = wrapper.launch(prompt, opts);
    return jsonContent({
      cli,
      sessionId: result.sessionId,
      response: result.response,
      exitCode: result.exitCode,
      launched: true,
    });
  } catch (err) {
    return errorContent(`launch 失败: ${String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// 5. yondermesh_inject_session
// ---------------------------------------------------------------------------

const injectSessionHandler: McpToolHandler = async (args) => {
  const cli = args.cli;
  const sessionId = args.session_id;
  const message = args.message;
  if (typeof cli !== 'string' || !cli) {
    return errorContent('缺少必填参数 cli');
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    return errorContent('缺少必填参数 session_id');
  }
  if (typeof message !== 'string' || !message) {
    return errorContent('缺少必填参数 message');
  }

  const wrapper = await loadWrapper(cli);
  if (!wrapper) {
    return errorContent(
      `CLI "${cli}" 没有注册的 wrapper，无法 inject。已支持：${Object.keys(WRAPPER_LOADERS).join(', ')}`,
    );
  }
  if (typeof wrapper.inject !== 'function') {
    return errorContent(
      `CLI "${cli}" 的 wrapper 不支持 inject 操作`,
    );
  }

  try {
    const result = await wrapper.inject(sessionId, message);
    return jsonContent({
      cli,
      sessionId,
      response: result.response,
      exitCode: result.exitCode,
      injected: true,
    });
  } catch (err) {
    return errorContent(`inject 失败: ${String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// 6. yondermesh_transfer_session
// ---------------------------------------------------------------------------

const transferSessionHandler: McpToolHandler = async (args) => {
  const sourceCli = args.source_cli;
  const sessionId = args.session_id;
  const targetCli = args.target_cli;
  if (typeof sourceCli !== 'string' || !sourceCli) {
    return errorContent('缺少必填参数 source_cli');
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    return errorContent('缺少必填参数 session_id');
  }
  if (typeof targetCli !== 'string' || !targetCli) {
    return errorContent('缺少必填参数 target_cli');
  }

  const wrapper = await loadWrapper(sourceCli);
  if (!wrapper) {
    return errorContent(
      `源 CLI "${sourceCli}" 没有注册的 wrapper。已支持：${Object.keys(WRAPPER_LOADERS).join(', ')}`,
    );
  }
  if (typeof wrapper.transferSession !== 'function') {
    return errorContent(
      `源 CLI "${sourceCli}" 的 wrapper 不支持 transferSession 操作`,
    );
  }

  try {
    const pkg = wrapper.transferSession(sessionId, targetCli);
    if (!pkg) {
      return errorContent(
        `找不到 session ${sessionId}，或源 CLI "${sourceCli}" 无法提取该 session`,
      );
    }

    // 可选：写入 handoff prompt 到文件
    const outputPath = args.output_path;
    if (typeof outputPath === 'string' && outputPath) {
      try {
        writeFileSync(outputPath, pkg.handoffPrompt, 'utf-8');
      } catch (err) {
        return errorContent(
          `handoff prompt 生成成功，但写入文件 ${outputPath} 失败: ${String(err)}`,
        );
      }
    }

    return jsonContent({
      sourceCli,
      targetCli,
      sessionId,
      handoffPrompt: pkg.handoffPrompt,
      session: pkg.session,
      outputPath: typeof outputPath === 'string' ? outputPath : null,
      transferred: true,
    });
  } catch (err) {
    return errorContent(`transfer 失败: ${String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// 7. yondermesh_mount_status
// ---------------------------------------------------------------------------

const mountStatusHandler: McpToolHandler = async (args) => {
  const cli = typeof args.cli === 'string' ? args.cli : undefined;

  const statuses = verifyAll();
  // 过滤掉 unsupported（CLI 不支持的扩展）
  const visible = statuses.filter((s) => s.strategy !== 'unsupported');
  if (cli) {
    const filtered = visible.filter((s) => s.cli === cli);
    if (filtered.length === 0) {
      return errorContent(
        `CLI "${cli}" 没有挂载状态记录（可能未安装或未注册）`,
      );
    }
    return jsonContent({ cli, mounts: filtered });
  }

  // 按 cli 分组
  const byCli: Record<string, typeof visible> = {};
  for (const s of visible) {
    if (!byCli[s.cli]) byCli[s.cli] = [];
    byCli[s.cli]!.push(s);
  }
  return jsonContent({ mounts: visible, byCli, count: visible.length });
};

// ---------------------------------------------------------------------------
// 8. yondermesh_mailbox_check
//
// 消费 mailbox：返回 self 的未读消息 + daemon 推送的 tray 通知。
// mark_read=true 时读后自动标记已读（pop 语义）；false 时只 peek。
// ---------------------------------------------------------------------------

const mailboxCheckHandler: McpToolHandler = async (args) => {
  const explicitSid = typeof args.self_session_id === 'string' ? args.self_session_id : undefined;
  const markRead = args.mark_read !== false; // 默认 true（pop 语义，与 MCP 习惯一致）

  const mailbox = openMailbox();
  try {
    const selfSid = mailbox.resolveSelfSession({ explicit: explicitSid });
    if (!selfSid) {
      return errorContent(
        '无法解析 self session id。请通过 self_session_id 显式传入，或设置 YONDERMESH_SELF_SESSION_ID 环境变量，或在已入库的 session 对应的 cwd 下调用。',
      );
    }

    const trayNotices = mailbox.consumeTray(selfSid);
    const messages = markRead
      ? mailbox.popMessages({ forSessionId: selfSid, unreadOnly: true, limit: 50 })
      : mailbox.peekMessages({ forSessionId: selfSid, unreadOnly: true, limit: 50 });
    const unread = mailbox.countUnread(selfSid);

    return jsonContent({
      sessionId: selfSid,
      markRead,
      unread,
      trayNotices,
      messages,
      hint:
        unread.total > 0
          ? `📬 你有 ${unread.total} 条未读消息（direct ${unread.direct}, broadcast ${unread.broadcast}）。处理后可调 yondermesh_mailbox_post 回复。`
          : '📭 暂无未读消息',
    });
  } finally {
    mailbox.close();
  }
};

// ---------------------------------------------------------------------------
// 9. yondermesh_mailbox_post
//
// 投递消息到另一个 session 或项目广播。
// ---------------------------------------------------------------------------

const mailboxPostHandler: McpToolHandler = async (args) => {
  const body = args.body;
  if (typeof body !== 'string' || !body) {
    return errorContent('缺少必填参数 body');
  }
  const toSessionId = typeof args.to_session_id === 'string' ? args.to_session_id : undefined;
  const toProject = typeof args.to_project === 'string' ? args.to_project : undefined;
  if (!toSessionId && !toProject) {
    return errorContent('to_session_id 与 to_project 至少需要一个');
  }

  const input: PostMessageInput = {
    toSessionId,
    toProject,
    fromSessionId: typeof args.from_session_id === 'string' ? args.from_session_id : undefined,
    body,
    kind: typeof args.kind === 'string' ? (args.kind as PostMessageInput['kind']) : undefined,
    priority: typeof args.priority === 'string' ? (args.priority as PostMessageInput['priority']) : undefined,
    expiresAt: typeof args.expires_in_seconds === 'number' && args.expires_in_seconds > 0
      ? Date.now() + args.expires_in_seconds * 1000
      : undefined,
    threadId: typeof args.thread_id === 'string' ? args.thread_id : undefined,
  };

  const mailbox = openMailbox();
  try {
    const id = mailbox.postMessage(input);
    return jsonContent({ messageId: id, posted: true });
  } catch (err) {
    return errorContent(`投递失败: ${String(err)}`);
  } finally {
    mailbox.close();
  }
};

// ---------------------------------------------------------------------------
// 10. yondermesh_mailbox_reply
//
// 回复某条消息：自动派生 thread_id，from_session_id 可选。
// ---------------------------------------------------------------------------

const mailboxReplyHandler: McpToolHandler = async (args) => {
  const replyToId = args.reply_to_id;
  if (typeof replyToId !== 'number' || !replyToId) {
    return errorContent('缺少必填参数 reply_to_id');
  }
  const body = args.body;
  if (typeof body !== 'string' || !body) {
    return errorContent('缺少必填参数 body');
  }

  const mailbox = openMailbox();
  try {
    const parent = mailbox.getMessage(replyToId);
    if (!parent) {
      return errorContent(`被回复的消息不存在: ${replyToId}`);
    }

    const input: PostMessageInput = {
      toSessionId: parent.fromSessionId ?? undefined,
      toProject: parent.toProject ?? undefined,
      fromSessionId: typeof args.from_session_id === 'string' ? args.from_session_id : undefined,
      body,
      kind: typeof args.kind === 'string' ? (args.kind as PostMessageInput['kind']) : undefined,
      priority: typeof args.priority === 'string' ? (args.priority as PostMessageInput['priority']) : undefined,
      replyToId,
      threadId: parent.threadId ?? `thread-${parent.id}`,
    };

    const id = mailbox.postMessage(input);
    return jsonContent({ messageId: id, posted: true, threadId: input.threadId });
  } catch (err) {
    return errorContent(`回复失败: ${String(err)}`);
  } finally {
    mailbox.close();
  }
};

// ---------------------------------------------------------------------------
// 11. yondermesh_whoami
//
// 解析当前调用方的 self session id。三层降级：
//   1. env YONDERMESH_SELF_SESSION_ID
//   2. self_session_id arg
//   3. cwd 匹配最近 live session
// ---------------------------------------------------------------------------

const whoamiHandler: McpToolHandler = async (args) => {
  const explicitSid = typeof args.self_session_id === 'string' ? args.self_session_id : undefined;

  const mailbox = openMailbox();
  try {
    const selfSid = mailbox.resolveSelfSession({ explicit: explicitSid });
    if (!selfSid) {
      return jsonContent({
        sessionId: null,
        resolved: false,
        hint: '无法解析 self session id。可通过 self_session_id 显式传入，或设置 YONDERMESH_SELF_SESSION_ID 环境变量（需 wrapper 注入），或确保当前 cwd 有匹配的活跃 session。',
      });
    }
    const unread = mailbox.countUnread(selfSid);
    return jsonContent({
      sessionId: selfSid,
      resolved: true,
      unread,
      hint: unread.total > 0
        ? `📬 你有 ${unread.total} 条未读消息，调 yondermesh_mailbox_check 消费`
        : '📭 暂无未读消息',
    });
  } finally {
    mailbox.close();
  }
};

// ---------------------------------------------------------------------------
// 12. yondermesh_send
//
// v3 同步注入：把 user message 立刻投递到目标 agent CLI session，
// 并同步拿到 agent 的回复。MailboxCore.send() 内部依次执行：
//   审计写入 → TriggerAdapter.trigger() → ReplyAdapter.extractReply()
//   → 审计写入回复 → 返回 SendResult
// 即使目标 agent 未配置 model 或认证失败，也会返回错误消息（而非 hang）。
// ---------------------------------------------------------------------------

const sendHandler: McpToolHandler = async (args) => {
  const cli = typeof args.cli === 'string' ? args.cli : '';
  const message = typeof args.message === 'string' ? args.message : '';
  if (!cli) {
    return errorContent('缺少必填参数 cli');
  }
  if (!message) {
    return errorContent('缺少必填参数 message');
  }

  const rawMode = typeof args.mode === 'string' ? args.mode : 'new';
  if (rawMode !== 'stopped' && rawMode !== 'running' && rawMode !== 'new') {
    return errorContent(`无效 mode: ${rawMode}（合法: stopped | running | new）`);
  }
  const sessionId = typeof args.session_id === 'string' ? args.session_id : undefined;
  if ((rawMode === 'stopped' || rawMode === 'running') && !sessionId) {
    return errorContent(`${rawMode} 模式需要 session_id`);
  }

  const target: SendTarget = {
    cli,
    sessionId,
    mode: rawMode as SendMode,
    message,
    model: typeof args.model === 'string' ? args.model : undefined,
    effort: typeof args.effort === 'string' ? args.effort : undefined,
    cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
    timeoutMs: typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : undefined,
    fromSessionId: typeof args.from_session_id === 'string' ? args.from_session_id : undefined,
  };

  const mailbox = openMailbox();
  try {
    const result = await mailbox.send(target);
    return jsonContent({
      cli,
      mode: rawMode,
      ...result,
    });
  } catch (err) {
    return errorContent(`send 失败: ${String(err)}`);
  } finally {
    mailbox.close();
  }
};

// ---------------------------------------------------------------------------
// 工具注册表
// ---------------------------------------------------------------------------

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'yondermesh_list_agents',
    description:
      'List all detected AI agent CLIs on this machine, including their installation status, collection level, mount capabilities, and wrapper support.',
    inputSchema: {
      type: 'object',
      properties: {
        installed_only: {
          type: 'boolean',
          description: 'Only return installed agents',
          default: true,
        },
      },
    },
    handler: listAgentsHandler,
  },
  {
    name: 'yondermesh_query_sessions',
    description:
      'Query sessions from the yondermesh session store. Supports filtering by source CLI, time range, and text search.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Filter by source CLI (e.g., "claude", "codex", "hermes")',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 50)',
          default: 50,
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination',
          default: 0,
        },
        search: {
          type: 'string',
          description: 'Full-text search in session content',
        },
        since: {
          type: 'string',
          description: 'ISO date - only sessions after this date',
        },
        until: {
          type: 'string',
          description: 'ISO date - only sessions before this date',
        },
        include_subagents: {
          type: 'boolean',
          description: 'Include subagent sessions',
          default: false,
        },
      },
    },
    handler: querySessionsHandler,
  },
  {
    name: 'yondermesh_get_session',
    description:
      'Get detailed content of a specific session, including all messages, tool calls, and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID to retrieve',
        },
        format: {
          type: 'string',
          enum: ['json', 'markdown'],
          description: 'Output format',
          default: 'json',
        },
      },
      required: ['session_id'],
    },
    handler: getSessionHandler,
  },
  {
    name: 'yondermesh_launch_agent',
    description:
      'Launch a new session on a specified agent CLI. The agent will process the given prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: {
          type: 'string',
          description: 'Target CLI (e.g., "hermes", "opencode", "pi")',
        },
        prompt: {
          type: 'string',
          description: 'The task/prompt to send to the agent',
        },
        model: {
          type: 'string',
          description: 'Model to use (optional, defaults to agent config)',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (optional)',
        },
      },
      required: ['cli', 'prompt'],
    },
    handler: launchAgentHandler,
  },
  {
    name: 'yondermesh_inject_session',
    description:
      'Inject a message into a running agent session. This allows mid-task intervention and steering.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: {
          type: 'string',
          description: 'Source CLI (e.g., "hermes", "kimi")',
        },
        session_id: {
          type: 'string',
          description: 'The running session ID to inject into',
        },
        message: {
          type: 'string',
          description: 'The message to inject',
        },
      },
      required: ['cli', 'session_id', 'message'],
    },
    handler: injectSessionHandler,
  },
  {
    name: 'yondermesh_transfer_session',
    description:
      'Extract a session from one agent and prepare it for handoff to another agent. Generates a neutral handoff prompt that the target agent can consume.',
    inputSchema: {
      type: 'object',
      properties: {
        source_cli: {
          type: 'string',
          description: 'Source CLI (e.g., "aider")',
        },
        session_id: {
          type: 'string',
          description: 'Session ID to transfer',
        },
        target_cli: {
          type: 'string',
          description: 'Target CLI (e.g., "hermes")',
        },
        output_path: {
          type: 'string',
          description: 'Write handoff prompt to file (optional)',
        },
      },
      required: ['source_cli', 'session_id', 'target_cli'],
    },
    handler: transferSessionHandler,
  },
  {
    name: 'yondermesh_mount_status',
    description: 'Check which agents have yondermesh MCP/Skills/Always-on mounted.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: {
          type: 'string',
          description: 'Check specific CLI (optional, omit for all)',
        },
      },
    },
    handler: mountStatusHandler,
  },
  {
    name: 'yondermesh_mailbox_check',
    description:
      '(legacy v2, prefer yondermesh_send for sync delivery) Check your mailbox for unread messages from other agents. Resolves your own session id via 3-layer fallback (env YONDERMESH_SELF_SESSION_ID → self_session_id arg → cwd match). Returns unread messages, tray notices (push notifications from daemon), and unread count. By default marks messages as read (pop); set mark_read=false to peek without marking.',
    inputSchema: {
      type: 'object',
      properties: {
        self_session_id: {
          type: 'string',
          description: 'Explicitly pass your own session id (fallback when env var is not set)',
        },
        mark_read: {
          type: 'boolean',
          description: 'Mark returned messages as read (default true). Set false to peek.',
          default: true,
        },
      },
    },
    handler: mailboxCheckHandler,
  },
  {
    name: 'yondermesh_mailbox_post',
    description:
      '(legacy v2, prefer yondermesh_send for sync delivery) Post a message to another agent session or broadcast to a project. The target agent can read it via yondermesh_mailbox_check. Supports priority, expiry, threading, and message kinds (info/warning/question/task_update).',
    inputSchema: {
      type: 'object',
      properties: {
        to_session_id: { type: 'string', description: 'Target session id (direct message)' },
        to_project: { type: 'string', description: 'Target project path (broadcast to all agents in that project)' },
        from_session_id: { type: 'string', description: 'Sender session id (optional)' },
        body: { type: 'string', description: 'Message body' },
        kind: {
          type: 'string',
          enum: ['info', 'warning', 'question', 'task_update'],
          description: 'Message kind',
          default: 'info',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'Priority',
          default: 'normal',
        },
        expires_in_seconds: {
          type: 'number',
          description: 'TTL in seconds; message auto-deleted after expiry',
        },
        thread_id: { type: 'string', description: 'Thread id (optional; auto-derived when using yondermesh_mailbox_reply)' },
      },
      required: ['body'],
    },
    handler: mailboxPostHandler,
  },
  {
    name: 'yondermesh_mailbox_reply',
    description:
      '(legacy v2, prefer yondermesh_send for sync delivery) Reply to a specific message. Auto-derives thread_id from the parent message (uses parent.thread_id or falls back to thread-<parent_id>). Routes the reply to the original sender (to_session_id = parent.from_session_id) or original project (to_project = parent.to_project).',
    inputSchema: {
      type: 'object',
      properties: {
        reply_to_id: { type: 'number', description: 'Message id being replied to' },
        body: { type: 'string', description: 'Reply body' },
        from_session_id: { type: 'string', description: 'Sender session id (optional)' },
        kind: {
          type: 'string',
          enum: ['info', 'warning', 'question', 'task_update'],
          description: 'Message kind',
          default: 'info',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'Priority',
          default: 'normal',
        },
      },
      required: ['reply_to_id', 'body'],
    },
    handler: mailboxReplyHandler,
  },
  {
    name: 'yondermesh_whoami',
    description:
      'Resolve your own session id via 3-layer fallback: (1) env YONDERMESH_SELF_SESSION_ID, (2) self_session_id arg, (3) match cwd against recently active sessions in the store. Also reports your current unread message count. Use this at the start of any task to know who you are and whether other agents have sent you messages.',
    inputSchema: {
      type: 'object',
      properties: {
        self_session_id: {
          type: 'string',
          description: 'Explicitly pass your session id (fallback when env var is not set)',
        },
      },
    },
    handler: whoamiHandler,
  },
  {
    name: 'yondermesh_send',
    description:
      'Synchronously send a user message to a target agent CLI session and return the agent\'s reply. Supports 3 modes: stopped (resume a stopped session with message), running (inject into running session), new (create a new session). Backed by MailboxCore.send() (v3 sync injection): audit-writes the user message, calls TriggerAdapter to deliver it to the target CLI, calls ReplyAdapter to extract the cleaned reply text, then audit-writes the reply. Even if the target agent has no model configured or auth fails, returns an error message instead of hanging.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: {
          type: 'string',
          description: 'Target CLI id (e.g. "hermes", "claude", "opencode", "trae-ide")',
        },
        session_id: {
          type: 'string',
          description: 'Target session id. Required for stopped/running modes; ignored for new mode.',
        },
        mode: {
          type: 'string',
          enum: ['stopped', 'running', 'new'],
          description: 'Delivery mode. Default "new".',
          default: 'new',
        },
        message: {
          type: 'string',
          description: 'User message to inject into the target agent session.',
        },
        model: {
          type: 'string',
          description: 'Model id for new sessions (e.g. "gpt-4o", "claude-sonnet-4"). Optional.',
        },
        effort: {
          type: 'string',
          description: 'Effort level for new sessions (e.g. "low" / "medium" / "high"). Optional.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the target session. Optional.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds. Default 60000.',
        },
        from_session_id: {
          type: 'string',
          description: 'Sender session id (for audit trail). Optional.',
        },
      },
      required: ['cli', 'message'],
    },
    handler: sendHandler,
  },
];

// ---------------------------------------------------------------------------
// 工具查找辅助
// ---------------------------------------------------------------------------

/** 按名称查找工具定义，未找到返回 undefined */
export function findTool(name: string): McpToolDef | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

/** 返回所有工具的 {name, description, inputSchema} 列表（不含 handler，用于 tools/list 响应） */
export function listToolSchemas(): Array<{
  name: string;
  description: string;
  inputSchema: object;
}> {
  return MCP_TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}
