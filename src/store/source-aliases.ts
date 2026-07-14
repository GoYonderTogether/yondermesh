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

  // Kimi
  'kimi': 'kimi',

  // Cursor
  'cursor': 'cursor',

  // Copilot
  'copilot': 'copilot',
  'copilot_cli': 'copilot',
  'copilot-cli': 'copilot',

  // Gemini
  'gemini': 'gemini',

  // OpenClaw
  'openclaw': 'openclaw',
  'openclaw/main': 'openclaw',

  // Aider
  'aider': 'aider',

  // Trae
  'trae': 'trae',

  // Windsurf
  'windsurf': 'windsurf',
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
