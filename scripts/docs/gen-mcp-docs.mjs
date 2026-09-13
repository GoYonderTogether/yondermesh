// scripts/docs/gen-mcp-docs.mjs
//
// Generate site/reference/mcp-tools.md and site/zh/reference/mcp-tools.md from
// the SINGLE SOURCE OF TRUTH: McpServer.listTools() in src/mcp/server.ts.
// Only the orthogonal (non-deprecated) tool set is documented; deprecated
// forwarding aliases are intentionally omitted. Argument tables are rendered
// straight from each tool's inputSchema, so tool names and params can never
// drift from code.
//
// Run:  node scripts/docs/gen-mcp-docs.mjs
// CI:   invoked by sync-all.mjs; check-drift.mjs asserts no diff after re-run.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EN } from './mcp-en-descriptions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const srcDir = join(repoRoot, 'src');
const siteRoot = join(repoRoot, 'site');

// Instantiate McpServer via tsx and dump the tool list as JSON. We write a temp
// dumper module and run it with `tsx` (avoids shell-escaping issues that break
// `tsx -e` on multi-line scripts). Deprecated tools carry a `[deprecated, ...]`
// description prefix — filter them out.
function loadTools() {
  const dumperPath = join(__dirname, '.dump-mcp.mjs');
  const serverUrl = 'file://' + join(srcDir, 'mcp', 'server.ts').replace(/\\/g, '/');
  const storeUrl = 'file://' + join(srcDir, 'store', 'session-store.ts').replace(/\\/g, '/');
  const dumper = [
    `import { McpServer, ORTHOGONAL_TOOL_NAMES } from ${JSON.stringify(serverUrl)};`,
    `import { SessionStore } from ${JSON.stringify(storeUrl)};`,
    `const store = new SessionStore(':memory:');`,
    `const srv = new McpServer(store);`,
    `const core = new Set(ORTHOGONAL_TOOL_NAMES);`,
    `const tools = srv.listTools()`,
    `  .filter((t) => !t.description.startsWith('[deprecated'))`,
    `  .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, core: core.has(t.name) }));`,
    `process.stdout.write(JSON.stringify(tools));`,
  ].join('\n');
  writeFileSync(dumperPath, dumper, 'utf-8');
  try {
    const out = execFileSync('npx', ['tsx', dumperPath], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return JSON.parse(out);
  } finally {
    rmSync(dumperPath, { force: true });
  }
}

// Assert every tool + param in server.ts has an English entry. A new tool or
// param without a translation fails the build loudly — no silent drift.
function assertEnComplete(tools) {
  const missing = [];
  for (const t of tools) {
    const en = EN[t.name];
    if (!en) { missing.push(`tool "${t.name}"`); continue; }
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    for (const p of Object.keys(props)) {
      if (!en.params || en.params[p] === undefined) missing.push(`param "${t.name}.${p}"`);
    }
  }
  if (missing.length) {
    console.error('[gen-mcp-docs] missing English descriptions — add them to mcp-en-descriptions.mjs:');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
}

// Render one tool's argument table rows from its JSON Schema. `paramEn` is an
// optional {param: englishDesc} override (English page); falls back to source.
function argRows(schema, paramEn) {
  const props = (schema && schema.properties) || {};
  const required = new Set((schema && schema.required) || []);
  const rows = [];
  for (const [name, def] of Object.entries(props)) {
    const type = def.enum ? `enum(${def.enum.join(' / ')})` : def.type || '—';
    const req = required.has(name) ? 'yes' : 'no';
    const base = (paramEn && paramEn[name] !== undefined) ? paramEn[name] : (def.description || '—');
    let desc = base.replace(/\|/g, '\\|');
    if (def.default !== undefined) desc += ` (default \`${def.default}\`)`;
    rows.push(`| \`${name}\` | ${type} | ${req} | ${desc} |`);
  }
  return rows;
}

function render(tools, lang) {
  const t = lang === 'zh'
    ? {
        title: 'MCP 工具', outline: '[2, 3]',
        desc: 'yondermesh MCP server（ymesh mcp）暴露的正交工具集参考 —— 参数与调用方式。',
        banner: '> **自动生成** 自 `src/mcp/server.ts` 的 `McpServer.listTools()`，请勿手动编辑 — 在 `site/` 目录运行 `npm run sync` 重新生成。',
        intro: '`ymesh mcp` 启动一个 stdio JSON-RPC server，把 yondermesh 的 session 图暴露给任何支持 MCP 的 agent（Claude Code、Codex、Cursor、Gemini、Windsurf、Continue 等）。已废弃的转发别名不在此列。',
        countLine: (core, aux) =>
          aux > 0
            ? `**核心正交工具 ${core} 个**，另有 ${aux} 个辅助工具。`
            : `**核心正交工具 ${core} 个**（看 / 说 / 管 / 标）。`,
        coreHead: '## 核心工具（正交集）', auxHead: '## 辅助工具',
        howto: '## 如何调用', cliHead: '### 从 CLI',
        argsHead: '### 参数', noArgs: '_无参数。_',
        argCols: '| 参数 | 类型 | 必填 | 说明 |',
      }
    : {
        title: 'MCP Tools', outline: '[2, 3]',
        desc: 'Reference for the orthogonal tool set exposed by the yondermesh MCP server (ymesh mcp) — arguments and invocation.',
        banner: '> **Auto-generated** from `McpServer.listTools()` in `src/mcp/server.ts`. Do not edit by hand — run `npm run sync` in `site/` to regenerate.',
        intro: 'The `ymesh mcp` command starts a stdio JSON-RPC server that exposes yondermesh\'s session graph to any MCP-capable agent (Claude Code, Codex, Cursor, Gemini, Windsurf, Continue, ...). Deprecated forwarding aliases are omitted.',
        countLine: (core, aux) =>
          aux > 0
            ? `**${core} core orthogonal tools**, plus ${aux} auxiliary tools.`
            : `**${core} core orthogonal tools** — see / say / manage / label.`,
        coreHead: '## Core tools (orthogonal set)', auxHead: '## Auxiliary tools',
        howto: '## How to call', cliHead: '### From the CLI',
        argsHead: '### Arguments', noArgs: '_No arguments._',
        argCols: '| Name | Type | Required | Description |',
      };

  const out = [];
  out.push('---');
  out.push(`title: ${t.title}`);
  out.push(`description: ${t.desc}`);
  out.push(`outline: ${t.outline}`);
  out.push('---');
  out.push('');
  const core = tools.filter((x) => x.core);
  const aux = tools.filter((x) => !x.core);

  out.push(t.banner);
  out.push('');
  out.push(t.intro);
  out.push('');
  out.push(t.countLine(core.length, aux.length));
  out.push('');
  out.push(t.howto);
  out.push('');
  out.push(t.cliHead);
  out.push('');
  out.push('```bash');
  out.push('ymesh mcp call <tool> [key=value ...]');
  out.push('```');
  out.push('');

  const renderTool = (tool) => {
    const en = lang === 'en' ? EN[tool.name] : null;
    const desc = en ? en.desc : tool.description;
    out.push(`### ${tool.name}`);
    out.push('');
    out.push(desc.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    out.push('');
    out.push(`#### ${t.argsHead.replace(/^#+\s*/, '')}`);
    out.push('');
    const rows = argRows(tool.inputSchema, en ? en.params : null);
    if (rows.length === 0) {
      out.push(t.noArgs);
    } else {
      out.push(t.argCols);
      out.push('|---|---|---|---|');
      for (const r of rows) out.push(r.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    }
    out.push('');
  };

  out.push(t.coreHead);
  out.push('');
  for (const tool of core) renderTool(tool);

  if (aux.length > 0) {
    out.push(t.auxHead);
    out.push('');
    for (const tool of aux) renderTool(tool);
  }
  return out.join('\n');
}

const tools = loadTools();
assertEnComplete(tools);
const enPath = join(siteRoot, 'reference', 'mcp-tools.md');
const zhPath = join(siteRoot, 'zh', 'reference', 'mcp-tools.md');
mkdirSync(dirname(enPath), { recursive: true });
mkdirSync(dirname(zhPath), { recursive: true });
writeFileSync(enPath, render(tools, 'en'), 'utf-8');
writeFileSync(zhPath, render(tools, 'zh'), 'utf-8');

console.log(`[gen-mcp-docs] wrote ${enPath.replace(repoRoot + '/', '')}`);
console.log(`[gen-mcp-docs] wrote ${zhPath.replace(repoRoot + '/', '')}`);
const coreN = tools.filter((x) => x.core).length;
console.log(`[gen-mcp-docs] ${coreN} core + ${tools.length - coreN} auxiliary tools: ${tools.map((x) => x.name).join(', ')}`);
