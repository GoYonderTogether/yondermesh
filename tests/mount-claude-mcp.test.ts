/**
 * mount-claude-mcp.test.ts — Claude MCP 挂载的「定义没变就跳过」判定
 *
 * 背景：auto-mount 每次 reconcile 都跑，claude-mcp 策略要 spawn 两次 claude CLI
 * （remove + add）。这既慢，也是日志里 128/129 偶发失败的来源。判定「已注册且
 * 定义一致」就能跳过；定义变了（比如换 node 路径）必须老老实实重挂。
 */

import { describe, it, expect } from 'vitest';
import { claudeMcpEntryMatches } from '../src/mount/strategies.js';
import type { Extension } from '../src/mount/types.js';

const ext: Extension = {
  type: 'mcp-server',
  name: 'yondermesh',
  mcp: { command: '/node/bin/node', args: ['/Users/x/.yondermesh/bin/ymesh', 'mcp'] },
};

const matching = {
  mcpServers: {
    yondermesh: {
      type: 'stdio',
      command: '/node/bin/node',
      args: ['/Users/x/.yondermesh/bin/ymesh', 'mcp'],
      env: {},
    },
  },
};

describe('claudeMcpEntryMatches', () => {
  it('定义完全一致 → true（可跳过 remove+add）', () => {
    expect(claudeMcpEntryMatches(matching, ext)).toBe(true);
  });

  it('command 变了（换 node 路径）→ false（必须重挂）', () => {
    const changed = JSON.parse(JSON.stringify(matching));
    changed.mcpServers.yondermesh.command = '/other/node';
    expect(claudeMcpEntryMatches(changed, ext)).toBe(false);
  });

  it('args 变了（换 ymesh 路径）→ false', () => {
    const changed = JSON.parse(JSON.stringify(matching));
    changed.mcpServers.yondermesh.args = ['/old/bin/ymesh', 'mcp'];
    expect(claudeMcpEntryMatches(changed, ext)).toBe(false);
  });

  it('没注册 / 配置为空 / 垃圾输入 → false（走正常挂载，不误判）', () => {
    expect(claudeMcpEntryMatches({}, ext)).toBe(false);
    expect(claudeMcpEntryMatches({ mcpServers: {} }, ext)).toBe(false);
    expect(claudeMcpEntryMatches(null, ext)).toBe(false);
    expect(claudeMcpEntryMatches('not-json-object', ext)).toBe(false);
  });

  it('缺 args 字段的旧式注册 → false（视为需要重挂）', () => {
    expect(claudeMcpEntryMatches({ mcpServers: { yondermesh: { command: '/node/bin/node' } } }, ext)).toBe(false);
  });
});
