/**
 * OpenHands HTTP API Wrapper
 *
 * OpenHands 已转型为 HTTP 服务器架构（FastAPI + uvicorn，99 endpoints + /sockets WebSocket）。
 * 本 wrapper 封装任务接入所需的核心 HTTP 操作：launch / inject / interrupt / fork / pause / run。
 *
 * 架构要点：
 *   - 服务器默认监听 http://localhost:3000（可配置 OPENHANDS_HOST/PORT）
 *   - 所有写操作走 REST；实时事件流走 /sockets WebSocket（本 wrapper 仅封装 REST，
 *     WebSocket 由调用方按需接入）
 *   - 6 个 lifecycle hooks 通过 HTTP 回调注入（见 inject.ts）
 *   - 中途介入：POST /api/conversations/{id}/interrupt；分叉：/fork；暂停/继续：/pause /run
 *
 * 设计原则：
 *   - 零外部依赖，使用 Node 20+ 全局 fetch
 *   - 所有方法返回 { ok, status, data?, error? } 统一形态
 *   - 服务器不可达时返回 ok=false（不抛出），便于上层降级
 */

/** Wrapper 配置 */
export interface OpenHandsWrapperOptions {
  /** 服务器 base URL，默认 http://localhost:3000 */
  baseUrl?: string;
  /** 请求超时毫秒，默认 30000 */
  timeoutMs?: number;
  /** 可选 API token（若服务器启用鉴权） */
  apiToken?: string;
}

/** 统一响应形态 */
export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/** launch 创建会话输入 */
export interface LaunchConversationInput {
  /** 工作仓库 URL 或本地路径 */
  repository?: string;
  /** 初始用户指令 */
  initialUserMsg?: string;
  /** LLM 模型，GLM-5.2 用 `anthropic/glm-5.2` 前缀 */
  llmModel?: string;
  /** agent 类型，默认 codeact */
  agent?: string;
  /** max iterations */
  maxIterations?: number;
}

/** launch 创建会话结果 */
export interface LaunchedConversation {
  conversationId: string;
}

/** 默认 base URL，支持环境变量覆盖 */
function resolveBaseUrl(opts: OpenHandsWrapperOptions): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/+$/, '');
  const host = process.env.OPENHANDS_HOST ?? 'localhost';
  const port = process.env.OPENHANDS_PORT ?? '3000';
  return `http://${host}:${port}`;
}

/**
 * OpenHands HTTP API wrapper。
 *
 * 用法：
 *   const api = new OpenHandsApiWrapper({ baseUrl: 'http://localhost:3000' });
 *   const { data } = await api.launch({ initialUserMsg: 'hello', llmModel: 'anthropic/glm-5.2' });
 */
export class OpenHandsApiWrapper {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiToken?: string;

  constructor(options: OpenHandsWrapperOptions = {}) {
    this.baseUrl = resolveBaseUrl(options);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.apiToken = options.apiToken ?? process.env.OPENHANDS_API_TOKEN;
  }

  /**
   * 创建并启动一个新 conversation（POST /api/conversations）。
   * GLM-5.2 通过 llmModel='anthropic/glm-5.2' 接入。
   */
  async launch(input: LaunchConversationInput): Promise<ApiResult<LaunchedConversation>> {
    const body: Record<string, unknown> = {};
    if (input.repository) body.repository = input.repository;
    if (input.initialUserMsg) body.initial_user_msg = input.initialUserMsg;
    if (input.llmModel) body.llm_model = input.llmModel;
    if (input.agent) body.agent = input.agent;
    if (input.maxIterations !== undefined) body.max_iterations = input.maxIterations;

    const res = await this.request<LaunchedConversation>('POST', '/api/conversations', body);
    // 服务器返回 { conversation_id } → 归一化为 conversationId
    if (res.ok && res.data) {
      const raw = res.data as unknown as { conversation_id?: string; conversationId?: string };
      const id = raw.conversation_id ?? raw.conversationId;
      if (id) res.data = { conversationId: id };
    }
    return res;
  }

  /**
   * 向一个已存在的 conversation 注入用户消息（POST /api/conversations/{id}/messages）。
   * 用于 yondermesh 的跨 agent 注入。
   */
  async inject(conversationId: string, message: string, waitForResponse = false): Promise<ApiResult> {
    return this.request('POST', `/api/conversations/${conversationId}/messages`, {
      message,
      waitForResponse,
    });
  }

  /**
   * 中途介入：中断正在运行的 conversation（POST /api/conversations/{id}/interrupt）。
   * 触发后 agent 会停止当前 step，等待新指令。
   */
  async interrupt(conversationId: string): Promise<ApiResult> {
    return this.request('POST', `/api/conversations/${conversationId}/interrupt`);
  }

  /**
   * 分叉一个 conversation（POST /api/conversations/{id}/fork）。
   * 创建一个从当前状态出发的新 conversation，原 conversation 保留。
   */
  async fork(conversationId: string): Promise<ApiResult<LaunchedConversation>> {
    const res = await this.request<LaunchedConversation>('POST', `/api/conversations/${conversationId}/fork`);
    if (res.ok && res.data) {
      const raw = res.data as unknown as { conversation_id?: string; new_conversation_id?: string };
      const id = raw.conversation_id ?? raw.new_conversation_id;
      if (id) res.data = { conversationId: id };
    }
    return res;
  }

  /**
   * 暂停一个正在运行的 conversation（POST /api/conversations/{id}/pause）。
   * 与 run 配对使用，实现可控的执行/暂停切换。
   */
  async pause(conversationId: string): Promise<ApiResult> {
    return this.request('POST', `/api/conversations/${conversationId}/pause`);
  }

  /**
   * 恢复一个已暂停的 conversation（POST /api/conversations/{id}/run）。
   */
  async run(conversationId: string): Promise<ApiResult> {
    return this.request('POST', `/api/conversations/${conversationId}/run`);
  }

  /**
   * 获取 conversation 状态（GET /api/conversations/{id}）。
   */
  async getStatus(conversationId: string): Promise<ApiResult> {
    return this.request('GET', `/api/conversations/${conversationId}`);
  }

  /**
   * 列出所有 conversation（GET /api/conversations）。
   */
  async listConversations(): Promise<ApiResult> {
    return this.request('GET', '/api/conversations');
  }

  /** 探测服务器是否可达（GET /health，2xx/4xx 均视为可达，仅网络错误视为不可达） */
  async ping(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(this.timeoutMs, 5_000));
      await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      return true;
    } catch {
      return false;
    }
  }

  // ─── 内部 ─────────────────────────────────────────────────────────────

  /** 统一请求封装：超时 / 鉴权头 / 错误归一化 */
  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const status = res.status;
      let data: unknown = undefined;
      const text = await res.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (res.ok) {
        return { ok: true, status, data: data as T };
      }
      return {
        ok: false,
        status,
        error: typeof data === 'string' ? data : JSON.stringify(data ?? `HTTP ${status}`),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}
