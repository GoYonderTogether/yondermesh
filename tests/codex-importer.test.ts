/**
 * LOOP-004 Codex 原生 adapter 契约测试（RED 优先）
 *
 * 覆盖验收门（docs/implementation-loops.md §6）：
 *   1. 根 session：注册 coverage=A source instance，native id=session_meta.payload.id，
 *      cwd / 最早时间 / originator / source / thread_source 解析，user+assistant 可显示文本入库
 *   2. 显式 subagent：source 为对象含 subagent.thread_spawn → topology=subagent，
 *      parent_thread_id 可验证（父在同次扫描入库）时写 spawned_by
 *   3. 不可验证父：parent_thread_id 指向未入库 session → 不猜测，不写 spawned_by，保持独立
 *   4. 重复扫描幂等：不新增 revision
 *   5. 内容变更（追加消息）生成新 revision
 *   6. 脏 JSONL：单行损坏被跳过，合法行仍解析
 *   7. 无有效消息：整 session 跳过并计数
 *   8. 目录排除：非 .jsonl 文件不被扫描
 *   9. native id 回退：缺 session_meta → 稳定相对路径
 *  10. 不导入内部上下文：developer/system、reasoning、function_call(_output)、
 *      web_search_call、turn_context、event_msg、input_image 全部排除
 *
 * 真实结构（本机 ~/.codex/sessions 实测）：
 *   - 路径：<rootPath>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   - session_meta.payload：{ id, session_id(null), cwd, originator, source, thread_source, cli_version, git, ... }
 *   - 根 session：source 为字符串（vscode/exec/cli/unknown），thread_source 为 "user" 或 null
 *   - 显式 subagent：source 为对象 { subagent: { thread_spawn: { parent_thread_id, depth, agent_path, agent_nickname, agent_role } } }，
 *     此时 thread_source 为 null
 *   - response_item.payload.type=message 且 role=user/assistant 才有可显示文本：
 *       content 数组的 input_text / output_text 块（input_image 排除）
 *   - 一个 rollout 文件可含多个 session_meta（不同 id），按行序切分：每次 session_meta 切换
 *     active session，之后的消息归属该 active session；一个文件可产出多个 session 段。
 *     同一 id 的多次重发 / 被隔开的段合并为一段（消息按行序拼接）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../src/store/index.js';
import { CodexImporter, resolveCodexSessionsPath } from '../src/codex/index.js';
import type { CodexImportStats } from '../src/codex/index.js';

const DEVICE = 'mac-test';

// ─── fixture 构造 ────────────────────────────────────────────────────────────

/** 一条 JSONL 行（松散结构） */
type Line = Record<string, unknown>;

interface SessionMetaOpts {
  id: string;
  cwd?: string;
  /** 根：source 字符串；subagent：source 对象。默认 'exec'（根） */
  source?: string | object;
  threadSource?: string | null;
  originator?: string;
  timestamp?: string;
  cliVersion?: string;
}

/** 构造一条 session_meta 行 */
function sessionMeta(o: SessionMetaOpts): Line {
  return {
    type: 'session_meta',
    timestamp: o.timestamp ?? '2026-07-03T05:50:48.750Z',
    payload: {
      id: o.id,
      session_id: null,
      cwd: o.cwd ?? '/Users/zoran/Documents/projects/yondermesh',
      originator: o.originator ?? 'codex_exec',
      source: o.source ?? 'exec',
      thread_source: o.threadSource ?? 'user',
      cli_version: o.cliVersion ?? '0.142.5',
      git: { branch: 'main', commit_hash: 'abc1234', repository_url: null },
      model_provider: 'openai',
      base_instructions: null,
      timestamp: o.timestamp ?? '2026-07-03T05:50:48.750Z',
    },
  };
}

interface MessageOpts {
  role: 'user' | 'assistant' | 'developer';
  /** 文本块：user→input_text，assistant→output_text（自动）；也可显式传 blocks */
  text?: string;
  blocks?: Array<{ type: string; text?: string; image_url?: string; detail?: string }>;
  timestamp?: string;
}

/** 构造一条 response_item message 行 */
function message(o: MessageOpts): Line {
  const defaultBlockType = o.role === 'assistant' ? 'output_text' : 'input_text';
  const content =
    o.blocks !== undefined
      ? o.blocks
      : [{ type: defaultBlockType, text: o.text ?? '' }];
  return {
    type: 'response_item',
    timestamp: o.timestamp ?? '2026-07-03T05:51:00.000Z',
    payload: { type: 'message', role: o.role, content },
  };
}

