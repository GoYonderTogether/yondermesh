/**
 * Source 名称归一化
 *
 * 问题：cass 从数据库读到的 agent slug（如 claude_code）与原生导入器
 * 写入的 source（如 claude-code）不一致，导致 --source 过滤不到数据。
 *
 * 方案：
 *   1. 导入时调用 normalizeSource() 统一为 canonical 名称
 *   2. 查询时调用 expandSource() 把用户输入展开为所有已知别名
 *
 * 向后兼容：旧数据中的非 canonical 名称通过查询展开找到。
 * 未来重新 scan 后新数据自动归一化。
 */

/** 已知的 source 别名 → canonical 映射 */
const SOURCE_MAP: Record<string, string> = {
  // Claude Code
  'claude': 'claude',
  'claude-code': 'claude',
  'claude_code': 'claude',
  'claudecode': 'claude',

  // Codex
  'codex': 'codex',

  // OpenCode
  'opencode': 'opencode',
  'open-code': 'opencode',
  'open_code': 'opencode',

  // Hermes
  'hermes': 'hermes',
  'hermes-agent': 'hermes',
  'hermes_agent': 'hermes',
  'hermesagent': 'hermes',

  // Kimi
  'kimi': 'kimi',

  // Cursor（CLI 占位，未来 native adapter）
  'cursor': 'cursor',

  // Cursor IDE（GUI，B 级兼容 importer —— 从 state.vscdb 提取）
  'cursor-ide': 'cursor-ide',
  'cursor_ide': 'cursor-ide',
  'cursoride': 'cursor-ide',

  // Copilot（CLI 与 SDK 共用 canonical 名称，CLI/SDK 区分走 originator/entrySource）
  'copilot': 'copilot',
  'copilot_cli': 'copilot',
  'copilot-cli': 'copilot',
  'copilot_sdk': 'copilot',
  'copilot-sdk': 'copilot',

  // Gemini
  'gemini': 'gemini',
  'gemini-cli': 'gemini',
  'gemini_cli': 'gemini',

  // Qwen Code
  'qwen': 'qwen',
  'qwen-code': 'qwen',
  'qwen_code': 'qwen',
  'qwencode': 'qwen',

  // OpenClaw
  'openclaw': 'openclaw',
  'openclaw/main': 'openclaw',

  // Aider
  'aider': 'aider',

  // Trae（CLI 占位，未来 native adapter）
  'trae': 'trae',

  // Trae IDE（GUI，B 级兼容 importer —— 从 JSONL 摘要提取；SQLCipher 破解失败）
  'trae-ide': 'trae-ide',
  'trae_ide': 'trae-ide',
  'traeide': 'trae-ide',

  // trae-cli（字节跳动 trae-agent CLI，与 Trae IDE 的 'trae' 严格区分）
  'trae_cli': 'trae_cli',
  'trae-cli': 'trae_cli',
  'traecli': 'trae_cli',

  // Amp（Sourcegraph，SaaS；ampcode 为产品域名别名）
  'amp': 'amp',
  'ampcode': 'amp',

  // ChatGPT Desktop（OpenAI Codex 合并版 app，SaaS only）
  'chatgpt': 'chatgpt',
  'chatgpt-desktop': 'chatgpt',
  'chatgpt_desktop': 'chatgpt',

  // Windsurf
  'windsurf': 'windsurf',

  // Pi Agent 家族（Pi / oh-my-pi / gsd-pi，共享 JSONL v3 树结构 + RPC steer）
  // 三个 CLI 共享同一 importer，通过配置目录路径区分 source。
  'pi': 'pi',
  'pi_agent': 'pi',
  'pi-agent': 'pi',
  'omp': 'omp',
  'oh_my_pi': 'omp',
  'oh-my-pi': 'omp',
  'ohmyopi': 'omp',
  'gsd-pi': 'gsd-pi',
  'gsd_pi': 'gsd-pi',
  'gsd': 'gsd-pi',

  // OpenHands（HTTP 服务器架构，agent-server CLI）
  'openhands': 'openhands',
  'open-hands': 'openhands',
  'open_hands': 'openhands',
  'openhands-agent': 'openhands',

  // Goose（Block）
  'goose': 'goose',

  // Antigravity（Google IDE，agy CLI）
  'antigravity': 'antigravity',
  'antigravity-cli': 'antigravity',
  'agy': 'antigravity',

  // Factory Droid（Factory AI，CLI: droid）
  'factory': 'factory',
  'factory_droid': 'factory',
  'factory-droid': 'factory',
  'droid': 'factory',

  // Vibe（Mistral AI，CLI: vibe）
  'vibe': 'vibe',

  // WorkBuddy / CodeBuddy（Tencent，CLI: cbc）
  'codebuddy': 'codebuddy',
  'cbc': 'codebuddy',
  'workbuddy': 'codebuddy',

  // Cline（多形态 CLI + VS Code + SDK，coverage=A；双轨 sessions.db + JSON transcript）
  'cline': 'cline',
  'cline-cli': 'cline',
  'cline_cli': 'cline',
  'clinecli': 'cline',

  // Crush（Charm，项目级 SQLite <cwd>/.crush/crush.db，coverage=A）
  'crush': 'crush',
  'crush-cli': 'crush',
  'crush_cli': 'crush',
  'crushcli': 'crush',

  // Continue（@continuedev/cli，二进制名 `cn`，coverage=A）
  'continue': 'continue',
  'cn': 'continue',
  'continue_cli': 'continue',
  'continue-cli': 'continue',
  'continuecli': 'continue',
  'continuedev': 'continue',
};

/**
 * 归一化 source 名称为 canonical 形式。
 * 未知 source 原样返回（不丢失信息）。
 */
export function normalizeSource(raw: string): string {
  const lower = raw.toLowerCase();
  return SOURCE_MAP[lower] ?? raw;
}

/**
/** UUID 正则：用于从 native_session_id 中提取规范 ID 做跨源匹配 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * 从 native_session_id 提取规范 ID（UUID）。
 * cass 的 external_id 形如 `-Users-zoran/projects/UUID.jsonl`，
 * 原生 adapter 直接用 UUID，通过提取 UUID 可做跨源匹配。
 * 不含 UUID 时返回原始值。
 */
export function extractCanonicalId(nativeSessionId: string): string {
  const m = nativeSessionId.match(UUID_RE);
  return m ? m[0]!.toLowerCase() : nativeSessionId;
}

/**
 * 生成跨源去重匹配键：normalized_source + canonical_id。
 * 同一个物理 session 被 cass (B) 和原生 adapter (A) 各导入一次时，
 * 两者的 matchKey 相同，即可判定为重复。
 */
export function sessionMatchKey(source: string, nativeSessionId: string): string {
  return `${normalizeSource(source)}:${extractCanonicalId(nativeSessionId)}`;
}

/**
* 反向查找：给定 canonical 名称，返回所有已知别名。
 * 用于查询时展开 --source 参数。
 */
export function expandSource(canonical: string): string[] {
  const lower = canonical.toLowerCase();
  const normalized = SOURCE_MAP[lower] ?? lower;
  const aliases = new Set<string>([normalized]);

  for (const [alias, canonical_] of Object.entries(SOURCE_MAP)) {
    if (canonical_ === normalized) {
      aliases.add(alias);
    }
  }

  return [...aliases];
}
