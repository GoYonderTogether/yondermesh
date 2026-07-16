/**
 * 集中检测模块入口
 *
 * 统一检测本机安装的所有 agent CLI 及其能力。
 */

export { detectAgents, formatAgentsTable, formatAgentsJson } from './agents.js';
export type { AgentDetection, DetectOptions } from './agents.js';
