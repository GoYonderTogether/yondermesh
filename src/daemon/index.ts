/**
 * yondermesh daemon 入口
 *
 * 启动后：
 * 1. 扫描本机所有配置的 agent session
 * 2. 增量入库到本地 SQLite
 * 3. 启动 MCP server（stdio 或 HTTP）
 * 4. 启动同步 agent（如果启用）
 * 5. 定时生成晨报（如果启用）
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { SessionStore } from '../store/index.js';
import { McpServer } from '../mcp/server.js';
import { SyncAgent } from '../sync/agent.js';
import { BriefingGenerator } from '../briefing/generator.js';
import { defaultConfig, type YondermeshConfig } from './config.js';

/** daemon 运行时 */
export class YondermeshDaemon {
  private config: YondermeshConfig;
  private store: SessionStore;
  private mcpServer?: McpServer;
  private syncAgent?: SyncAgent;
  private briefingGen?: BriefingGenerator;
  private running = false;

  constructor(config?: YondermeshConfig) {
    this.config = config ?? this.loadConfig();
    const dbPath = join(homedir(), '.yondermesh', 'yondermesh.db');
    this.store = new SessionStore(dbPath);
  }

  /** 加载配置文件 */
  private loadConfig(): YondermeshConfig {
    const configPath = join(homedir(), '.yondermesh', 'config.yaml');
    if (!existsSync(configPath)) {
      return defaultConfig();
    }
    // TODO: 解析 YAML 配置
    return defaultConfig();
  }

  /** 启动 daemon */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log('[yondermesh] daemon 启动中...');

    // 1. 扫描并入库 session
    await this.scanSessions();

    // 2. 启动 MCP server
    if (this.config.mcp.enabled) {
      this.mcpServer = new McpServer(this.store);
      await this.mcpServer.start();
      console.log('[yondermesh] MCP server 已启动');
    }

    // 3. 启动同步
    if (this.config.sync.enabled) {
      this.syncAgent = new SyncAgent(this.store, this.config.sync);
      await this.syncAgent.start();
      console.log('[yondermesh] 同步 agent 已启动');
    }

    // 4. 启动晨报
    if (this.config.briefing.enabled) {
      this.briefingGen = new BriefingGenerator(this.store, this.config.briefing);
      this.briefingGen.schedule();
      console.log('[yondermesh] 晨报生成器已启动');
    }

    console.log('[yondermesh] daemon 就绪');
  }

  /** 停止 daemon */
  async stop(): Promise<void> {
    this.running = false;
    await this.mcpServer?.stop();
    await this.syncAgent?.stop();
    this.briefingGen?.unschedule();
    this.store.close();
    console.log('[yondermesh] daemon 已停止');
  }

  /** 扫描所有配置的 agent session */
  private async scanSessions(): Promise<void> {
    for (const device of this.config.devices) {
      for (const agentConfig of device.agents) {
        console.log(`[yondermesh] 扫描 ${agentConfig.type} (${agentConfig.path})`);
        // TODO: 调用具体采集器（LOOP-003/004 接入原生 adapter）
      }
    }
  }
}
