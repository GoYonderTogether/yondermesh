/**
 * 端到端测试：向每个已安装 CLI 发一条测试消息，验证能否拿到回复
 *
 * 用 new 模式（launch），因为大部分 CLI 没有现成 session 可 resume。
 * 测试消息："Reply with exactly: PONG" — 简单且容易验证。
 *
 * IDE 类 CLI（trae-ide / windsurf / cursor-ide / chatgpt）：
 *   - tmux 优先（找已运行 pane → send-keys → capture-pane）
 *   - macOS 上 applescript 兜底（open -a → Cmd+V → Enter → accessibility 读回复）
 *   - 如果 tmux 没装且不在 macOS，才跳过
 */

import { spawnSync } from 'node:child_process';

import { TriggerAdapter } from '../src/trigger/index.js';

const TEST_MESSAGE = 'Reply with exactly: PONG';

const adapter = new TriggerAdapter();

// 所有 CLI 列表
const ALL_CLIS = [
  'hermes', 'gemini', 'goose', 'codex', 'claude',
  'aider', 'amp', 'factory', 'vibe', 'codebuddy',
  'trae-cli', 'opencode', 'qwen', 'openhands',
  'kimi', 'openclaw', 'pi', 'copilot', 'crush',
  'cline', 'continue', 'antigravity',
  'trae-ide', 'windsurf', 'cursor-ide', 'chatgpt',
];

const IDE_CLIS = new Set(['trae-ide', 'windsurf', 'cursor-ide', 'chatgpt']);

/** tmux 是否安装并有运行中的 session */
function isTmuxReady(): boolean {
  try {
    const which = spawnSync('which', ['tmux'], { encoding: 'utf-8', timeout: 1000 });
    if (which.status !== 0) return false;
    const ls = spawnSync('tmux', ['list-sessions'], { encoding: 'utf-8', timeout: 2000 });
    return ls.status === 0 && (ls.stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}

interface TestRow {
  cli: string;
  installed: boolean;
  mode: string;
  channel: string;
  delivered: boolean;
  hasResponse: boolean;
  responseLen: number;
  latencyMs: number;
  error?: string;
  responsePreview?: string;
}

const results: TestRow[] = [];

async function testCli(cli: string): Promise<TestRow> {
  const cap = adapter.getCapability(cli);
  const row: TestRow = {
    cli,
    installed: cap.installed,
    mode: cap.modes.includes('new') ? 'new' : cap.modes[0] ?? 'none',
    channel: cap.primaryChannel,
    delivered: false,
    hasResponse: false,
    responseLen: 0,
    latencyMs: 0,
  };

  if (!cap.installed) {
    row.error = '未安装';
    return row;
  }

  // IDE 类：tmux 不可用且非 macOS（无 applescript）才跳过
  if (IDE_CLIS.has(cli)) {
    const tmuxReady = isTmuxReady();
    const onMacos = process.platform === 'darwin';
    if (!tmuxReady && !onMacos) {
      row.error = 'tmux 未就绪且非 macOS（无可用通道，跳过）';
      return row;
    }
    // 用 new 模式：adapter 内部先试 tmux（找已运行 pane），失败走 applescript
    // applescript 在 new 模式下会 open -a 启动未运行的 app，再发 keystroke
    row.mode = 'new';
  }

  try {
    const result = await adapter.trigger({
      cli,
      message: TEST_MESSAGE,
      mode: row.mode as 'new' | 'running',
      timeoutMs: 120000, // 2 分钟超时
    });

    row.delivered = result.delivered;
    row.hasResponse = result.response.trim().length > 0;
    row.responseLen = result.response.length;
    row.latencyMs = result.latencyMs;
    row.channel = result.channel;
    if (result.error) row.error = result.error.slice(0, 200);
    if (result.response) row.responsePreview = result.response.slice(0, 200).replace(/\n/g, ' ');

    return row;
  } catch (err) {
    row.error = String(err).slice(0, 200);
    return row;
  }
}

async function main() {
  console.log('=== ymesh trigger 端到端测试 ===');
  console.log(`测试消息: "${TEST_MESSAGE}"`);
  console.log(`超时: 120s per CLI`);
  console.log(`tmux 就绪: ${isTmuxReady()} | 平台: ${process.platform}`);
  console.log('');

  // 串行测试（避免资源冲突）
  for (const cli of ALL_CLIS) {
    process.stdout.write(`测试 ${cli}...`);
    const row = await testCli(cli);
    results.push(row);
    const status = row.delivered ? '✓' : '✗';
    const resp = row.hasResponse ? `response=${row.responseLen}ch` : 'no response';
    console.log(` ${status} ${resp} ${row.latencyMs}ms [${row.channel}] ${row.error ?? ''}`);
  }

  // 汇总表格
  console.log('\n=== 汇总 ===\n');
  console.log('| CLI | 安装 | 模式 | 通道 | 投递 | 有回复 | 回复长度 | 耗时 | 错误 |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(`| ${r.cli} | ${r.installed ? '✓' : '✗'} | ${r.mode} | ${r.channel} | ${r.delivered ? '✓' : '✗'} | ${r.hasResponse ? '✓' : '✗'} | ${r.responseLen} | ${r.latencyMs}ms | ${r.error ?? ''} |`);
  }

  const total = results.length;
  const installed = results.filter(r => r.installed).length;
  const delivered = results.filter(r => r.delivered).length;
  const withResponse = results.filter(r => r.hasResponse).length;

  console.log(`\n总计: ${total} CLI, ${installed} 已安装, ${delivered} 投递成功, ${withResponse} 有回复`);

  // IDE 类专项报告
  const ideRows = results.filter(r => IDE_CLIS.has(r.cli));
  if (ideRows.length > 0) {
    console.log('\n=== IDE 类专项（tmux + applescript 通道）===\n');
    for (const r of ideRows) {
      const replyStatus = r.delivered ? (r.hasResponse ? '拿到回复' : '投递成功但无回复文本') : '失败';
      console.log(`- ${r.cli}: ${replyStatus} | 通道=${r.channel} | 耗时=${r.latencyMs}ms | 错误=${r.error ?? '无'}`);
    }
  }

  // 输出回复预览
  console.log('\n=== 回复预览 ===\n');
  for (const r of results) {
    if (r.responsePreview) {
      console.log(`[${r.cli}] ${r.responsePreview}`);
    }
  }
}

main().catch(console.error);
