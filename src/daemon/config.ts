/**
 * yondermesh 全局配置
 *
 * 注：采集器配置（type/path/device）是历史占位，后续 Loop 将由
 * SessionStore 的来源实例（SourceInstance）取代。
 */

/** 历史采集器配置占位 */
export interface AgentCollectorConfig {
  type: string;
  path: string;
  device: string;
}

/** yondermesh 配置 */
export interface YondermeshConfig {
  /** 设备列表 */
  devices: DeviceConfig[];
  /** 同步配置 */
  sync: SyncConfig;
  /** MCP server 配置 */
  mcp: McpConfig;
  /** 晨报配置 */
  briefing: BriefingConfig;
}

/** 设备配置 */
export interface DeviceConfig {
  /** 设备名 */
  name: string;
  /** 该设备上的 agent 采集器列表 */
  agents: AgentCollectorConfig[];
}

/** 同步配置 */
export interface SyncConfig {
  /** relay 服务器地址 */
  relayUrl?: string;
  /** E2E 加密密钥文件路径 */
  keyFile: string;
  /** 是否启用同步 */
  enabled: boolean;
}

/** MCP 配置 */
export interface McpConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 监听端口（0 = stdio 模式） */
  port: number;
}

/** 晨报配置 */
export interface BriefingConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 输出目录 */
  output: string;
}

/** 默认配置 */
export function defaultConfig(): YondermeshConfig {
  return {
    devices: [
      {
        name: 'local',
        agents: [
          {
            type: 'claude-code',
            path: '~/.claude/projects',
            device: 'local',
          },
        ],
      },
    ],
    sync: {
      enabled: false,
      keyFile: '~/.yondermesh/key.pem',
    },
    mcp: {
      enabled: true,
      port: 0,
    },
    briefing: {
      enabled: true,
      output: '~/.yondermesh/briefings',
    },
  };
}
