/**
 * MCP 工具定义集成测试
 *
 * 覆盖 src/mcp/tools.ts：
 *   - 7 个工具定义存在
 *   - 每个工具有 name / description / inputSchema / handler
 *   - yondermesh_list_agents handler 返回 installed agent 列表
 *   - yondermesh_query_sessions handler 返回 session 列表
 *   - yondermesh_get_session handler 返回 session 详情
 *   - inputSchema 是有效的 JSON Schema
 *
 * 若 src/mcp/tools.ts 尚未创建，测试自动 skip。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { SessionStore } from '../src/store/index.js';
import {
  MCP_TOOLS,
  findTool,
  listToolSchemas,
  loadWrapper,
} from '../src/mcp/tools.js';

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpHome: string;
let tmpDb: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-mcp-tools-'));
  tmpDb = path.join(tmpHome, 'test.db');
  // 让 src/mcp/tools.ts 里的 openStore() 用临时 DB
  process.env.YONDERMESH_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.YONDERMESH_HOME;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 在临时 DB 中预填一条 session，返回 session id */
function seedSession(): string {
  const store = new SessionStore(tmpDb);
  // 覆盖 defaultDaemonConfig 的 dbPath：把临时 DB 放到 YONDERMESH_HOME/yondermesh.db
  fs.copyFileSync(tmpDb, path.join(tmpHome, 'yondermesh.db'));
  const store2 = new SessionStore(path.join(tmpHome, 'yondermesh.db'));
  const inst = store2.registerSourceInstance({
    deviceId: 'test-device',
    source: 'hermes',
    rootPath: '/test',
    coverage: 'A',
  });
  const result = store2.ingestSession({
    deviceId: 'test-device',
    sourceInstanceId: inst.id,
    nativeSessionId: 'mcp-test-001',
    source: 'hermes',
    cwd: '/Users/test/project-x',
    projectPath: '/Users/test/project-x',
    startedAt: Date.now() - 10000,
    topology: 'root',
    messages: [
      { role: 'user', content: 'hello from mcp test' },
      { role: 'assistant', content: 'hi there' },
    ],
  });
  store.close();
  store2.close();
  return result.sessionId;
}

/** 校验对象是否是合法的 JSON Schema */
function isValidJsonSchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const s = schema as Record<string, unknown>;
  // JSON Schema 必须有 type=object（MCP 工具入参都是 object）
  if (s.type !== 'object') return false;
  // properties 必须是对象或 undefined
  if (s.properties !== undefined) {
    if (typeof s.properties !== 'object' || s.properties === null) return false;
  }
  // required 必须是字符串数组或 undefined
  if (s.required !== undefined) {
    if (!Array.isArray(s.required)) return false;
    if (!s.required.every((r) => typeof r === 'string')) return false;
  }
  return true;
}

// ─── 工具定义测试 ────────────────────────────────────────────────────────────

