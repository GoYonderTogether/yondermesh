// scripts/loop/loop-lib.mjs
//
// loop 文件的解析/写回工具，供 server / run / scan 复用。零依赖。
// loop md = YAML frontmatter + 四模块（## 目标/上下文/行动约束/观察反馈）+ ## Prompt。
// 格式见 tasks/loops/.template.md。

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..', '..');
export const LOOPS_DIR = join(REPO_ROOT, 'tasks', 'loops');

export const STATUSES = ['draft', 'approved', 'running', 'passed', 'failed'];
export const STATUS_LABEL = {
  draft: '草稿', approved: '已审核', running: '运行中', passed: '通过', failed: '失败',
};

// 解析 frontmatter（极小 YAML 子集：key: value，值可带引号、可为空）
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      // YAML 双引号字符串：处理 \" → " 和 \\ → \（其他 \x 保持字面，与项目用到的子集一致）
      v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1);
    }
    fm[mm[1]] = v;
  }
  return fm;
}

function sectionKey(header) {
  if (/prompt/i.test(header)) return 'prompt';
  if (/目标|goal/i.test(header)) return 'goal';
  if (/上下文|context/i.test(header)) return 'context';
  if (/行动约束|action/i.test(header)) return 'action';
  if (/观察|observation/i.test(header)) return 'observation';
  return null;
}

function parseBody(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const sections = { goal: '', context: '', action: '', observation: '', prompt: '' };
  const parts = body.split(/^(## )/m);
  for (let i = 1; i < parts.length; i += 2) {
    const block = parts[i + 1] || '';
    const nl = block.indexOf('\n');
    const header = (nl < 0 ? block : block.slice(0, nl)).trim();
    const content = nl < 0 ? '' : block.slice(nl + 1).replace(/\s+$/, '');
    const key = sectionKey(header);
    if (key) sections[key] = content;
  }
  return sections;
}

export function parseLoop(text, path) {
  const fm = parseFrontmatter(text);
  const sections = parseBody(text);
  return {
    id: fm.id || '',
    title: fm.title || '',
    status: fm.status || 'draft',
    feature: fm.feature || '',
    verifier: fm.verifier || '',
    created: fm.created || '',
    last_run: fm.last_run || '',
    ...sections,
    path: path || '',
  };
}

export function loadLoop(id) {
  const p = join(LOOPS_DIR, `${id}.md`);
  if (!existsSync(p)) throw new Error(`loop 未找到：${id}（${p}）`);
  return parseLoop(readFileSync(p, 'utf-8'), p);
}

export function listLoops() {
  if (!existsSync(LOOPS_DIR)) return [];
  return readdirSync(LOOPS_DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => {
      const p = join(LOOPS_DIR, f);
      try {
        const loop = parseLoop(readFileSync(p, 'utf-8'), p);
        if (!loop.id) loop.id = f.replace(/\.md$/, '');
        return loop;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function slugify(s) {
  const ascii = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii.slice(0, 40) || ('loop-' + Date.now());
}

export function serialize(loop) {
  const fm = [
    '---',
    `id: ${loop.id}`,
    `title: ${loop.title || loop.id}`,
    `status: ${loop.status || 'draft'}`,
    `feature: ${loop.feature || ''}`,
    loop.verifier ? `verifier: "${loop.verifier.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : 'verifier: ""',
    `created: ${loop.created || today()}`,
    `last_run: ${loop.last_run || ''}`,
    '---',
    '',
  ].join('\n');
  const body = [
    '## 1. 目标 (Goal)', '', loop.goal || '', '',
    '## 2. 上下文 (Context)', '', loop.context || '', '',
    '## 3. 行动约束 (Action)', '', loop.action || '', '',
    '## 4. 观察与反馈 (Observation)', '', loop.observation || '', '',
    '## Prompt', '', loop.prompt || '', '',
  ].join('\n');
  return fm + body;
}

export function saveLoop(loop) {
  if (!loop.id) throw new Error('loop 缺 id');
  if (!existsSync(LOOPS_DIR)) throw new Error(`loops 目录不存在：${LOOPS_DIR}`);
  const p = join(LOOPS_DIR, `${loop.id}.md`);
  writeFileSync(p, serialize(loop), 'utf-8');
  return p;
}

// 从四模块自动拼一段默认 Prompt（Prompt 段为空时用）
export function defaultPrompt(loop) {
  return [
    `你是一个 loop 执行者，必须用 sub-agent（Agent 工具）做任务执行，不要自己一口气写完。`,
    ``,
    `【目标】${loop.goal || '（未填）'}`,
    `【上下文】每次循环先读：${loop.context || '（未填）'}`,
    `【约束】${loop.action || '（未填）'}`,
    `【完成判据】${loop.observation || '（未填）'}`,
    loop.verifier ? `【验证命令】\`${loop.verifier}\` 必须 exit 0。` : `【验证命令】（未设 verifier）`,
    ``,
    `规则：未通过就把错误输出当新上下文继续修，直到验证全绿才停。不许撒谎声称通过。`,
  ].join('\n');
}
