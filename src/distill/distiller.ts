/**
 * 蒸馏窄版（distill · narrow）
 *
 * 从 src/extract/ 的 requirements/responses NDJSONL 产物中，用规则/启发式抽取：
 *   - 标签（tech stack tags）：扫描已知技术关键词，按频次排序
 *   - 主题（themes）：按意图关键词分类（bugfix/testing/refactor/feature/docs/config）
 *   - 偏好（preferences）：从 user 消息中匹配 "always/never/prefer/make sure" 等模式
 *
 * 窄版原则：deterministic、零 LLM、可测。"懂你"质量留后续 LLM 版本。
 *
 * 产物存 ~/.yondermesh/distilled/<projectHash>.json，幂等覆盖。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from '../daemon/config.js';
import { extractsBaseDir, projectHashOf } from '../extract/extractor.js';
import type { ExtractEntry } from '../extract/types.js';

/** 蒸馏产物存放根目录：~/.yondermesh/distilled */
export function distilledBaseDir(): string {
  return join(defaultDataDir(), 'distilled');
}

/** 单条标签 */
export interface TagEntry {
  tag: string;
  count: number;
}

/** 单条主题 */
export interface ThemeEntry {
  theme: string;
  count: number;
}

/** 单条偏好（从 user 消息中抽取的规则性陈述） */
export interface PreferenceEntry {
  text: string;
  source: 'always' | 'never' | 'prefer' | 'make-sure' | 'dont';
  sessionId: string;
}

/** 蒸馏统计 */
export interface DistillStats {
  requirementCount: number;
  responseCount: number;
  /** 至少命中一个标签的消息占比 */
  tagCoverage: number;
}

/** 蒸馏产物（单项目） */
export interface DistilledProject {
  projectHash: string;
  projectPath: string;
  distilledAt: number;
  /** 输入产物的内容哈希（幂等判定：相同则跳过重写） */
  inputContentHash: string;
  tags: TagEntry[];
  themes: ThemeEntry[];
  preferences: PreferenceEntry[];
  stats: DistillStats;
}

/** 蒸馏选项 */
export interface DistillOptions {
  /** 项目路径（cwdPrefix 或 projectPath） */
  projectPath: string;
  /** extracts 根目录（默认 ~/.yondermesh/extracts） */
  extractsDir?: string;
  /** distilled 输出目录（默认 ~/.yondermesh/distilled） */
  outputDir?: string;
  /** 标签最低频次阈值（默认 1） */
  minTagCount?: number;
  /** 是否跳过未变化的产物（幂等，默认 true） */
  skipIfUnchanged?: boolean;
}

/** 已知技术栈关键词字典（小写匹配） */
const TECH_KEYWORDS: Record<string, string> = {
  typescript: 'typescript',
  ts: 'typescript',
  javascript: 'javascript',
  js: 'javascript',
  react: 'react',
  nextjs: 'next.js',
  'next.js': 'next.js',
  vue: 'vue',
  node: 'node.js',
  'node.js': 'node.js',
  npm: 'npm',
  vitest: 'vitest',
  jest: 'jest',
  vite: 'vite',
  webpack: 'webpack',
  python: 'python',
  py: 'python',
  rust: 'rust',
  go: 'go',
  java: 'java',
  docker: 'docker',
  kubernetes: 'kubernetes',
  k8s: 'kubernetes',
  redis: 'redis',
  postgres: 'postgres',
  sqlite: 'sqlite',
  graphql: 'graphql',
  rest: 'rest',
  css: 'css',
  html: 'html',
  tailwind: 'tailwind',
  shadcn: 'shadcn',
  tauri: 'tauri',
  electron: 'electron',
  express: 'express',
  koa: 'koa',
  fastify: 'fastify',
  prisma: 'prisma',
  drizzle: 'drizzle',
  zod: 'zod',
  tanstack: 'tanstack',
  pinia: 'pinia',
  redux: 'redux',
  svelte: 'svelte',
  astro: 'astro',
  deno: 'deno',
  bun: 'bun',
  pnpm: 'pnpm',
  yarn: 'yarn',
  turborepo: 'turborepo',
  eslint: 'eslint',
  prettier: 'prettier',
  babel: 'babel',
  swc: 'swc',
  esbuild: 'esbuild',
  rollup: 'rollup',
  mcp: 'mcp',
  llm: 'llm',
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor',
};