describe('MCP 工具定义（src/mcp/tools.ts）', () => {
  it('MCP_TOOLS 数组存在且不为空', () => {
    expect(Array.isArray(MCP_TOOLS)).toBe(true);
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(7);
  });

  it('恰好有 11 个工具（yondermesh_* 命名空间，含 4 个 mailbox 工具）', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toContain('yondermesh_list_agents');
    expect(names).toContain('yondermesh_query_sessions');
    expect(names).toContain('yondermesh_get_session');
    expect(names).toContain('yondermesh_launch_agent');
    expect(names).toContain('yondermesh_inject_session');
    expect(names).toContain('yondermesh_transfer_session');
    expect(names).toContain('yondermesh_mount_status');
    expect(names).toContain('yondermesh_mailbox_check');
    expect(names).toContain('yondermesh_mailbox_post');
    expect(names).toContain('yondermesh_mailbox_reply');
    expect(names).toContain('yondermesh_whoami');
    expect(MCP_TOOLS.length).toBe(11);
  });

  it('每个工具有 name / description / inputSchema / handler', () => {
    for (const tool of MCP_TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.name.startsWith('yondermesh_')).toBe(true);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.inputSchema).toBe('object');
      expect(tool.inputSchema).not.toBeNull();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('inputSchema 是有效的 JSON Schema（type=object）', () => {
    for (const tool of MCP_TOOLS) {
      expect(
        isValidJsonSchema(tool.inputSchema),
        `${tool.name} 的 inputSchema 不是有效的 JSON Schema`,
      ).toBe(true);
    }
  });

  it('findTool() 按名称查找工具', () => {
    const list = findTool('yondermesh_list_agents');
    expect(list).toBeDefined();
    expect(list!.name).toBe('yondermesh_list_agents');

    const notFound = findTool('non_existent_tool');
    expect(notFound).toBeUndefined();
  });

  it('listToolSchemas() 返回不含 handler 的 schema 列表', () => {
    const schemas = listToolSchemas();
    expect(Array.isArray(schemas)).toBe(true);
    expect(schemas.length).toBe(MCP_TOOLS.length);
    for (const s of schemas) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.description).toBe('string');
      expect(typeof s.inputSchema).toBe('object');
      // 不应包含 handler
      expect((s as { handler?: unknown }).handler).toBeUndefined();
    }
  });
});

// ─── yondermesh_list_agents handler 测试 ──────────────────────────────────

describe('yondermesh_list_agents handler', () => {
  it('返回 installed agent 列表（默认 installed_only=true）', async () => {
    const tool = findTool('yondermesh_list_agents');
    expect(tool).toBeDefined();

    const result = await tool!.handler({});
    expect(result).toBeDefined();
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]!.type).toBe('text');

    const data = JSON.parse(result.content[0]!.text);
    expect(data).toBeDefined();
    expect(Array.isArray(data.agents)).toBe(true);
    expect(typeof data.count).toBe('number');
    expect(data.count).toBe(data.agents.length);
    // 默认只返回 installed，每个 agent 的 installed 都应为 true
    for (const a of data.agents) {
      expect(a.installed).toBe(true);
    }
  });

  it('installed_only=false 返回全部 agent（含未安装）', async () => {
    const tool = findTool('yondermesh_list_agents');
    const result = await tool!.handler({ installed_only: false });
    const data = JSON.parse(result.content[0]!.text);

    expect(data.agents.length).toBeGreaterThanOrEqual(7);
    // 至少有一个未安装的 agent（除非全部已安装，CI 不太可能）
    const hasUninstalled = data.agents.some((a: { installed: boolean }) => a.installed === false);
    if (!hasUninstalled) {
      // 全部已安装也算通过（开发机可能装了很多 CLI）
      return;
    }
    expect(hasUninstalled).toBe(true);
  });

  it('每个 agent 含 id/displayName/installed/coverage/mountStrategies/wrapperSupported', async () => {
    const tool = findTool('yondermesh_list_agents');
    const result = await tool!.handler({ installed_only: false });
    const data = JSON.parse(result.content[0]!.text);

    for (const a of data.agents) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.displayName).toBe('string');
      expect(typeof a.installed).toBe('boolean');
      expect(typeof a.coverage).toBe('string');
      expect(Array.isArray(a.mountStrategies)).toBe(true);
      expect(typeof a.wrapperSupported).toBe('boolean');
    }
  });
});

// ─── yondermesh_query_sessions handler 测试 ───────────────────────────────

describe('yondermesh_query_sessions handler', () => {
  it('返回 session 列表（默认只返回 root session）', async () => {
    seedSession();
    const tool = findTool('yondermesh_query_sessions');
    expect(tool).toBeDefined();

    const result = await tool!.handler({});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    expect(Array.isArray(data.sessions)).toBe(true);
    expect(data.stats).toBeDefined();
    expect(typeof data.count).toBe('number');
    expect(data.count).toBe(data.sessions.length);
  });

  it('source 过滤生效', async () => {
    seedSession();
    const tool = findTool('yondermesh_query_sessions');
    const result = await tool!.handler({ source: 'hermes' });
    const data = JSON.parse(result.content[0]!.text);

    for (const s of data.sessions) {
      expect(s.source).toBe('hermes');
    }
  });

  it('limit 参数生效', async () => {
    seedSession();
    const tool = findTool('yondermesh_query_sessions');
    const result = await tool!.handler({ limit: 1 });
    const data = JSON.parse(result.content[0]!.text);

    expect(data.sessions.length).toBeLessThanOrEqual(1);
  });
});

