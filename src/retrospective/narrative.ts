/**
 * narrative.ts — markdown 骨架生成（loop build-retrospective §C）
 *
 * 不变式（loop §3 行动约束）：
 *   - 纯函数：输入 RetrospectiveFact，输出 markdown 字符串
 *   - 零 LLM：纯模板拼装（ARCHITECTURE §III.6 内核零 LLM）
 *   - 5 段骨架：背景 / 工具调用路径 / 弯路 / 用户故事模板 / 抽象能力建议
 *   - 用户故事段预留 <FILL: ...> 槽位，由 agent LLM 后续填充
 *
 * 本模块只做「骨架渲染」，不做总结/归纳/润色——那是 LLM 层的职责。
 */

import type { RetrospectiveFact } from './generator.js';

/** 模板段落标题（5 段，固定顺序） */
export const NARRATIVE_SECTIONS = [
  '## 1. 背景',
  '## 2. 工具调用路径',
  '## 3. 弯路',
  '## 4. 用户故事',
  '## 5. 抽象能力建议',
] as const;

/** 单条 detour 在 markdown 中的最大展示长度 */
const DETOUR_SNIPPET_LEN = 200;

/** 工具调用展示上限（超出折叠为「... 其余 N 次」） */
const TOOL_LIST_LIMIT = 20;

/**
 * 纯函数：把 RetrospectiveFact 渲染为 markdown 5 段骨架。
 *
 * 输出结构（C2）：
 *   # Session 复盘 · <sessionId>
 *
 *   ## 1. 背景
 *   - session id / source / cwd / projectPath / 时长 / 消息数
 *   - 原始需求（originalNeed）
 *
 *   ## 2. 工具调用路径
 *   - 总数 + 按顺序的工具名列表
 *
 *   ## 3. 弯路
 *   - 每条 detour：seq / pattern / snippet
 *   - 无则打印「（无明确弯路）」
 *
 *   ## 4. 用户故事
 *   - <FILL: 作为 ... 我希望 ... 以便 ...>（C3 槽位）
 *
 *   ## 5. 抽象能力建议
 *   - <FILL: 从本次复盘可抽象出何种可复用能力？>
 */
export function renderNarrative(fact: RetrospectiveFact): string {
  const lines: string[] = [];

  // 标题
  lines.push(`# Session 复盘 · ${fact.sessionId}`);
  lines.push('');

  // ─── §1 背景 ────────────────────────────────────────────────────────
  lines.push(NARRATIVE_SECTIONS[0]);
  lines.push('');
  lines.push(`- session id: \`${fact.sessionId}\``);
  lines.push(`- source: ${fact.sessionMeta.source}`);
  if (fact.sessionMeta.cwd) {
    lines.push(`- cwd: ${fact.sessionMeta.cwd}`);
  }
  if (fact.sessionMeta.projectPath) {
    lines.push(`- project: ${fact.sessionMeta.projectPath}`);
  }
  lines.push(`- 时长: ${formatDuration(fact.durationSec)}`);
  lines.push(`- 消息数: ${fact.sessionMeta.messageCount}`);
  if (typeof fact.firstUserMessageAt === 'number') {
    lines.push(`- 首条 user 消息: ${formatTimestamp(fact.firstUserMessageAt)}`);
  }
  lines.push('');
  lines.push('**原始需求**');
  lines.push('');
  lines.push(quoteBlock(fact.originalNeed || '(无首条 user 消息)'));
  lines.push('');

  // ─── §2 工具调用路径 ────────────────────────────────────────────────
  lines.push(NARRATIVE_SECTIONS[1]);
  lines.push('');
  lines.push(`总调用次数: **${fact.toolCallCount}**`);
  lines.push('');
  if (fact.toolCalls.length === 0) {
    lines.push('(无工具调用)');
  } else {
    const shown = fact.toolCalls.slice(0, TOOL_LIST_LIMIT);
    const rest = fact.toolCalls.length - shown.length;
    for (const t of shown) {
      lines.push(`- [seq ${t.seq}] \`${t.name}\``);
    }
    if (rest > 0) {
      lines.push(`- ... 其余 ${rest} 次`);
    }
  }
  lines.push('');

  // ─── §3 弯路 ────────────────────────────────────────────────────────
  lines.push(NARRATIVE_SECTIONS[2]);
  lines.push('');
  if (fact.detours.length === 0) {
    lines.push('(无明确弯路)');
  } else {
    for (const d of fact.detours) {
      lines.push(`- **seq ${d.seq}** · pattern: \`${d.pattern}\``);
      lines.push('  ```');
      lines.push(`  ${d.snippet.slice(0, DETOUR_SNIPPET_LEN).replace(/\n/g, '\n  ')}`);
      lines.push('  ```');
    }
  }
  lines.push('');

  // ─── §4 用户故事（C3 槽位） ────────────────────────────────────────
  lines.push(NARRATIVE_SECTIONS[3]);
  lines.push('');
  lines.push('> 以下槽位由 agent LLM 填充（loop §C3）：');
  lines.push('');
  lines.push('<FILL: 作为 <角色>，我希望 <能力>，以便 <价值>。>');
  lines.push('<FILL: 验收标准：1) ... 2) ... 3) ...>');
  lines.push('');

  // ─── §5 抽象能力建议（C3 槽位） ────────────────────────────────────
  lines.push(NARRATIVE_SECTIONS[4]);
  lines.push('');
  lines.push('> 以下槽位由 agent LLM 填充（loop §C3）：');
  lines.push('');
  lines.push('<FILL: 从本次复盘可抽象出何种可复用能力？是否值得固化为 skill / pattern / 检查项？>');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 秒 → 人类可读时长（如 "1m 23s" / "0s"） */
function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '?';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

/** epoch ms → ISO 字符串 */
function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return '?';
  }
}

/** 把多行文本转为 markdown 引用块 */
function quoteBlock(text: string): string {
  if (!text) return '> (空)';
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}
