/**
 * retrospective 模块 barrel
 *
 * 三段式复盘内核（loop build-retrospective）：
 *   - redact（事实层脱敏）：纯函数 + 永不抛错
 *   - generator（事实层组装）：纯函数 + 只读 store，零 LLM
 *   - narrative（叙事层骨架）：纯函数模板，<FILL: ...> 槽位由 agent LLM 填充
 *
 * 遵守 ARCHITECTURE §III.6「内核零 LLM」：本目录全部文件不调用 LLM API。
 * 下游消费方（CLI / MCP / briefing）只从此处导入，不直接 reach into 子模块。
 */

export { redact } from './redact.js';
export {
  generateRetrospective,
} from './generator.js';
export type {
  RetrospectiveFact,
  GenerateRetrospectiveInput,
  ToolCallEntry,
  DetourEntry,
  SessionMeta,
  StuckSegment,
} from './generator.js';
export {
  renderNarrative,
  NARRATIVE_SECTIONS,
} from './narrative.js';