// ─── yondermesh_get_session handler 测试 ──────────────────────────────────

describe('yondermesh_get_session handler', () => {
  it('返回 session 详情（含消息）', async () => {
    const sessionId = seedSession();
    const tool = findTool('yondermesh_get_session');
    expect(tool).toBeDefined();

    const result = await tool!.handler({ session_id: sessionId });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    expect(data.session).toBeDefined();
    expect(data.session.id).toBe(sessionId);
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('缺少 session_id 参数返回错误', async () => {
    const tool = findTool('yondermesh_get_session');
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/session_id/);
  });

  it('不存在的 session_id 返回错误', async () => {
    const tool = findTool('yondermesh_get_session');
    const result = await tool!.handler({ session_id: 'nonexistent-session-id' });
    expect(result.isError).toBe(true);
  });

  it('format=markdown 返回 markdown 格式', async () => {
    const sessionId = seedSession();
    const tool = findTool('yondermesh_get_session');
    const result = await tool!.handler({ session_id: sessionId, format: 'markdown' });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    expect(typeof data.markdown).toBe('string');
    expect(data.markdown).toContain('# Session');
    expect(data.markdown).toContain('## Messages');
  });
});

// ─── yondermesh_launch_agent / inject / transfer handler 测试 ─────────────

describe('yondermesh_launch_agent / inject / transfer handler', () => {
  it('launch 缺少 cli 参数返回错误', async () => {
    const tool = findTool('yondermesh_launch_agent');
    const result = await tool!.handler({ prompt: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/cli/);
  });

  it('launch 缺少 prompt 参数返回错误', async () => {
    const tool = findTool('yondermesh_launch_agent');
    const result = await tool!.handler({ cli: 'hermes' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/prompt/);
  });

  it('launch 未知 cli 返回错误', async () => {
    const tool = findTool('yondermesh_launch_agent');
    const result = await tool!.handler({ cli: 'nonexistent-cli', prompt: 'test' });
    expect(result.isError).toBe(true);
  });

  it('inject 缺少参数返回错误', async () => {
    const tool = findTool('yondermesh_inject_session');
    const result = await tool!.handler({ cli: 'hermes' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/session_id|message/);
  });

  it('transfer 缺少参数返回错误', async () => {
    const tool = findTool('yondermesh_transfer_session');
    const result = await tool!.handler({ source_cli: 'hermes' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/session_id|target_cli/);
  });
});

// ─── yondermesh_mount_status handler 测试 ─────────────────────────────────

describe('yondermesh_mount_status handler', () => {
  it('返回挂载状态列表', async () => {
    const tool = findTool('yondermesh_mount_status');
    expect(tool).toBeDefined();

    const result = await tool!.handler({});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);

    expect(Array.isArray(data.mounts)).toBe(true);
    expect(typeof data.count).toBe('number');
    expect(data.byCli).toBeDefined();
  });
});

// ─── loadWrapper 测试 ──────────────────────────────────────────────────────

describe('loadWrapper()', () => {
  it('hermes wrapper 可加载（若模块存在）', async () => {
    const wrapper = await loadWrapper('hermes');
    // wrapper 可能为 null（模块加载失败）或对象
    if (wrapper) {
      expect(typeof wrapper).toBe('object');
    }
  });

  it('未知 cli 返回 null', async () => {
    const wrapper = await loadWrapper('nonexistent-cli-xxx');
    expect(wrapper).toBeNull();
  });
});