/** 主题关键词映射（意图 → 主题） */
const THEME_KEYWORDS: Record<string, string[]> = {
  bugfix: ['bug', 'fix', 'error', 'crash', 'broken', 'fail', 'failing', 'regression', 'wrong'],
  testing: ['test', 'vitest', 'jest', 'spec', 'coverage', 'mock', 'stub', 'assert'],
  refactor: ['refactor', 'cleanup', 'clean up', 'simplify', 'restructure', 'rename'],
  feature: ['feature', 'add', 'implement', 'support', 'new', 'create', 'build'],
  docs: ['doc', 'readme', 'documentation', 'comment', 'changelog', 'guide'],
  config: ['config', 'setting', 'option', 'env', 'variable', 'preference'],
  perf: ['performance', 'optimize', 'speed', 'slow', 'fast', 'latency', 'cache'],
  security: ['security', 'auth', 'permission', 'vulnerability', 'inject', 'xss'],
  deploy: ['deploy', 'release', 'publish', 'ci', 'cd', 'pipeline', 'ship'],
};

/** 偏好抽取正则（从 user 消息中匹配规则性陈述） */
const PREFERENCE_PATTERNS: Array<{ source: PreferenceEntry['source']; re: RegExp }> = [
  { source: 'always', re: /\balways\s+(?:use|do|prefer|make|ensure|keep|add|include)\b[^.\n]{0,120}/gi },
  { source: 'never', re: /\bnever\s+(?:use|do|put|add|include|forget|ignore)\b[^.\n]{0,120}/gi },
  { source: 'prefer', re: /\bprefer\s+(?:to\s+)?(?:use|using|over|instead)?[^.\n]{0,120}/gi },
  { source: 'make-sure', re: /\bmake\s+sure\s+(?:to\s+)?[^.\n]{0,120}/gi },
  { source: 'dont', re: /\bdon'?t\s+(?:forget|use|put|add|include|mix|combine)\b[^.\n]{0,120}/gi },
];

/**
 * 蒸馏一个项目的 extract 产物
 */
export function distillProject(options: DistillOptions): DistilledProject {
  const projectHash = projectHashOf(options.projectPath);
  const extractsDir = options.extractsDir ?? extractsBaseDir();
  const outputDir = options.outputDir ?? distilledBaseDir();
  const minTagCount = options.minTagCount ?? 1;
  const skipIfUnchanged = options.skipIfUnchanged ?? true;

  const projectExtractDir = join(extractsDir, projectHash);
  const reqFile = join(projectExtractDir, 'requirements.ndjsonl');
  const respFile = join(projectExtractDir, 'responses.ndjsonl');

  const requirements = readNdjsonl(reqFile);
  const responses = readNdjsonl(respFile);

  // 输入内容哈希（幂等判定）
  const inputContentHash = hashInputs(requirements, responses);

  // 幂等：未变化则读旧产物返回
  const outputFile = join(outputDir, `${projectHash}.json`);
  if (skipIfUnchanged && existsSync(outputFile)) {
    try {
      const prev = JSON.parse(readFileSync(outputFile, 'utf-8')) as DistilledProject;
      if (prev.inputContentHash === inputContentHash) {
        return prev;
      }
    } catch {
      /* 旧文件损坏，重新蒸馏 */
    }
  }

  // 抽取
  const tagCounts: Record<string, number> = {};
  const themeCounts: Record<string, number> = {};
  const preferences: PreferenceEntry[] = [];
  let taggedMessages = 0;
  const allEntries = [...requirements, ...responses];

  for (const entry of allEntries) {
    const content = entry.content ?? '';
    const lower = content.toLowerCase();

    // 标签抽取
    const hitTags = new Set<string>();
    for (const [kw, tag] of Object.entries(TECH_KEYWORDS)) {
      if (matchesKeyword(lower, kw)) {
        hitTags.add(tag);
      }
    }
    if (hitTags.size > 0) taggedMessages += 1;
    for (const tag of hitTags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }

    // 主题抽取
    const hitThemes = new Set<string>();
    for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          hitThemes.add(theme);
          break;
        }
      }
    }
    for (const theme of hitThemes) {
      themeCounts[theme] = (themeCounts[theme] ?? 0) + 1;
    }

    // 偏好抽取（仅 user 消息）
    if (entry.role === 'user') {
      for (const { source, re } of PREFERENCE_PATTERNS) {
        re.lastIndex = 0;
        const matches = content.matchAll(re);
        for (const m of matches) {
          const text = m[0]!.trim().replace(/\s+/g, ' ').slice(0, 160);
          preferences.push({ text, source, sessionId: entry.sessionId });
        }
      }
    }
  }

  const tags: TagEntry[] = Object.entries(tagCounts)
    .filter(([, c]) => c >= minTagCount)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const themes: ThemeEntry[] = Object.entries(themeCounts)
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));

  const totalMessages = allEntries.length;
  const result: DistilledProject = {
    projectHash,
    projectPath: options.projectPath,
    distilledAt: Date.now(),
    inputContentHash,
    tags,
    themes,
    preferences,
    stats: {
      requirementCount: requirements.length,
      responseCount: responses.length,
      tagCoverage: totalMessages > 0 ? taggedMessages / totalMessages : 0,
    },
  };

  // 持久化
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');

  return result;
}

