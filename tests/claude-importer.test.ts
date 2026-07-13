/**
 * LOOP-003 Claude Code 原生 adapter 契约测试（RED 优先）
 *
 * 覆盖验收门（docs/implementation-loops.md §5）：
 *   1. 根 session：注册 coverage=A source instance，native id=sessionId，
 *      cwd / 最早时间 / user+assistant 可显示文本消息可解析，思维链/tool_use 被排除
 *   2. 子 agent：topology=subagent，native id=parentRootId:agentId，spawned_by 关系
 *   3. sidechain：isSidechain=true 的子 agent 额外写 sidechain_of
 *   4. 重复扫描幂等：不新增 revision
 *   5. 内容变更（追加消息）生成新 revision
 *   6. 脏 JSONL：单行损坏被跳过，合法行仍解析
 *   7. 无有效消息：整 session 跳过并计数
 *   8. 关系与拓扑：root 不被当成 subagent；queryRelationships 双向可见
 *   9. 路径排除：tool-results/ 目录与 .meta.json 不被扫描
 *  10. native id 回退：根缺 sessionId → 相对路径；子缺 agentId → 相对路径，不与根冲突
 *
 * fixture：在临时目录构造与 ~/.claude/projects 相同的结构
 *   <root>/<projectDir>/<uuid>.jsonl                       —— 根
 *   <root>/<projectDir>/<uuid>/subagents/agent-<id>.jsonl   —— 子 agent
 *   <root>/<projectDir>/<uuid>/subagents/agent-<id>.meta.json —— 元数据(排除)
 *   <root>/<projectDir>/<uuid>/tool-results/<...>           —— 工具结果(排除)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import {
  ClaudeCodeImporter,
  resolveClaudeProjectsPath,
} from '../src/claude/index.js';
import type { ClaudeImportStats } from '../src/claude/index.js';

const DEVICE = 'mac-test';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

/** 一条 JSONL 行（松散结构，构造真实 Claude Code 事件） */
type Line = Record<string, unknown>;

interface EntryOpts {
  type: 'user' | 'assistant';
  role?: 'user' | 'assistant';
  /** 字符串正文；或省略，用 blocks */
  text?: string;
  /** content 数组的块 */
  blocks?: Array<{ type: string; text?: string; name?: string }>;
  isMeta?: boolean;
  isSidechain?: boolean;
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  timestamp?: string;
  parentUuid?: string | null;
}

function entry(o: EntryOpts): Line {
  const content =
    o.blocks !== undefined ? o.blocks : o.text !== undefined ? o.text : '';
  return {
    parentUuid: o.parentUuid ?? null,
    isSidechain: o.isSidechain ?? false,
    type: o.type,
    message: { role: o.role ?? o.type, content },
    ...(o.isMeta ? { isMeta: true } : {}),
    ...(o.timestamp ? { timestamp: o.timestamp } : {}),
    userType: 'external',
    cwd: o.cwd,
    sessionId: o.sessionId,
    version: '2.1.207',
    gitBranch: 'main',
    ...(o.agentId ? { agentId: o.agentId } : {}),
  };
}