/** reasoning 行（思维链，必须排除） */
function reasoning(timestamp?: string): Line {
  return {
    type: 'response_item',
    timestamp: timestamp ?? '2026-07-03T05:51:30.000Z',
    payload: { type: 'reasoning', id: 'rs_1', content: 'secret chain of thought', summary: [] },
  };
}

/** function_call 行（工具调用，必须排除） */
function functionCall(timestamp?: string): Line {
  return {
    type: 'response_item',
    timestamp: timestamp ?? '2026-07-03T05:51:40.000Z',
    payload: {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'shell',
      arguments: '{}',
    },
  };
}

/** function_call_output 行（工具结果，必须排除） */
function functionCallOutput(timestamp?: string): Line {
  return {
    type: 'response_item',
    timestamp: timestamp ?? '2026-07-03T05:51:50.000Z',
    payload: { type: 'function_call_output', call_id: 'call_1', output: 'tool result' },
  };
}

/** turn_context 行（必须排除） */
function turnContext(timestamp?: string): Line {
  return {
    type: 'turn_context',
    timestamp: timestamp ?? '2026-07-03T05:52:00.000Z',
    payload: { context: { tokens_used: 100 } },
  };
}

/** event_msg 行（内部事件，必须排除） */
function eventMsg(type = 'token_count', timestamp?: string): Line {
  return {
    type: 'event_msg',
    timestamp: timestamp ?? '2026-07-03T05:52:10.000Z',
    payload: { type, input_tokens: 10, output_tokens: 5 },
  };
}

