/**
 * Aider importer 契约测试
 *
 * 覆盖：
 *   parseAiderMarkdown：
 *     1. 单 session：user + assistant + 元数据（cliVersion/model/tokens）
 *     2. 多 session（按 `# aider chat started at` 切分）
 *     3. 多行 user 消息（heading 后续行并入）
 *     4. 无 header 文件（兜底 session index=1）
 *     5. 空文件 → 1 session 0 消息
 *   AiderImporter：
 *     6. 导入 historyFile → coverage=B source instance，native id=`.aider.chat.history.md#s<N>`
 *     7. cwd/projectPath = 文件所在目录
 *     8. 空消息 session 跳过
 *     9. 幂等重扫（unchanged）
 *    10. 内容变化 → 新 revision
 *    11. searchPaths 递归发现
 *    12. 无文件 → 抛错
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { AiderImporter, parseAiderMarkdown, AIDER_HISTORY_FILENAME } from '../src/aider/index.js';
import type { AiderImportStats } from '../src/aider/index.js';

const DEVICE = 'mac-test';

const SINGLE_SESSION_MD = [
  '# aider chat started at 2026-07-14 22:48:56',
  '',
  '> Aider v0.82.1',
  '> Model: openai/glm-5.2 with functions',
  '> Tokens: 123 sent, 456 received',
  '',
  '#### What is 2+2?',
  '',
  'The answer is 4.',
  '',
  '#### Another question',
  '',
  'Sure thing!',
  '',
].join('\n');

describe('parseAiderMarkdown', () => {
  it('单 session：提取 user/assistant 消息 + 元数据', () => {
    const sessions = parseAiderMarkdown(SINGLE_SESSION_MD);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.index).toBe(1);
    expect(s.startedAt).toBe(Date.parse('2026-07-14T22:48:56'));
    expect(s.startedAtRaw).toBe('2026-07-14 22:48:56');
    expect(s.cliVersion).toBe('0.82.1');
    expect(s.model).toBe('openai/glm-5.2');
    expect(s.totalInputTokens).toBe(123);
    expect(s.totalOutputTokens).toBe(456);
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'What is 2+2?'],
      ['assistant', 'The answer is 4.'],
      ['user', 'Another question'],
      ['assistant', 'Sure thing!'],
    ]);
  });

  it('多 session：按 # aider chat started at 切分', () => {
    const md = [
      '# aider chat started at 2026-07-14 22:48:56',
      '',
      '#### Q1',
      '',
      'A1',
      '',
      '# aider chat started at 2026-07-15 10:00:00',
      '',
      '#### Q2',
      '',
      'A2',
      '',
    ].join('\n');
    const sessions = parseAiderMarkdown(md);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.index).toBe(1);
    expect(sessions[0]!.startedAt).toBe(Date.parse('2026-07-14T22:48:56'));
    expect(sessions[0]!.messages.map((m) => m.content)).toEqual(['Q1', 'A1']);
    expect(sessions[1]!.index).toBe(2);
    expect(sessions[1]!.startedAt).toBe(Date.parse('2026-07-15T10:00:00'));
    expect(sessions[1]!.messages.map((m) => m.content)).toEqual(['Q2', 'A2']);
  });

  it('多行 user 消息：heading 后续非空行并入', () => {
    const md = [
      '# aider chat started at 2026-07-14 22:48:56',
      '',
      '#### Question line 1',
      'Question line 2',
      'Question line 3',
      '',
      'Answer here',
      '',
    ].join('\n');
    const sessions = parseAiderMarkdown(md);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages).toEqual([
      { role: 'user', content: 'Question line 1\nQuestion line 2\nQuestion line 3' },
      { role: 'assistant', content: 'Answer here' },
    ]);
  });

  it('无 header 文件：兜底开 session index=1，无 startedAt', () => {
    const md = ['#### Direct question', '', 'Direct answer', ''].join('\n');
    const sessions = parseAiderMarkdown(md);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.index).toBe(1);
    expect(sessions[0]!.startedAt).toBeUndefined();
    expect(sessions[0]!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Direct question'],
      ['assistant', 'Direct answer'],
    ]);
  });

  it('空文件：1 session 0 消息', () => {
    const sessions = parseAiderMarkdown('');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages).toHaveLength(0);
  });
});

describe('AiderImporter', () => {
  let tmpRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-test-'));
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeHistoryFile(dir: string, content: string): string {
    const filePath = path.join(dir, AIDER_HISTORY_FILENAME);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  it('导入 historyFile：coverage=B，native id 含序号，cwd=文件目录', () => {
    const projectDir = path.join(tmpRoot, 'proj1');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = writeHistoryFile(projectDir, SINGLE_SESSION_MD);

    const stats: AiderImportStats = new AiderImporter(store, {
      historyFiles: [file],
      deviceId: DEVICE,
    }).import();

    expect(stats.filesScanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.source).toBe('aider');
    expect(s.topology).toBe('root');
    expect(s.nativeSessionId).toBe(`${AIDER_HISTORY_FILENAME}#s1`);
    expect(s.cwd).toBe(projectDir);
    expect(s.projectPath).toBe(projectDir);
    expect(s.startedAt).toBe(Date.parse('2026-07-14T22:48:56'));
    expect(s.model).toBe('openai/glm-5.2');
    expect(s.cliVersion).toBe('0.82.1');
    expect(s.totalInputTokens).toBe(123);
    expect(s.totalOutputTokens).toBe(456);

    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'What is 2+2?'],
      ['assistant', 'The answer is 4.'],
      ['user', 'Another question'],
      ['assistant', 'Sure thing!'],
    ]);
  });

  it('空消息 session 跳过', () => {
    const projectDir = path.join(tmpRoot, 'proj2');
    fs.mkdirSync(projectDir, { recursive: true });
    // 只有 header 没有消息
    const file = writeHistoryFile(projectDir, '# aider chat started at 2026-07-14 22:48:56\n');

    const stats = new AiderImporter(store, {
      historyFiles: [file],
      deviceId: DEVICE,
    }).import();

    expect(stats.filesScanned).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  it('幂等重扫：第二次 unchanged', () => {
    const projectDir = path.join(tmpRoot, 'proj3');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = writeHistoryFile(projectDir, SINGLE_SESSION_MD);

    const imp = new AiderImporter(store, { historyFiles: [file], deviceId: DEVICE });
    const first = imp.import();
    expect(first.inserted).toBe(1);

    const second = imp.import();
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(1);
  });

  it('内容变化 → 新 revision', () => {
    const projectDir = path.join(tmpRoot, 'proj4');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = writeHistoryFile(projectDir, SINGLE_SESSION_MD);

    const imp = new AiderImporter(store, { historyFiles: [file], deviceId: DEVICE });
    imp.import();

    // 修改内容
    const modified = SINGLE_SESSION_MD.replace('The answer is 4.', 'The answer is 5.');
    fs.writeFileSync(file, modified, 'utf8');

    const second = imp.import();
    expect(second.updated).toBe(1);
    expect(second.inserted).toBe(0);

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    const msgs = store.getMessages(s.id);
    expect(msgs.find((m) => m.content.includes('5'))).toBeDefined();
    // revision 历史保留
    const revs = store.getRevisions(s.id);
    expect(revs.length).toBe(2);
  });

  it('searchPaths 递归发现 .aider.chat.history.md', () => {
    const projectDir = path.join(tmpRoot, 'deeply', 'nested', 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    writeHistoryFile(projectDir, SINGLE_SESSION_MD);

    const stats = new AiderImporter(store, {
      searchPaths: [tmpRoot],
      deviceId: DEVICE,
    }).import();

    expect(stats.filesScanned).toBe(1);
    expect(stats.inserted).toBe(1);
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(s.cwd).toBe(projectDir);
  });

  it('无文件 → 抛错', () => {
    expect(() => {
      new AiderImporter(store, { deviceId: DEVICE }).import();
    }).toThrow(/未找到任何/);
  });
});