/** 写一个 JSONL 文件（lines 序列化为每行一个 JSON） */
function writeJsonl(filePath: string, lines: Line[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
}

const ROOT = 'a5d96231-9518-44e8-833f-a664f6a0118f';
const SUB_AGENT = 'a1175c32858e72462';
const PROJECT_DIR = '-Users-zoran-Documents-projects-yondermesh';
const CWD = '/Users/zoran/Documents/projects/yondermesh';

function projectRoot(tmpRoot: string): string {
  return path.join(tmpRoot, PROJECT_DIR);
}

/** 典型根 session 的两条可显示消息 */
function rootLines(sessionId: string): Line[] {
  return [
    entry({
      type: 'user',
      text: 'hello root',
      sessionId,
      cwd: CWD,
      timestamp: '2026-07-13T01:00:00.000Z',
    }),
    entry({
      type: 'assistant',
      sessionId,
      cwd: CWD,
      timestamp: '2026-07-13T01:01:00.000Z',
      blocks: [
        { type: 'thinking', text: 'internal chain-of-thought' }, // CoT 必须排除
        { type: 'text', text: 'root reply' }, // 可显示文本
        { type: 'tool_use', name: 'Bash' }, // 工具调用结构，排除
      ],
    }),
  ];
}

// ─── 测试体 ──────────────────────────────────────────────────────────────────

describe('LOOP-003 Claude Code 原生 adapter', () => {
  let tmpRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-loop3-'));
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

  // ── 验收门 1：根 session 解析 + coverage=A source instance ───────────────

  it('导入根 session：coverage=A source instance，native id=sessionId，cwd/最早时间/可显示消息入库，CoT 与 tool_use 被排除', () => {
    writeJsonl(path.join(projectRoot(tmpRoot), `${ROOT}.jsonl`), rootLines(ROOT));

    const importer = new ClaudeCodeImporter(store, {
      rootPath: tmpRoot,
      deviceId: DEVICE,
    });
    const stats: ClaudeImportStats = importer.import();

    // 统计：扫描 1，新增 1
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);
    expect(stats.skipped).toBe(0);

    // source instance：coverage=A，source=claude-code，rootPath=tmpRoot
    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst).toBeDefined();
    expect(inst!.source).toBe('claude-code');
    expect(inst!.coverage).toBe('A');
    expect(inst!.rootPath).toBe(tmpRoot);

    // session：topology=root，native id=sessionId，cwd
    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.topology).toBe('root');
    expect(s.nativeSessionId).toBe(ROOT);
    expect(s.source).toBe('claude-code');
    expect(s.cwd).toBe(CWD);
    expect(s.startedAt).toBe(Date.parse('2026-07-13T01:00:00.000Z'));

    // 消息：只有可显示文本；thinking/tool_use 被排除
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello root'],
      ['assistant', 'root reply'],
    ]);
    expect(msgs[0]!.timestamp).toBe(Date.parse('2026-07-13T01:00:00.000Z'));

    // scan_run completed
    const run = store.getScanRun(stats.scanRunId);
    expect(run.status).toBe('completed');
    expect(run.sessionsSeen).toBe(1);
    expect(run.sessionsNew).toBe(1);
    expect(run.endedAt).toBeGreaterThan(0);
  });

  // ── 验收门 2：子 agent ───────────────────────────────────────────────────

  it('导入子 agent：topology=subagent，native id=parentRootId:agentId，写 spawned_by 关系', () => {
    // 根 + 一个子 agent（子 agent 的 sessionId 指向父根）
    writeJsonl(path.join(projectRoot(tmpRoot), `${ROOT}.jsonl`), rootLines(ROOT));
    writeJsonl(
      path.join(projectRoot(tmpRoot), ROOT, 'subagents', `agent-${SUB_AGENT}.jsonl`),
      [
        entry({
          type: 'user',
          text: 'do sub task',
          sessionId: ROOT, // 子 agent 的 sessionId 指向父根
          agentId: SUB_AGENT,
          isSidechain: false,
          cwd: CWD,
          timestamp: '2026-07-13T02:00:00.000Z',
        }),
        entry({
          type: 'assistant',
          sessionId: ROOT,
          agentId: SUB_AGENT,
          isSidechain: false,
          cwd: CWD,
          timestamp: '2026-07-13T02:01:00.000Z',
          blocks: [{ type: 'text', text: 'sub reply' }],
        }),
      ],
    );

    const stats = new ClaudeCodeImporter(store, {
      rootPath: tmpRoot,
      deviceId: DEVICE,
    }).import();

    // 扫描到 2 个（1 根 + 1 子），都新增
    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(2);

    const subs = store.querySessions({ deviceId: DEVICE, topology: 'subagent' });
    expect(subs).toHaveLength(1);
    const sub = subs[0]!;
    expect(sub.topology).toBe('subagent');
    expect(sub.nativeSessionId).toBe(`${ROOT}:${SUB_AGENT}`); // parentRootId:agentId
    expect(sub.cwd).toBe(CWD);
    expect(store.getMessages(sub.id).map((m) => m.content)).toEqual([
      'do sub task',
      'sub reply',
    ]);

    // 关系：子 → 父 spawned_by
    const roots = store.querySessions({ deviceId: DEVICE, topology: 'root' });
    const rels = store.queryRelationships(sub.id);
    const spawned = rels.find(
      (r) => r.relationType === 'spawned_by' && r.direction === 'outgoing',
    );
    expect(spawned).toBeDefined();
    expect(spawned!.toSessionId).toBe(roots[0]!.id);
    // sidechain_of 不应存在（isSidechain=false）
    expect(rels.some((r) => r.relationType === 'sidechain_of')).toBe(false);
  });

  // ── 验收门 3：sidechain ──────────────────────────────────────────────────

  it('isSidechain=true 的子 agent 额外写 sidechain_of 关系', () => {
    writeJsonl(path.join(projectRoot(tmpRoot), `${ROOT}.jsonl`), rootLines(ROOT));
    writeJsonl(
      path.join(projectRoot(tmpRoot), ROOT, 'subagents', `agent-${SUB_AGENT}.jsonl`),
      [
        entry({
          type: 'user',
          text: 'sidechain prompt',
          sessionId: ROOT,
          agentId: SUB_AGENT,
          isSidechain: true, // sidechain 子 agent
          cwd: CWD,
          timestamp: '2026-07-13T03:00:00.000Z',
        }),
        entry({
          type: 'assistant',
          sessionId: ROOT,
          agentId: SUB_AGENT,
          isSidechain: true,
          cwd: CWD,
          timestamp: '2026-07-13T03:01:00.000Z',
          blocks: [{ type: 'text', text: 'side reply' }],
        }),
      ],
    );

    new ClaudeCodeImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    const sub = store.querySessions({ deviceId: DEVICE, topology: 'subagent' })[0]!;
    const rels = store.queryRelationships(sub.id);
    expect(rels.some((r) => r.relationType === 'spawned_by')).toBe(true);
    expect(rels.some((r) => r.relationType === 'sidechain_of')).toBe(true);
  });

  // ── 验收门 4：重复扫描幂等 ───────────────────────────────────────────────

  it('相同内容重复扫描幂等：不新增 revision，计入 unchanged', () => {
    writeJsonl(path.join(projectRoot(tmpRoot), `${ROOT}.jsonl`), rootLines(ROOT));

    const importer = new ClaudeCodeImporter(store, {
      rootPath: tmpRoot,
      deviceId: DEVICE,
    });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    const second = importer.import();
    expect(second.scanned).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);

    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    expect(store.getRevisions(sessions[0]!.id)).toHaveLength(1);
  });

  // ── 验收门 5：内容变更生成新 revision ────────────────────────────────────

  it('内容变更（追加一条 assistant 消息）生成新 revision，revision_number 递增', () => {
    const file = path.join(projectRoot(tmpRoot), `${ROOT}.jsonl`);
    writeJsonl(file, rootLines(ROOT));

    const importer = new ClaudeCodeImporter(store, {
      rootPath: tmpRoot,
      deviceId: DEVICE,
    });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    // 追加一条消息（真实场景：session 文件持续写入）
    fs.appendFileSync(
      file,
      JSON.stringify(
        entry({
          type: 'assistant',
          text: 'follow up',
          sessionId: ROOT,
          cwd: CWD,
          timestamp: '2026-07-13T05:00:00.000Z',
        }),
      ) + '\n',
      'utf8',
    );

    const second = importer.import();
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(0);

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    const revs = store.getRevisions(s.id);
    expect(revs.map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(revs[1]!.contentHash).not.toBe(revs[0]!.contentHash);
    expect(store.getMessages(s.id)).toHaveLength(3); // 2 原始 + 1 追加
    // revision sourceKind=A（原生覆盖等级）
    expect(revs.every((r) => r.sourceKind === 'A')).toBe(true);
  });

  // ── 验收门 6：脏 JSONL ───────────────────────────────────────────────────

  it('脏 JSONL：单行损坏被跳过，合法行仍解析', () => {
    const file = path.join(projectRoot(tmpRoot), `${ROOT}.jsonl`);
    fs.mkdirSync(projectRoot(tmpRoot), { recursive: true });
    const good = rootLines(ROOT).map((l) => JSON.stringify(l)).join('\n');
    // 在两条合法行之间插一行无法解析的脏数据
    fs.writeFileSync(
      file,
      good.split('\n')[0]! +
        '\n{ this is not valid json !!!\n' +
        good.split('\n')[1]! +
        '\n',
      'utf8',
    );

    const stats = new ClaudeCodeImporter(store, {
      rootPath: tmpRoot,
      deviceId: DEVICE,
    }).import();

    // 仍然成功导入（脏行被跳过）
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0); // session 整体有效，不计入 skipped
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getMessages(s.id).map((m) => m.content)).toEqual([
      'hello root',
      'root reply',
    ]);
  });

  // ── 验收门 7：无有效消息 → 跳过并计数 ───────────────────────────────────

  it('无有效消息的 session 被跳过并计入 skipped', () => {
    // 只有 mode/permission-mode 等非消息行 + isMeta 行 + 纯 thinking 的 assistant
    writeJsonl(path.join(projectRoot(tmpRoot), `${ROOT}.jsonl`), [
      { type: 'mode', mode: 'normal', sessionId: ROOT, cwd: CWD },
      entry({
        type: 'user',
        text: 'caveat',
        isMeta: true, // meta 行不算可显示消息
        sessionId: ROOT,
        cwd: CWD,
        timestamp: '2026-07-13T01:00:00.000Z',
      }),
      entry({
        type: 'assistant',
        sessionId: ROOT,
        cwd: CWD,
        timestamp: '2026-07-13T01:01:00.000Z',
        blocks: [{ type: 'thinking', text: 'only thinking' }], // 无 text 块
      }),
    ]);

    const stats = new ClaudeCodeImporter(store, {
      rootPath: tmpRoot,
      deviceId: DEVICE,
    }).import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 验收门 8：关系与拓扑 ─────────────────────────────────────────────────

  it('root 不被当成 subagent；spawned_by 双向可见（父端 incoming，子端 outgoing）', () => {
    writeJsonl(path.join(projectRoot(tmpRoot), `${ROOT}.jsonl`), rootLines(ROOT));
    writeJsonl(
      path.join(projectRoot(tmpRoot), ROOT, 'subagents', `agent-${SUB_AGENT}.jsonl`),
      [
        entry({
          type: 'user',
          text: 'sub',
          sessionId: ROOT,
          agentId: SUB_AGENT,
          cwd: CWD,
          timestamp: '2026-07-13T02:00:00.000Z',
        }),
        entry({
          type: 'assistant',
          sessionId: ROOT,
          agentId: SUB_AGENT,
          cwd: CWD,
          timestamp: '2026-07-13T02:01:00.000Z',
          blocks: [{ type: 'text', text: 'ok' }],
        }),
      ],
    );

    new ClaudeCodeImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    const roots = store.querySessions({ deviceId: DEVICE, topology: 'root' });
    const subs = store.querySessions({ deviceId: DEVICE, topology: 'subagent' });
    expect(roots).toHaveLength(1);
    expect(subs).toHaveLength(1);

    const parentRels = store.queryRelationships(roots[0]!.id);
    // 父端看到 incoming spawned_by
    expect(
      parentRels.some(
        (r) => r.relationType === 'spawned_by' && r.direction === 'incoming',
      ),
    ).toBe(true);

    const childRels = store.queryRelationships(subs[0]!.id);
    expect(
      childRels.some(
        (r) => r.relationType === 'spawned_by' && r.direction === 'outgoing',
      ),
    ).toBe(true);
  });

  // ── 验收门 9：路径排除 ───────────────────────────────────────────────────

  it('排除 tool-results/ 目录与 .meta.json 文件，不被当作 session 扫描', () => {
    writeJsonl(path.join(projectRoot(tmpRoot), `${ROOT}.jsonl`), rootLines(ROOT));
    // tool-results 目录下放一个 .jsonl（应整体排除）
    writeJsonl(
      path.join(projectRoot(tmpRoot), ROOT, 'tool-results', 'noise.jsonl'),
      [entry({ type: 'user', text: 'tool result noise', sessionId: 'noise' })],
    );
    // .meta.json 文件（应排除）
    fs.mkdirSync(
      path.join(projectRoot(tmpRoot), ROOT, 'subagents'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        projectRoot(tmpRoot),
        ROOT,
        'subagents',
        `agent-${SUB_AGENT}.meta.json`,
      ),
      JSON.stringify({ agentType: 'claude', description: 'meta' }),
      'utf8',
    );
    // 一个真实子 agent，供对照
    writeJsonl(
      path.join(projectRoot(tmpRoot), ROOT, 'subagents', `agent-${SUB_AGENT}.jsonl`),
      [
        entry({
          type: 'user',
          text: 'real sub',
          sessionId: ROOT,
          agentId: SUB_AGENT,
          cwd: CWD,
          timestamp: '2026-07-13T02:00:00.000Z',
        }),
        entry({
          type: 'assistant',
          sessionId: ROOT,
          agentId: SUB_AGENT,
          cwd: CWD,
          timestamp: '2026-07-13T02:01:00.000Z',
          blocks: [{ type: 'text', text: 'ok' }],
        }),
      ],
    );

    const stats = new ClaudeCodeImporter(store, {
      rootPath: tmpRoot,
      deviceId: DEVICE,
    }).import();

    // 只扫描到 1 根 + 1 子；tool-results 与 .meta.json 不计入
    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(2);
    const nativeIds = store
      .querySessions({ deviceId: DEVICE })
      .map((s) => s.nativeSessionId);
    expect(nativeIds).not.toContain('noise');
    expect(nativeIds.sort()).toEqual([ROOT, `${ROOT}:${SUB_AGENT}`].sort());
  });

  // ── 验收门 10：native id 回退 ────────────────────────────────────────────

  it('根缺 sessionId 时用相对路径作 native id；子缺 agentId 时用相对路径，不与根冲突', () => {
    // 根：不带 sessionId 字段
    const rootLinesNoSid: Line[] = [
      entry({
        type: 'user',
        text: 'no sid',
        sessionId: undefined as unknown as string,
        cwd: CWD,
        timestamp: '2026-07-13T01:00:00.000Z',
      }),
      entry({
        type: 'assistant',
        sessionId: undefined as unknown as string,
        cwd: CWD,
        timestamp: '2026-07-13T01:01:00.000Z',
        blocks: [{ type: 'text', text: 'r' }],
      }),
    ];
    // 去掉 entry() 在 sessionId=undefined 时仍写 sessionId:undefined → 删掉该键
    for (const l of rootLinesNoSid) delete (l as Record<string, unknown>).sessionId;
    writeJsonl(path.join(projectRoot(tmpRoot), `nosid.jsonl`), rootLinesNoSid);

    // 子 agent：不带 agentId 字段，sessionId 指向父（但父没有 sid，关系无法建）
    const subLinesNoAid: Line[] = [
      entry({
        type: 'user',
        text: 'no aid',
        sessionId: ROOT,
        agentId: undefined as unknown as string,
        cwd: CWD,
        timestamp: '2026-07-13T02:00:00.000Z',
      }),
      entry({
        type: 'assistant',
        sessionId: ROOT,
        agentId: undefined as unknown as string,
        cwd: CWD,
        timestamp: '2026-07-13T02:01:00.000Z',
        blocks: [{ type: 'text', text: 's' }],
      }),
    ];
    for (const l of subLinesNoAid) delete (l as Record<string, unknown>).agentId;
    writeJsonl(
      path.join(projectRoot(tmpRoot), 'parent-uuid', 'subagents', `agent-x.jsonl`),
      subLinesNoAid,
    );

    const stats = new ClaudeCodeImporter(store, {
      rootPath: tmpRoot,
      deviceId: DEVICE,
    }).import();
    expect(stats.inserted).toBe(2);

    const sessions = store.querySessions({ deviceId: DEVICE });
    const nativeIds = sessions.map((s) => s.nativeSessionId);
    // 根的 native id = 相对路径（含项目目录与文件名）
    expect(nativeIds.some((id) => id.endsWith('nosid.jsonl'))).toBe(true);
    // 子的 native id = 相对路径（含 subagents/agent-x.jsonl）
    expect(nativeIds.some((id) => id.includes('subagents/agent-x.jsonl'))).toBe(true);
    // 两个 native id 互不相同（不冲突）
    expect(new Set(nativeIds).size).toBe(2);
    // 根用 sessionId 回退时 topology 仍为 root；子为 subagent
    const sub = sessions.find((s) => s.topology === 'subagent');
    expect(sub).toBeDefined();
  });

  // ── 默认路径解析 ─────────────────────────────────────────────────────────

  describe('resolveClaudeProjectsPath', () => {
    it('rootPath 选项优先', () => {
      expect(resolveClaudeProjectsPath({ rootPath: '/explicit/root' })).toBe(
        '/explicit/root',
      );
    });

    it('无 rootPath 时回退默认 ~/.claude/projects', () => {
      const resolved = resolveClaudeProjectsPath();
      expect(resolved).toBe(path.join(os.homedir(), '.claude', 'projects'));
    });
  });

  // ── 不可读根目录 ─────────────────────────────────────────────────────────

  it('rootPath 不存在时抛出明确错误，不遗留 running 的 scan_run', () => {
    const importer = new ClaudeCodeImporter(store, {
      rootPath: path.join(tmpRoot, 'does-not-exist'),
      deviceId: DEVICE,
    });
    expect(() => importer.import()).toThrowError(/claude|projects|目录|read/i);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });
});