/** 写一个 rollout JSONL 文件（按日期目录结构） */
function writeRollout(tmpRoot: string, filename: string, lines: Line[]): string {
  // 真实结构：<root>/2026/07/03/rollout-...jsonl
  const filePath = path.join(tmpRoot, '2026', '07', '03', filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

const ROOT_ID = '019e2a40-2e0a-7143-8fc5-781f315a442c';
const SUB_ID = '019dbd17-cbc1-7aa0-8745-5229962f5a70';
const PARENT_ID = '019db8aa-7e6e-7031-bb87-48601ad11a48';
const CWD = '/Users/zoran/Documents/projects/yondermesh';

/** subagent 的 source 对象（真实结构） */
function subagentSource(parentThreadId: string): object {
  return {
    subagent: {
      thread_spawn: {
        parent_thread_id: parentThreadId,
        depth: 1,
        agent_path: null,
        agent_nickname: 'Dewey',
        agent_role: 'explorer',
      },
    },
  };
}

/** 典型根 session：session_meta + user + assistant（含被排除的内部内容） */
function rootLines(id: string): Line[] {
  return [
    sessionMeta({ id, cwd: CWD, source: 'exec', threadSource: 'user', timestamp: '2026-07-03T05:50:48.750Z' }),
    message({ role: 'user', text: 'hello root', timestamp: '2026-07-03T05:51:00.000Z' }),
    // 内部上下文（必须排除）
    message({ role: 'developer', text: 'system prompt', timestamp: '2026-07-03T05:51:10.000Z' }),
    reasoning('2026-07-03T05:51:30.000Z'),
    functionCall('2026-07-03T05:51:40.000Z'),
    functionCallOutput('2026-07-03T05:51:50.000Z'),
    turnContext('2026-07-03T05:52:00.000Z'),
    eventMsg('token_count', '2026-07-03T05:52:10.000Z'),
    // 可显示 assistant 回复
    message({
      role: 'assistant',
      timestamp: '2026-07-03T05:53:00.000Z',
      blocks: [
        { type: 'output_text', text: 'root reply' },
      ],
    }),
  ];
}

// ─── 测试体 ──────────────────────────────────────────────────────────────────

describe('LOOP-004 Codex 原生 adapter', () => {
  let tmpRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loop4-'));
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

  // ── 验收门 1：根 session + metadata + coverage=A ─────────────────────────

  it('导入根 session：coverage=A source instance，native id=payload.id，cwd/最早时间/originator-source-thread_source 解析，可显示消息入库', () => {
    writeRollout(tmpRoot, `rollout-2026-07-03T05-50-48-${ROOT_ID}.jsonl`, rootLines(ROOT_ID));

    const stats: CodexImportStats = new CodexImporter(store, {
      rootPath: tmpRoot,
      deviceId: DEVICE,
    }).import();

    // 统计：扫描 1，新增 1
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);
    expect(stats.skipped).toBe(0);

    // source instance：coverage=A，source=codex，rootPath=tmpRoot
    const inst = store.getSourceInstance(stats.sourceInstanceId);
    expect(inst).toBeDefined();
    expect(inst!.source).toBe('codex');
    expect(inst!.coverage).toBe('A');
    expect(inst!.rootPath).toBe(tmpRoot);

    // session：topology=root，native id=payload.id，cwd
    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.topology).toBe('root');
    expect(s.nativeSessionId).toBe(ROOT_ID);
    expect(s.source).toBe('codex');
    expect(s.cwd).toBe(CWD);
    // LOOP-005：v0.1 把 codex 报告的 cwd 当作 projectPath/workspace scope 写入
    expect(s.projectPath).toBe(CWD);
    // 最早时间 = session_meta.timestamp（05:50:48 早于所有 response_item）
    expect(s.startedAt).toBe(Date.parse('2026-07-03T05:50:48.750Z'));

    // 消息：只有可显示文本；developer/reasoning/function_call/turn_context/event_msg 排除
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello root'],
      ['assistant', 'root reply'],
    ]);
    expect(msgs[0]!.timestamp).toBe(Date.parse('2026-07-03T05:51:00.000Z'));

    // scan_run completed
    const run = store.getScanRun(stats.scanRunId);
    expect(run.status).toBe('completed');
    expect(run.sessionsSeen).toBe(1);
    expect(run.sessionsNew).toBe(1);
    expect(run.endedAt).toBeGreaterThan(0);
  });

  // ── 验收门 2：显式 subagent + 可验证父 → spawned_by ───────────────────────

  it('显式 subagent（source=subagent 对象）：topology=subagent，可验证父写 spawned_by', () => {
    // 父根 session（独立文件）
    writeRollout(tmpRoot, `rollout-2026-04-23T12-47-54-${PARENT_ID}.jsonl`, [
      sessionMeta({ id: PARENT_ID, cwd: CWD, source: 'vscode', threadSource: 'user', timestamp: '2026-04-23T12:47:54.000Z' }),
      message({ role: 'user', text: 'parent prompt', timestamp: '2026-04-23T12:48:00.000Z' }),
      message({ role: 'assistant', text: 'parent reply', timestamp: '2026-04-23T12:49:00.000Z' }),
    ]);
    // subagent 文件：subagent meta → subagent 自身消息（纯 subagent 段，
    // 与本机 5 个真实纯 subagent 文件结构一致；关系只基于同次扫描中可验证的父段）
    writeRollout(tmpRoot, `rollout-2026-04-24T09-25-46-${SUB_ID}.jsonl`, [
      sessionMeta({
        id: SUB_ID,
        cwd: CWD,
        source: subagentSource(PARENT_ID), // 显式 subagent
        threadSource: null,
        originator: 'Codex Desktop',
        timestamp: '2026-04-24T09:25:46.000Z',
      }),
      message({ role: 'user', text: 'do sub task', timestamp: '2026-04-24T09:26:00.000Z' }),
      message({ role: 'assistant', text: 'sub reply', timestamp: '2026-04-24T09:27:00.000Z' }),
    ]);

    const stats = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    // 两个文件各产出 1 段，都入库
    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(2);
    expect(stats.subagents).toBe(1);
    expect(stats.relationships).toBe(1);
    expect(stats.unlinkedSubagents).toBe(0);

    const subs = store.querySessions({ deviceId: DEVICE, topology: 'subagent' });
    expect(subs).toHaveLength(1);
    const sub = subs[0]!;
    expect(sub.topology).toBe('subagent');
    expect(sub.nativeSessionId).toBe(SUB_ID);
    expect(sub.cwd).toBe(CWD);
    // LOOP-005：subagent 同样以 cwd 作为 projectPath 写入
    expect(sub.projectPath).toBe(CWD);
    expect(store.getMessages(sub.id).map((m) => m.content)).toEqual([
      'do sub task',
      'sub reply',
    ]);

    // 关系：subagent → parent spawned_by（父在同次扫描入库，可验证）
    const roots = store.querySessions({ deviceId: DEVICE, topology: 'root' });
    expect(roots).toHaveLength(1);
    expect(roots[0]!.nativeSessionId).toBe(PARENT_ID);
    const rels = store.queryRelationships(sub.id);
    const spawned = rels.find(
      (r) => r.relationType === 'spawned_by' && r.direction === 'outgoing',
    );
    expect(spawned).toBeDefined();
    expect(spawned!.toSessionId).toBe(roots[0]!.id);
  });

  // ── 验收门 2b：多 session 混合 rollout（A→消息→B→消息）按行序切分 ─────────

  it('多 session 混合 rollout（A→消息→B→消息）：按 session_meta 切分，各 session 只含本段消息', () => {
    const A = '019e0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const B = '019e0002-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    writeRollout(tmpRoot, `rollout-2026-07-03T05-50-48-mixed.jsonl`, [
      sessionMeta({ id: A, cwd: CWD, source: 'exec', threadSource: 'user', timestamp: '2026-07-03T05:50:48.000Z' }),
      message({ role: 'user', text: 'msg for A', timestamp: '2026-07-03T05:51:00.000Z' }),
      message({ role: 'assistant', text: 'reply A', timestamp: '2026-07-03T05:51:30.000Z' }),
      // 切到 session B（行序切分：之后消息归 B）
      sessionMeta({ id: B, cwd: CWD, source: 'exec', threadSource: 'user', timestamp: '2026-07-03T06:00:00.000Z' }),
      message({ role: 'user', text: 'msg for B', timestamp: '2026-07-03T06:01:00.000Z' }),
      message({ role: 'assistant', text: 'reply B', timestamp: '2026-07-03T06:01:30.000Z' }),
    ]);

    const stats = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    // 一个文件产出两段 session
    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(2);

    const sessions = store.querySessions({ deviceId: DEVICE, limit: 100 });
    expect(sessions).toHaveLength(2);
    const sA = sessions.find((s) => s.nativeSessionId === A)!;
    const sB = sessions.find((s) => s.nativeSessionId === B)!;
    expect(sA).toBeDefined();
    expect(sB).toBeDefined();
    // 各 session 只含本段消息，不串段
    expect(store.getMessages(sA.id).map((m) => m.content)).toEqual(['msg for A', 'reply A']);
    expect(store.getMessages(sB.id).map((m) => m.content)).toEqual(['msg for B', 'reply B']);
  });

  // ── 验收门 2c：显式 subagent 段无消息 → 跳过，不把后续父消息强归给子 ────────

  it('显式 subagent 段无可显示消息时跳过，后续消息归切到的 active session，不写 spawned_by', () => {
    // 真实混合结构：subagent meta（行1）→ parent meta（行2）→ parent 消息
    // subagent 段 0 消息 → 跳过；消息归 parent 段，不强归给子
    writeRollout(tmpRoot, `rollout-2026-04-24T09-25-46-${SUB_ID}.jsonl`, [
      sessionMeta({
        id: SUB_ID,
        cwd: CWD,
        source: subagentSource(PARENT_ID),
        threadSource: null,
        timestamp: '2026-04-24T09:25:46.000Z',
      }),
      sessionMeta({ id: PARENT_ID, cwd: CWD, source: 'vscode', threadSource: null, timestamp: '2026-04-24T09:25:47.000Z' }),
      message({ role: 'developer', text: 'instructions', timestamp: '2026-04-24T09:25:48.000Z' }),
      message({ role: 'user', text: 'parent continues here', timestamp: '2026-04-24T09:26:00.000Z' }),
      message({ role: 'assistant', text: 'parent reply', timestamp: '2026-04-24T09:27:00.000Z' }),
    ]);

    const stats = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    // 两段：subagent 段（0 消息，跳过）+ parent 段（有消息，入库）
    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.subagents).toBe(0); // subagent 段被跳过，未入库
    expect(stats.relationships).toBe(0);
    expect(stats.unlinkedSubagents).toBe(0);

    const sessions = store.querySessions({ deviceId: DEVICE, limit: 100 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.nativeSessionId).toBe(PARENT_ID);
    expect(sessions[0]!.topology).toBe('root');
    // 消息归 parent，未被强归给 subagent（developer 排除）
    expect(store.getMessages(sessions[0]!.id).map((m) => m.content)).toEqual([
      'parent continues here',
      'parent reply',
    ]);
    // 无 spawned_by 关系（subagent 未入库）
    expect(
      store.queryRelationships(sessions[0]!.id).some((r) => r.relationType === 'spawned_by'),
    ).toBe(false);
  });

  // ── 验收门 2d：同 native id 跨多 rollout 文件聚合（P1 数据丢失修复） ────────

  it('同一 native id 分布于两个 rollout 文件：聚合为 1 逻辑 session / 1 revision，getMessages 为两文件消息完整有序组合，二次扫描不变', () => {
    // 真实场景：同一 native session id 同时出现在根 rollout 文件和混合 subagent 文件
    // （后者重发父 session_meta 及部分父消息作为上下文）。旧实现逐文件 ingestSession，
    // 后一文件会以仅含本段消息的快照覆盖前一文件，revision 互覆、历史丢失，且受
    // readdir 顺序影响。修复后所有文件段先按 nativeId 聚合再入库一次。
    const SHARED = '019db8aa-7e6e-7031-bb87-48601ad11a48';
    // 文件 A：根 session 段，文件名字典序在前（04-23），消息时间戳较早
    writeRollout(tmpRoot, `rollout-2026-04-23T12-47-54-${SHARED}.jsonl`, [
      sessionMeta({ id: SHARED, cwd: CWD, source: 'exec', threadSource: 'user', timestamp: '2026-04-23T12:47:54.000Z' }),
      message({ role: 'user', text: 'msg A1', timestamp: '2026-04-23T12:48:00.000Z' }),
      message({ role: 'assistant', text: 'reply A2', timestamp: '2026-04-23T12:49:00.000Z' }),
    ]);
    // 文件 B：同 native id 的另一段，文件名字典序在后（04-24），消息时间戳较晚
    writeRollout(tmpRoot, `rollout-2026-04-24T09-25-46-mixed-${SHARED}.jsonl`, [
      sessionMeta({ id: SHARED, cwd: CWD, source: 'exec', threadSource: 'user', timestamp: '2026-04-24T09:25:46.000Z' }),
      message({ role: 'user', text: 'msg B1', timestamp: '2026-04-24T09:26:00.000Z' }),
      message({ role: 'assistant', text: 'reply B2', timestamp: '2026-04-24T09:27:00.000Z' }),
    ]);

    const importer = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE });
    const first = importer.import();

    // 统计按逻辑 session 计数：两个文件同 id → 1 个逻辑 session（旧逐文件实现 scanned=2）
    expect(first.scanned).toBe(1);
    expect(first.inserted).toBe(1);
    expect(first.updated).toBe(0);
    expect(first.unchanged).toBe(0);
    expect(first.skipped).toBe(0);

    // 只入库 1 个 session
    const sessions = store.querySessions({ deviceId: DEVICE });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.nativeSessionId).toBe(SHARED);

    // 只产生 1 个 revision（旧逐文件覆盖会因第二段内容不同而产生第 2 个 revision）
    const revs = store.getRevisions(s.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.revisionNumber).toBe(1);

    // getMessages 是两文件消息的完整有序组合（时间序 = 文件序：A1,A2,B1,B2）
    expect(store.getMessages(s.id).map((m) => [m.role, m.content])).toEqual([
      ['user', 'msg A1'],
      ['assistant', 'reply A2'],
      ['user', 'msg B1'],
      ['assistant', 'reply B2'],
    ]);

    // 二次扫描：聚合顺序确定 → 相同 content_hash → unchanged，不新增 revision
    const second = importer.import();
    expect(second.scanned).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(store.getRevisions(s.id)).toHaveLength(1);
    expect(store.getMessages(s.id)).toHaveLength(4);
  });

  // ── 验收门 2e：跨文件聚合消息按 timestamp + 稳定 tie-breaker 排序 ─────────

  it('跨文件聚合消息按 timestamp 排序（文件名字典序与时序相反时仍按时间序），相同 timestamp 用 (fileOrder, seq) 稳定 tie-break', () => {
    const SHARED = '019db8aa-7e6e-7031-bb87-48601ad11a48';
    // 文件名字典序在前（fileOrder=0），但消息时间戳较晚
    writeRollout(tmpRoot, `rollout-2026-04-23T12-47-54-aaa-${SHARED}.jsonl`, [
      sessionMeta({ id: SHARED, cwd: CWD, source: 'exec', threadSource: 'user', timestamp: '2026-04-23T12:47:54.000Z' }),
      message({ role: 'user', text: 'late-A-1', timestamp: '2026-04-23T12:50:00.000Z' }),
      // 与文件 B 的一条消息 timestamp 相同 → tie-breaker：fileOrder 小者（A=0）在前
      message({ role: 'assistant', text: 'A-tie-1245', timestamp: '2026-04-23T12:45:00.000Z' }),
      message({ role: 'assistant', text: 'late-A-2', timestamp: '2026-04-23T12:51:00.000Z' }),
    ]);
    // 文件名字典序在后（fileOrder=1），但消息时间戳较早
    writeRollout(tmpRoot, `rollout-2026-04-24T09-25-46-zzz-${SHARED}.jsonl`, [
      sessionMeta({ id: SHARED, cwd: CWD, source: 'exec', threadSource: 'user', timestamp: '2026-04-24T09:25:46.000Z' }),
      message({ role: 'user', text: 'early-B-1', timestamp: '2026-04-23T12:40:00.000Z' }),
      message({ role: 'assistant', text: 'early-B-2', timestamp: '2026-04-23T12:41:00.000Z' }),
      message({ role: 'assistant', text: 'B-tie-1245', timestamp: '2026-04-23T12:45:00.000Z' }),
    ]);

    new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    // 期望：纯按 timestamp 升序；12:45 的两条相等，按 fileOrder tie-break（A=0 在 B=1 前）
    // 若实现退化为按文件名字典序，会得到 [late-A-1, A-tie-1245, late-A-2, early-B-1, ...]（错）
    expect(store.getMessages(s.id).map((m) => m.content)).toEqual([
      'early-B-1', // 12:40 (文件 B，fileOrder=1)
      'early-B-2', // 12:41 (文件 B)
      'A-tie-1245', // 12:45 tie → fileOrder=0（文件 A）在前
      'B-tie-1245', // 12:45 tie → fileOrder=1（文件 B）在后
      'late-A-1', // 12:50 (文件 A)
      'late-A-2', // 12:51 (文件 A)
    ]);
  });

  // ── 验收门 3：不可验证父 → 不猜测，保持独立 ──────────────────────────────

  it('subagent 的 parent_thread_id 指向未入库 session 时不写 spawned_by，保持独立并计数 unlinked', () => {
    // 仅 subagent 文件，父不在扫描范围内
    writeRollout(tmpRoot, `rollout-2026-04-24T09-25-46-${SUB_ID}.jsonl`, [
      sessionMeta({
        id: SUB_ID,
        cwd: CWD,
        source: subagentSource(PARENT_ID), // 父 id 不在本扫描
        threadSource: null,
        timestamp: '2026-04-24T09:25:46.000Z',
      }),
      message({ role: 'user', text: 'orphan sub task', timestamp: '2026-04-24T09:26:00.000Z' }),
      message({ role: 'assistant', text: 'orphan sub reply', timestamp: '2026-04-24T09:27:00.000Z' }),
    ]);

    const stats = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    expect(stats.inserted).toBe(1);
    expect(stats.subagents).toBe(1);
    expect(stats.relationships).toBe(0);
    expect(stats.unlinkedSubagents).toBe(1); // 父未找到 → 未关联

    const sub = store.querySessions({ deviceId: DEVICE, topology: 'subagent' })[0]!;
    expect(sub.nativeSessionId).toBe(SUB_ID);
    // 无 spawned_by 关系
    const rels = store.queryRelationships(sub.id);
    expect(rels.some((r) => r.relationType === 'spawned_by')).toBe(false);
  });

  // ── 验收门 4：重复扫描幂等 ───────────────────────────────────────────────

  it('相同内容重复扫描幂等：不新增 revision，计入 unchanged', () => {
    writeRollout(tmpRoot, `rollout-2026-07-03T05-50-48-${ROOT_ID}.jsonl`, rootLines(ROOT_ID));

    const importer = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE });
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

  it('内容变更（追加一条 assistant 消息）生成新 revision，revision_number 递增，sourceKind=A', () => {
    const file = writeRollout(tmpRoot, `rollout-2026-07-03T05-50-48-${ROOT_ID}.jsonl`, rootLines(ROOT_ID));

    const importer = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE });
    const first = importer.import();
    expect(first.inserted).toBe(1);

    // 追加一条消息（真实场景：rollout 持续写入）
    fs.appendFileSync(
      file,
      JSON.stringify(
        message({ role: 'assistant', text: 'follow up', timestamp: '2026-07-03T06:00:00.000Z' }),
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
    expect(revs.every((r) => r.sourceKind === 'A')).toBe(true);
  });

  // ── 验收门 6：脏 JSONL ───────────────────────────────────────────────────

  it('脏 JSONL：单行损坏被跳过，合法行仍解析', () => {
    const lines = rootLines(ROOT_ID);
    const file = path.join(tmpRoot, '2026', '07', '03', `rollout-2026-07-03T05-50-48-${ROOT_ID}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 在两条合法行之间插一行无法解析的脏数据
    const good = lines.map((l) => JSON.stringify(l));
    const body = good[0]! + '\n{ this is not valid json !!!\n' + good.slice(1).join('\n') + '\n';
    fs.writeFileSync(file, body, 'utf8');

    const stats = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0); // session 整体有效，脏行跳过不计 skipped
    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    expect(store.getMessages(s.id).map((m) => m.content)).toEqual([
      'hello root',
      'root reply',
    ]);
  });

  // ── 验收门 7：无有效消息 → 跳过并计数 ───────────────────────────────────

  it('无有效消息的 session 被跳过并计入 skipped', () => {
    // 只有 session_meta + developer + reasoning + 事件（无 user/assistant 可显示文本）
    writeRollout(tmpRoot, `rollout-2026-07-03T05-50-48-${ROOT_ID}.jsonl`, [
      sessionMeta({ id: ROOT_ID, cwd: CWD, source: 'exec', threadSource: 'user' }),
      message({ role: 'developer', text: 'system prompt only' }),
      reasoning(),
      turnContext(),
      eventMsg('token_count'),
    ]);

    const stats = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 验收门 8：目录排除 / 非 .jsonl 排除 ──────────────────────────────────

  it('排除非 .jsonl 文件，不被当作 session 扫描', () => {
    writeRollout(tmpRoot, `rollout-2026-07-03T05-50-48-${ROOT_ID}.jsonl`, rootLines(ROOT_ID));
    // 同目录放一个 .json 元数据文件与一个 .lock 文件（应排除）
    const dir = path.join(tmpRoot, '2026', '07', '03');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ foo: 'bar' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'rollout.lock'), 'lock', 'utf8');
    // 一个 .txt
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'notes', 'utf8');

    const stats = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    // 只扫描到 1 个 rollout jsonl
    expect(stats.scanned).toBe(1);
    expect(stats.inserted).toBe(1);
    const nativeIds = store
      .querySessions({ deviceId: DEVICE })
      .map((s) => s.nativeSessionId);
    expect(nativeIds).toEqual([ROOT_ID]);
  });

  // ── 验收门 9：native id 回退（缺 session_meta） ──────────────────────────

  it('缺 session_meta 时用稳定相对路径作 native id，topology=root', () => {
    // 无 session_meta，只有 response_item 消息
    writeRollout(tmpRoot, `rollout-2026-07-03T05-50-48-nometa.jsonl`, [
      message({ role: 'user', text: 'no meta', timestamp: '2026-07-03T05:51:00.000Z' }),
      message({ role: 'assistant', text: 'still works', timestamp: '2026-07-03T05:52:00.000Z' }),
    ]);

    const stats = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    expect(stats.inserted).toBe(1);

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    // native id = 相对 rootPath 的 posix 路径（含日期目录与文件名）
    expect(s.nativeSessionId).toBe('2026/07/03/rollout-2026-07-03T05-50-48-nometa.jsonl');
    expect(s.topology).toBe('root');
    expect(s.cwd).toBeNull(); // 无 session_meta → 无 cwd
  });

  // ── 验收门 10：不导入内部上下文（input_image / web_search 等） ────────────

  it('不导入内部上下文：input_image 块、web_search_call、reasoning 全部排除，只保留可显示 text', () => {
    writeRollout(tmpRoot, `rollout-2026-07-03T05-50-48-${ROOT_ID}.jsonl`, [
      sessionMeta({ id: ROOT_ID, cwd: CWD, source: 'exec', threadSource: 'user' }),
      // user 消息含 input_text + input_image → 只取 input_text
      message({
        role: 'user',
        timestamp: '2026-07-03T05:51:00.000Z',
        blocks: [
          { type: 'input_text', text: 'look at this' },
          { type: 'input_image', image_url: 'data:...', detail: 'auto' },
        ],
      }),
      // web_search_call（工具调用，排除）
      {
        type: 'response_item',
        timestamp: '2026-07-03T05:51:20.000Z',
        payload: { type: 'web_search_call', id: 'ws_1', query: 'search' },
      },
      reasoning('2026-07-03T05:51:30.000Z'),
      message({
        role: 'assistant',
        timestamp: '2026-07-03T05:53:00.000Z',
        blocks: [{ type: 'output_text', text: 'final answer' }],
      }),
    ]);

    new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    const msgs = store.getMessages(s.id);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'look at this'],
      ['assistant', 'final answer'],
    ]);
  });

  // ── 验收门：input_text 多块拼接 ──────────────────────────────────────────

  it('一条消息含多个 input_text 块时拼接为一条消息', () => {
    writeRollout(tmpRoot, `rollout-2026-07-03T05-50-48-${ROOT_ID}.jsonl`, [
      sessionMeta({ id: ROOT_ID, cwd: CWD, source: 'exec', threadSource: 'user' }),
      message({
        role: 'user',
        timestamp: '2026-07-03T05:51:00.000Z',
        blocks: [
          { type: 'input_text', text: 'part one' },
          { type: 'input_text', text: 'part two' },
        ],
      }),
      message({ role: 'assistant', text: 'ok', timestamp: '2026-07-03T05:52:00.000Z' }),
    ]);

    new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();

    const s = store.querySessions({ deviceId: DEVICE })[0]!;
    const msgs = store.getMessages(s.id);
    expect(msgs[0]!.content).toBe('part one\npart two');
  });

  // ── 默认路径解析 ─────────────────────────────────────────────────────────

  describe('resolveCodexSessionsPath', () => {
    it('rootPath 选项优先', () => {
      expect(resolveCodexSessionsPath({ rootPath: '/explicit/codex' })).toBe(
        '/explicit/codex',
      );
    });

    it('无 rootPath 时回退默认 ~/.codex/sessions', () => {
      expect(resolveCodexSessionsPath()).toBe(
        path.join(os.homedir(), '.codex', 'sessions'),
      );
    });
  });

  // ── 不可读根目录 ─────────────────────────────────────────────────────────

  it('rootPath 不存在时抛出明确错误，不遗留 running 的 scan_run', () => {
    const importer = new CodexImporter(store, {
      rootPath: path.join(tmpRoot, 'does-not-exist'),
      deviceId: DEVICE,
    });
    expect(() => importer.import()).toThrowError(/codex|sessions|目录|read/i);
    expect(store.querySessions({ deviceId: DEVICE })).toHaveLength(0);
  });

  // ── 递归扫描多日期目录 ───────────────────────────────────────────────────

  it('递归扫描多日期目录下的 rollout 文件', () => {
    // 两个不同日期目录
    const f1 = path.join(tmpRoot, '2026', '07', '03', `rollout-a-${ROOT_ID}.jsonl`);
    const f2 = path.join(tmpRoot, '2026', '06', '01', `rollout-b-${SUB_ID}.jsonl`);
    fs.mkdirSync(path.dirname(f1), { recursive: true });
    fs.mkdirSync(path.dirname(f2), { recursive: true });
    fs.writeFileSync(
      f1,
      [sessionMeta({ id: ROOT_ID, cwd: CWD }), message({ role: 'user', text: 'a' }), message({ role: 'assistant', text: 'b' })]
        .map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8',
    );
    fs.writeFileSync(
      f2,
      [sessionMeta({ id: SUB_ID, cwd: CWD }), message({ role: 'user', text: 'c' }), message({ role: 'assistant', text: 'd' })]
        .map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8',
    );

    const stats = new CodexImporter(store, { rootPath: tmpRoot, deviceId: DEVICE }).import();
    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(2);
    const ids = store.querySessions({ deviceId: DEVICE }).map((s) => s.nativeSessionId).sort();
    expect(ids).toEqual([ROOT_ID, SUB_ID].sort());
  });
});
