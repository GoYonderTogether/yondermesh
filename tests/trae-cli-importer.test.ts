/**
 * trae-cli importer 契约测试
 *
 * 覆盖：
 *   parseTrajectory：
 *     1. 完整 trajectory：task → user，response → assistant，final_result 去重
 *     2. final_result 与 response 相同 → 去重不重复
 *     3. 无 llm_interactions → 回退 agent_steps
 *     4. OpenAI choices.message.content 格式
 *     5. 缺 task → 无首条 user
 *   TraeCliImporter：
 *     6. 导入 trajectoryFile → coverage=B，native id=basename
 *     7. cwd/projectPath = 文件目录
 *     8. 空消息 skipped
 *     9. 幂等重扫 unchanged
 *    10. 内容变化 → 新 revision
 *    11. searchPaths 发现 trajectory 命名文件
 *    12. 非 trajectory 命名文件被忽略
 *    13. 无文件 → 抛错
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { TraeCliImporter, parseTrajectory } from '../src/trae-cli/index.js';
import type { TraeCliImportStats } from '../src/trae-cli/index.js';

const DEVICE = 'mac-test';

const FULL_TRAJECTORY = {
  task: 'say hi',
  start_time: '2026-07-09T20:57:02.386255',
  end_time: '2026-07-09T20:57:16.175532',
  provider: 'openai',
  model: 'glm-4.6',
  max_steps: 2,
  llm_interactions: [
    {
      timestamp: '2026-07-09T20:57:03.000000',
      provider: 'openai',
      model: 'glm-4.6',
      input_messages: [{ role: 'user', content: 'say hi' }],
      response: { content: 'Hello!', role: 'assistant' },
    },
  ],
  agent_steps: [],
  success: true,
  final_result: 'Task completed: Hello!',
  execution_time: 13.79,
};

describe('parseTrajectory', () => {
  it('完整 trajectory：task→user，response→assistant，final_result 追加', () => {
    const parsed = parseTrajectory(FULL_TRAJECTORY, 'traj-1');
    expect(parsed).not.toBeNull();
    expect(parsed!.nativeId).toBe('traj-1');
    expect(parsed!.task).toBe('say hi');
    expect(parsed!.model).toBe('glm-4.6');
    expect(parsed!.provider).toBe('openai');
    expect(parsed!.success).toBe(true);
    expect(parsed!.finalResult).toBe('Task completed: Hello!');
    expect(parsed!.startedAt).toBe(Date.parse('2026-07-09T20:57:02.386'));
    expect(parsed!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'say hi'],
      ['assistant', 'Hello!'],
      ['assistant', 'Task completed: Hello!'],
    ]);
  });

  it('final_result 与 response 相同 → 去重', () => {
    const traj = {
      task: 'say hi',
      llm_interactions: [
        {
          input_messages: [{ role: 'user', content: 'say hi' }],
          response: { content: 'Hello!' },
        },
      ],
      final_result: 'Hello!',
    };
    const parsed = parseTrajectory(traj, 'traj-dedup');
    expect(parsed!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'say hi'],
      ['assistant', 'Hello!'],
    ]);
  });

  it('无 llm_interactions → 回退 agent_steps', () => {
    const traj = {
      task: 'do thing',
      agent_steps: [
        {
          step_number: 1,
          llm_messages: [{ role: 'user', content: 'do thing' }],
          llm_response: { content: 'doing it' },
        },
      ],
      final_result: 'done',
    };
    const parsed = parseTrajectory(traj, 'traj-steps');
    expect(parsed!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'do thing'],
      ['assistant', 'doing it'],
      ['assistant', 'done'],
    ]);
  });

  it('OpenAI choices.message.content 格式', () => {
    const traj = {
      task: 'q',
      llm_interactions: [
        {
          input_messages: [{ role: 'user', content: 'q' }],
          response: { choices: [{ message: { content: 'from choices' } }] },
        },
      ],
    };
    const parsed = parseTrajectory(traj, 'traj-oai');
    expect(parsed!.messages.find((m) => m.content === 'from choices')).toBeDefined();
  });

  it('缺 task → 无首条 user', () => {
    const traj = {
      llm_interactions: [
        {
          input_messages: [{ role: 'assistant', content: 'no task' }],
          response: { content: 'reply' },
        },
      ],
    };
    const parsed = parseTrajectory(traj, 'traj-notask');
    expect(parsed!.messages.find((m) => m.role === 'user')).toBeUndefined();
    expect(parsed!.messages.find((m) => m.content === 'reply')).toBeDefined();
  });
});

describe('TraeCliImporter', () => {
  let tmpRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-test-'));
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

  function writeTrajectory(name: string, obj: unknown): string {
    const filePath = path.join(tmpRoot, name);
    fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
    return filePath;
  }

  it('导入 trajectoryFile：coverage=B，native id=basename，cwd=文件目录', () => {
    const file = writeTrajectory('trajectory-abc.json', FULL_TRAJECTORY);

    const stats: TraeCliImportStats = new TraeCliImporter(store, {
      trajectoryFiles: [file],
      deviceId: DEVICE,
    }).import();

    expect(stats.filesScanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.source).toBe('trae_cli');
    expect(s.topology).toBe('root');
    expect(s.nativeSessionId).toBe('trajectory-abc');
    expect(s.cwd).toBe(tmpRoot);
    expect(s.projectPath).toBe(tmpRoot);
    expect(s.startedAt).toBe(Date.parse('2026-07-09T20:57:02.386'));
    expect(s.model).toBe('glm-4.6');
    expect(s.cliVersion).toBe('0.1.0');
    expect(s.originator).toBe('openai');

    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'say hi'],
      ['assistant', 'Hello!'],
      ['assistant', 'Task completed: Hello!'],
    ]);
  });

  it('空消息 trajectory skipped', () => {
    const file = writeTrajectory('trajectory-empty.json', { task: '', llm_interactions: [] });

    const stats = new TraeCliImporter(store, {
      trajectoryFiles: [file],
      deviceId: DEVICE,
    }).import();

    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  it('幂等重扫 unchanged', () => {
    const file = writeTrajectory('trajectory-idem.json', FULL_TRAJECTORY);
    const imp = new TraeCliImporter(store, { trajectoryFiles: [file], deviceId: DEVICE });
    const first = imp.import();
    expect(first.inserted).toBe(1);

    const second = imp.import();
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(1);
  });

  it('内容变化 → 新 revision', () => {
    const file = writeTrajectory('trajectory-rev.json', FULL_TRAJECTORY);
    const imp = new TraeCliImporter(store, { trajectoryFiles: [file], deviceId: DEVICE });
    imp.import();

    const modified = { ...FULL_TRAJECTORY, final_result: 'Changed result' };
    fs.writeFileSync(file, JSON.stringify(modified), 'utf8');

    const second = imp.import();
    expect(second.updated).toBe(1);
    expect(second.inserted).toBe(0);

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    const revs = store.getRevisions(s.id);
    expect(revs.length).toBe(2);
    const msgs = store.getMessages(s.id);
    expect(msgs.some((m) => m.content === 'Changed result')).toBe(true);
  });

  it('searchPaths 发现 trajectory 命名文件', () => {
    writeTrajectory('trajectory-found.json', FULL_TRAJECTORY);

    const stats = new TraeCliImporter(store, {
      searchPaths: [tmpRoot],
      deviceId: DEVICE,
    }).import();

    expect(stats.filesScanned).toBe(1);
    expect(stats.inserted).toBe(1);
  });

  it('非 trajectory 命名文件被忽略（仅 trajectory 命名文件被导入）', () => {
    // 同时放一个 trajectory 命名文件和一个非 trajectory 命名文件
    writeTrajectory('trajectory-real.json', FULL_TRAJECTORY);
    writeTrajectory('data.json', FULL_TRAJECTORY); // 名字不含 "trajectory" → 被忽略

    const stats = new TraeCliImporter(store, {
      searchPaths: [tmpRoot],
      deviceId: DEVICE,
    }).import();

    // 只扫描到 trajectory-real.json，data.json 被启发式忽略
    expect(stats.filesScanned).toBe(1);
    expect(stats.inserted).toBe(1);
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(s.nativeSessionId).toBe('trajectory-real');
  });

  it('无文件 → 抛错', () => {
    expect(() => {
      new TraeCliImporter(store, { deviceId: DEVICE }).import();
    }).toThrow(/未找到任何/);
  });
});
