/**
 * Trigger 层 — 向 agent session 注入 user message 的统一适配层
 *
 * 架构分层（用户要求）：
 *   消息层 (MailboxCore) → 适配层 (TriggerAdapter + ReplyAdapter) → 各 CLI
 *
 * 适配层职责：
 *   - TriggerAdapter: 把 user message 注入到目标 agent session
 *   - ReplyAdapter: 从 agent 获取回复内容
 *
 * 3 种触发模式：
 *   - stopped: 停止 session → spawn --resume 带 message → 等执行完返回 response
 *   - running: 向运行中的 session stdin/API 注入 message
 *   - new: 创建新 session，支持指定 model 和 effort
 *
 * 6 种触发通道：
 *   - cli-spawn: spawnSync `<cli> --resume <sid> <msg_flag> <msg>`
 *   - stdin: 找到运行中进程 → write stdin
 *   - http-api: HTTP POST 到 agent 的 API endpoint
 *   - ws-rpc: WebSocket/JSON-RPC 调用
 *   - tmux: tmux send-keys 模拟键盘输入（IDE 类）
 *   - applescript: macOS AppleScript 发 keystroke（IDE 备用）
 */

/** 触发模式 */
export type TriggerMode = 'stopped' | 'running' | 'new';

/** 触发通道 */
export type TriggerChannel =
  | 'cli-spawn'
  | 'stdin'
  | 'http-api'
  | 'ws-rpc'
  | 'tmux'
  | 'applescript';

/** 触发请求 */
export interface TriggerRequest {
  /** CLI ID（如 hermes / opencode / trae-ide） */
  cli: string;
  /** 目标 session ID（stopped/running 模式需要，new 模式忽略） */
  sessionId?: string;
  /** 要注入的 user message */
  message: string;
  /** 触发模式 */
  mode: TriggerMode;
  /** 新 session 指定 model（new 模式） */
  model?: string;
  /** 新 session 指定 effort（new 模式，如 low/medium/high） */
  effort?: string;
  /** 工作目录 */
  cwd?: string;
  /** 超时毫秒，默认 60000 */
  timeoutMs?: number;
}

/** 触发结果 */
export interface TriggerResult {
  /** 是否成功投递 */
  delivered: boolean;
  /** agent 的回复文本 */
  response: string;
  /** 进程退出码（cli-spawn 模式） */
  exitCode?: number;
  /** 使用的触发通道 */
  channel: TriggerChannel;
  /** 耗时毫秒 */
  latencyMs: number;
  /** 新 session 的 ID（new 模式） */
  newSessionId?: string;
  /** 错误信息 */
  error?: string;
}

/** ReplyAdapter 结果 */
export interface ReplyResult {
  /** 回复内容 */
  text: string;
  /** 回复来源 */
  source: 'stdout' | 'api' | 'file' | 'tmux-capture';
  /** 获取耗时 */
  latencyMs: number;
}

/**
 * CLI 能力描述：每个 CLI 支持的触发模式 + 通道
 */
export interface CliTriggerCapability {
  cli: string;
  /** 支持的模式 */
  modes: TriggerMode[];
  /** 主通道 */
  primaryChannel: TriggerChannel;
  /** 备用通道 */
  fallbackChannel?: TriggerChannel;
  /** 是否已安装 */
  installed: boolean;
  /** wrapper 是否支持 inject */
  wrapperInject: boolean;
  /** 备注 */
  notes?: string;
}
