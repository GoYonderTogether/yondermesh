#!/usr/bin/env node
/**
 * yondermesh CLI 入口
 *
 * 用法:
 *   ymesh init      — 初始化配置
 *   ymesh daemon    — 启动后台服务
 *   ymesh connect <agent>  — 连接 agent session
 *   ymesh query recent     — 查询最近 session
 *   ymesh mcp      — 启动 MCP server（stdio）
 *   ymesh briefing — 生成晨报
 */

import { YondermeshDaemon } from '../daemon/index.js';

const command = process.argv[2];

function printHelp(): void {
  console.log(`
yondermesh — 自托管 Agent 上下文总线

用法:
  ymesh init              初始化配置（生成 ~/.yondermesh/config.yaml）
  ymesh daemon            启动后台 daemon（扫描 + MCP + 同步 + 晨报）
  ymesh connect <agent>   连接一个 agent 的 session 路径
  ymesh query recent      查询最近的 session
  ymesh mcp               以 stdio 模式启动 MCP server
  ymesh briefing          立即生成今日晨报
  ymesh version           显示版本号
  ymesh help              显示帮助

示例:
  ymesh init
  ymesh daemon
  ymesh connect claude-code
  ymesh query recent --limit 20
`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'init': {
      console.log('TODO: 初始化配置');
      break;
    }
    case 'daemon': {
      const daemon = new YondermeshDaemon();
      await daemon.start();
      // 保持进程运行
      process.on('SIGINT', async () => {
        await daemon.stop();
        process.exit(0);
      });
      break;
    }
    case 'connect': {
      console.log('TODO: 连接 agent');
      break;
    }
    case 'query': {
      console.log('TODO: 查询');
      break;
    }
    case 'mcp': {
      console.log('TODO: MCP stdio 模式');
      break;
    }
    case 'briefing': {
      console.log('TODO: 生成晨报');
      break;
    }
    case 'version': {
      console.log('yondermesh v0.1.0');
      break;
    }
    case 'help':
    case undefined: {
      printHelp();
      break;
    }
    default: {
      console.error(`未知命令: ${command}`);
      printHelp();
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
