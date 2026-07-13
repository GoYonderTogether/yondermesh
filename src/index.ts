/**
 * yondermesh — 自托管 Agent 上下文总线
 *
 * 让用户所有设备上、所有 CLI 里的 AI agent 共享同一份工作现场：
 * 互相看见、互相查询、互相接力。
 */

// 采集器
export { Collector } from './collector/types.js';
export { SqliteCollectorStore } from './collector/store.js';

// MCP
export { McpServer } from './mcp/server.js';

// 同步
export { SyncAgent } from './sync/agent.js';

// 晨报
export { BriefingGenerator } from './briefing/generator.js';

// 类型
export type {
  SessionRecord,
  SessionMessage,
  CollectorConfig,
} from './collector/types.js';
export type { YondermeshConfig } from './daemon/config.js';
