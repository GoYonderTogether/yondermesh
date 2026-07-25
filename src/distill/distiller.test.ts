/**
 * distill 蒸馏窄版测试
 *
 * 验收门：
 *   1. 给定 extract 产物，能抽出 ≥N 个标签/主题
 *   2. 覆盖率达标（tagCoverage > 0）
 *   3. 幂等：重复跑不重复入库（inputContentHash 相同则返回旧产物）
 *   4. 偏好抽取（always/never/prefer/make-sure/dont）
 *   5. 空产物不崩
 *   6. listDistilled / getDistilled 读取正确
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { projectHashOf } from '../extract/extractor.js';
import { distillProject, listDistilled, getDistilled } from './distiller.js';
import type { ExtractEntry } from '../extract/types.js';

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-distill-'));
}

/** 写 NDJSONL 文件 */
function writeNdjsonl(filePath: string, entries: ExtractEntry[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

/** 构造一条 ExtractEntry */
function mkEntry(opts: {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  sessionId?: string;
}): ExtractEntry {
  return {
    id: opts.id,
    sessionId: opts.sessionId ?? `sess-${opts.id}`,
    sessionNativeId: `native-${opts.id}`,
    source: 'claude',
    seq: opts.id,
    role: opts.role,
    cwd: '/repo',
    content: opts.content,
  };
}

describe('distillProject', () => {
  let extractsDir: string;
  let outputDir: string;
  let projectPath: string;
  let projectHash: string;

  beforeEach(() => {
    extractsDir = mkdtemp();
    outputDir = mkdtemp();
    projectPath = '/repo/test';
    projectHash = projectHashOf(projectPath);
  });

  afterEach(() => {
    fs.rmSync(extractsDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('给定 extract 产物，能抽出 ≥N 个标签/主题，覆盖率 > 0', () => {
    const reqFile = path.join(extractsDir, projectHash, 'requirements.ndjsonl');
    const respFile = path.join(extractsDir, projectHash, 'responses.ndjsonl');
    writeNdjsonl(reqFile, [
      mkEntry({ id: 1, role: 'user', content: 'Fix the bug in the TypeScript react component, the test is failing' }),
      mkEntry({ id: 2, role: 'user', content: 'Add a new feature using vitest and node.js' }),
    ]);
    writeNdjsonl(respFile, [
      mkEntry({ id: 1, role: 'assistant', content: 'I will refactor the TypeScript code and fix the error' }),
    ]);

    const result = distillProject({
      projectPath,
      extractsDir,
      outputDir,
      skipIfUnchanged: false,
    });

    // 标签 ≥3
    expect(result.tags.length).toBeGreaterThanOrEqual(3);
    const tagNames = result.tags.map((t) => t.tag);
    expect(tagNames).toContain('typescript');
    expect(tagNames).toContain('react');
    expect(tagNames).toContain('vitest');

    // 主题 ≥2
    expect(result.themes.length).toBeGreaterThanOrEqual(2);
    const themeNames = result.themes.map((t) => t.theme);
    expect(themeNames).toContain('bugfix');
    expect(themeNames).toContain('testing');
    expect(themeNames).toContain('feature');

    // 覆盖率 > 0
    expect(result.stats.tagCoverage).toBeGreaterThan(0);
    expect(result.stats.requirementCount).toBe(2);
    expect(result.stats.responseCount).toBe(1);
  });

  it('幂等：相同输入重复跑返回相同产物，不重复入库', () => {
    const reqFile = path.join(extractsDir, projectHash, 'requirements.ndjsonl');
    writeNdjsonl(reqFile, [mkEntry({ id: 1, role: 'user', content: 'use typescript and react' })]);

    const r1 = distillProject({ projectPath, extractsDir, outputDir });
    const firstAt = r1.distilledAt;
    const outputFile = path.join(outputDir, `${projectHash}.json`);
    expect(fs.existsSync(outputFile)).toBe(true);

    // 等一小段时间确保 Date.now() 不同
    const wait = new Promise((r) => setTimeout(r, 20));
    return wait.then(() => {
      const r2 = distillProject({ projectPath, extractsDir, outputDir });
      // 幂等：返回旧产物（distilledAt 不变）
      expect(r2.distilledAt).toBe(firstAt);
      expect(r2.inputContentHash).toBe(r1.inputContentHash);
      expect(r2.tags).toEqual(r1.tags);
    });
  });

  it('偏好抽取（always/never/prefer/make-sure/dont）', () => {
    const reqFile = path.join(extractsDir, projectHash, 'requirements.ndjsonl');
    writeNdjsonl(reqFile, [
      mkEntry({ id: 1, role: 'user', content: 'Always use TypeScript for new files.' }),
      mkEntry({ id: 2, role: 'user', content: 'Never use any in TypeScript.' }),
      mkEntry({ id: 3, role: 'user', content: 'I prefer to use vitest over jest.' }),
      mkEntry({ id: 4, role: 'user', content: 'Make sure to run tests before commit.' }),
      mkEntry({ id: 5, role: 'user', content: "Don't forget to update the changelog." }),
    ]);

    const result = distillProject({
      projectPath,
      extractsDir,
      outputDir,
      skipIfUnchanged: false,
    });

    expect(result.preferences.length).toBeGreaterThanOrEqual(5);
    const sources = new Set(result.preferences.map((p) => p.source));
    expect(sources.has('always')).toBe(true);
    expect(sources.has('never')).toBe(true);
    expect(sources.has('prefer')).toBe(true);
    expect(sources.has('make-sure')).toBe(true);
    expect(sources.has('dont')).toBe(true);

    // 每条偏好带 sessionId
    for (const p of result.preferences) {
      expect(p.sessionId).toBeTruthy();
      expect(p.text.length).toBeGreaterThan(0);
    }
  });

  it('空产物不崩', () => {
    // 不写任何 NDJSONL 文件
    const result = distillProject({
      projectPath,
      extractsDir,
      outputDir,
      skipIfUnchanged: false,
    });
    expect(result.tags).toHaveLength(0);
    expect(result.themes).toHaveLength(0);
    expect(result.preferences).toHaveLength(0);
    expect(result.stats.requirementCount).toBe(0);
    expect(result.stats.responseCount).toBe(0);
    expect(result.stats.tagCoverage).toBe(0);
  });

  it('listDistilled / getDistilled 读取正确', () => {
    const reqFile = path.join(extractsDir, projectHash, 'requirements.ndjsonl');
    writeNdjsonl(reqFile, [mkEntry({ id: 1, role: 'user', content: 'use typescript' })]);

    distillProject({ projectPath, extractsDir, outputDir, skipIfUnchanged: false });

    // getDistilled
    const got = getDistilled(projectHash, outputDir);
    expect(got).toBeDefined();
    expect(got!.projectHash).toBe(projectHash);
    expect(got!.projectPath).toBe(projectPath);

    // listDistilled
    const list = listDistilled(outputDir);
    expect(list).toHaveLength(1);
    expect(list[0]!.projectHash).toBe(projectHash);
  });

  it('minTagCount 过滤低频标签', () => {
    const reqFile = path.join(extractsDir, projectHash, 'requirements.ndjsonl');
    writeNdjsonl(reqFile, [
      mkEntry({ id: 1, role: 'user', content: 'use typescript and react' }),
      mkEntry({ id: 2, role: 'user', content: 'use typescript again' }),
    ]);

    const result = distillProject({
      projectPath,
      extractsDir,
      outputDir,
      minTagCount: 2,
      skipIfUnchanged: false,
    });

    // typescript 出现 2 次（>=2），react 出现 1 次（被过滤）
    const tagNames = result.tags.map((t) => t.tag);
    expect(tagNames).toContain('typescript');
    expect(tagNames).not.toContain('react');
  });
});
