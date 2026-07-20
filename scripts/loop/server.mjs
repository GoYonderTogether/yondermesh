// scripts/loop/server.mjs
//
// Loop 看板的本地 http server（零依赖：node:http + node:fs）。
// 网页可编辑 loop md、实时看状态、复制 Prompt、触发 scan；AI 也可直接改 md 文件。
//
// Run:  npm run loop:ui   →  http://localhost:5174

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { listLoops, loadLoop, saveLoop, serialize, slugify, today, LOOPS_DIR, REPO_ROOT } from './loop-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(__dirname, 'dashboard.html');
const FEATURES_JSON_SCRIPT = join(REPO_ROOT, 'scripts', 'docs', 'features-json.mjs');
const PORT = Number(process.env.LOOP_PORT) || 5174;

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(s));
  });
}

function getFeatures() {
  try {
    const out = execSync(`node "${FEATURES_JSON_SCRIPT}"`, { encoding: 'utf-8', timeout: 15000 });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(DASHBOARD, 'utf-8'));
      return;
    }
    if (req.method === 'GET' && path === '/api/loops') {
      json(res, 200, listLoops());
      return;
    }
    if (req.method === 'GET' && path === '/api/loop') {
      const id = url.searchParams.get('id');
      json(res, 200, loadLoop(id));
      return;
    }
    if (req.method === 'GET' && path === '/api/features') {
      json(res, 200, getFeatures());
      return;
    }
    if (req.method === 'POST' && path === '/api/loop') {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 新建：没 id 时从 title 生成
      if (!body.id) body.id = slugify(body.title || 'untitled');
      if (!body.created) body.created = today();
      const p = saveLoop(body);
      json(res, 200, { ok: true, id: body.id, path: p });
      return;
    }
    if (req.method === 'POST' && path === '/api/scan') {
      const id = url.searchParams.get('id');
      execSync(`node "${join(__dirname, 'scan.mjs')}" ${id}`, { cwd: REPO_ROOT, stdio: 'inherit' });
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

if (!existsSync(LOOPS_DIR)) {
  console.error(`[loop:ui] loops 目录不存在：${LOOPS_DIR}`);
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Loop 看板：http://localhost:${PORT}`);
  console.log(`loops 目录：${LOOPS_DIR}`);
  console.log('Ctrl-C 停止。');
});
