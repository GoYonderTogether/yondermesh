/**
 * L4 派生层 barrel
 *
 * 卡住检测等纯函数派生能力从本目录导出（ARCHITECTURE §III.6「内核零 LLM」）。
 * 下游消费方（orchestrate 的 await / 卡住检测等）只从此处导入，不直接 reach into 子模块。
 */

export {
  detectStuckSessions,
  DEFAULT_STUCK_STALE_HOURS,
} from './stuck.js';

export type {
  StuckSessionInput,
  StuckOptions,
  StuckReason,
  StuckResult,
} from './stuck.js';