/** 列出已蒸馏的项目（按 distilledAt 倒序） */
export function listDistilled(outputDir?: string): DistilledProject[] {
  const dir = outputDir ?? distilledBaseDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const results: DistilledProject[] = [];
  for (const f of files) {
    try {
      results.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')) as DistilledProject);
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return results.sort((a, b) => b.distilledAt - a.distilledAt);
}

/** 读取已蒸馏的项目（按 projectHash） */
export function getDistilled(projectHash: string, outputDir?: string): DistilledProject | undefined {
  const dir = outputDir ?? distilledBaseDir();
  const file = join(dir, `${projectHash}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as DistilledProject;
  } catch {
    return undefined;
  }
}

// ─── 私有助手 ────────────────────────────────────────────────────────

/** 读取 NDJSONL 文件为 ExtractEntry 数组（文件不存在返回空数组） */
function readNdjsonl(filePath: string): ExtractEntry[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf-8');
  const entries: ExtractEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ExtractEntry);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return entries;
}

/** 关键词匹配（词边界安全，避免 'go' 匹配 'good'） */
function matchesKeyword(lowerText: string, keyword: string): boolean {
  // 短关键词（<=2 字符）用词边界；长的直接 includes
  if (keyword.length <= 2) {
    const re = new RegExp(`\\b${escapeRe(keyword)}\\b`);
    return re.test(lowerText);
  }
  return lowerText.includes(keyword);
}

/** 转义正则特殊字符 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 计算输入产物的内容哈希 */
function hashInputs(requirements: ExtractEntry[], responses: ExtractEntry[]): string {
  const h = createHash('sha256');
  h.update(`req:${requirements.length}:`);
  for (const r of requirements) {
    h.update(`${r.id}|${r.sessionId}|${r.content.length}|`);
  }
  h.update(`resp:${responses.length}:`);
  for (const r of responses) {
    h.update(`${r.id}|${r.sessionId}|${r.content.length}|`);
  }
  return h.digest('hex').slice(0, 16);
}
