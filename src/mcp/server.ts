/**
 * MCP server 实现
 *
 * 暴露三个工具：
 * - recall_recent_work: 查询全网最近工作
 * - whats_on_device: 查询某设备某项目现场
 * - handoff_task: 跨设备/跨 CLI 派活（M2）
 *
 * 所有支持 MCP 的 CLI agent 挂载后即可使用。
 */

import type { SqliteCollectorStore } from '../collector/store.js';

/** MCP 工具定义 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP 工具调用结果 */
export interface McpToolResult {
  content: string;
  isError?: boolean;
}

/**
 * yondermesh MCP server
 *
 * 通过 stdio 与 agent 通信，遵循 MCP 协议。
 */
export class McpServer {
  private store: SqliteCollectorStore;
  private running = false;

  constructor(store: SqliteCollectorStore) {
    this.store = store;
  }

  /** 启动 MCP server（stdio 模式） */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // TODO: 接入 @modelcontextprotocol/sdk StdioServerTransport
  }

  /** 停止 */
  async stop(): Promise<void> {
    this.running = false;
  }

  /** 列出所有工具 */
  listTools(): McpToolDef[] {
    return [
      {
        name: 'recall_recent_work',
        description: '查询当前设备（及同步网络中其他设备）所有 agent 的最近工作 session。用于在开始新任务前了解此前上下文。',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '返回条数，默认 10', default: 10 },
            agent: { type: 'string', description: '按 agent 类型过滤（claude-code/codex/aider/...）' },
            device: { type: 'string', description: '按设备名过滤' },
          },
        },
      },
      {
        name: 'whats_on_device',
        description: '查询指定设备上某个项目的当前工作现场（最近 session 摘要 + 文件变更）。',
        inputSchema: {
          type: 'object',
          properties: {
            device: { type: 'string', description: '设备名' },
            projectPath: { type: 'string', description: '项目路径' },
          },
          required: ['device'],
        },
      },
      {
        name: 'handoff_task',
        description: '跨设备/跨 CLI 派活。将当前任务上下文打包，交给目标设备的 agent 继续执行。（M2 功能）',
        inputSchema: {
          type: 'object',
          properties: {
            targetDevice: { type: 'string', description: '目标设备名' },
            targetAgent: { type: 'string', description: '目标 agent 类型' },
            taskDescription: { type: 'string', description: '任务描述' },
            contextSessionId: { type: 'string', description: '当前 session ID（用于提取上下文）' },
          },
          required: ['targetDevice', 'taskDescription'],
        },
      },
    ];
  }

  /** 调用工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    switch (name) {
      case 'recall_recent_work':
        return this.recallRecentWork(args);
      case 'whats_on_device':
        return this.whatsOnDevice(args);
      case 'handoff_task':
        return this.handoffTask(args);
      default:
        return { content: `未知工具: ${name}`, isError: true };
    }
  }

  /** recall_recent_work 实现 */
  private async recallRecentWork(args: Record<string, unknown>): Promise<McpToolResult> {
    const limit = (args.limit as number) ?? 10;
    const sessions = this.store.recent(limit);

    if (sessions.length === 0) {
      return { content: '暂无 session 记录。' };
    }

    const lines = sessions.map((s, i) => {
      const time = new Date(s.startedAt).toLocaleString('zh-CN');
      const summary = s.summary ?? `${s.messageCount} 条消息`;
      return `${i + 1}. [${s.agent}] ${s.device} · ${time}\n   项目: ${s.projectPath}\n   摘要: ${summary}`;
    });

    return { content: `最近 ${sessions.length} 个 session:\n\n${lines.join('\n\n')}` };
  }

  /** whats_on_device 实现 */
  private async whatsOnDevice(args: Record<string, unknown>): Promise<McpToolResult> {
    const device = args.device as string;
    const sessions = this.store.query({ device, limit: 5 });

    if (sessions.sessions.length === 0) {
      return { content: `设备 ${device} 上暂无 session 记录。` };
    }

    const lines = sessions.sessions.map((s, i) => {
      const time = new Date(s.startedAt).toLocaleString('zh-CN');
      return `${i + 1}. [${s.agent}] ${time}\n   项目: ${s.projectPath}\n   ${s.messageCount} 条消息`;
    });

    return { content: `设备 ${device} 最近活动:\n\n${lines.join('\n\n')}` };
  }

  /** handoff_task 实现（M2） */
  private async handoffTask(args: Record<string, unknown>): Promise<McpToolResult> {
    return {
      content: 'handoff_task 将在 M2 里程碑实现。当前版本请使用 recall_recent_work 查询上下文后手动接力。',
      isError: true,
    };
  }
}
