/**
 * 情境包（situation envelope）—— 每个工具响应都自带的一小块「现在什么情况」。
 *
 * 为什么要它：
 *   模型如果要知道全局（谁在跑、谁是谁起的、谁跟我聊过），就得先调一次
 *   overview —— 多一次往返，而且**它经常会忘**。正确做法是把它本来就要调的
 *   那个响应里塞进这张全局图，让它「不需要主动想」就看得见。
 *   所以这是一个**响应的信封**，不是一个新工具。
 *
 * 数据来源（全部现有表，零迁移）：
 *   · 谁在跑 / 用户起 vs agent 起  → sessions (topology: root/subagent) + file_modified_at
 *   · 树状归属                     → session_relationships ('spawned_by')
 *   · 同项目还有谁                 → sessions.project_path
 *   · 跟谁交流过                   → agent_messages (from/to)
 */

import type { SessionStore } from '../store/index.js';

/** live 判定窗口（与 store 的 LIVE_THRESHOLD 一致） */
const LIVE_MS = 120_000;
/** 「在跑」的统计窗口：最近多久内有活动算「在场」 */
const PRESENCE_MS = 30 * 60 * 1000;

export interface SituationMe {
  sessionId: string;
  source: string;
  topology: string;
  projectPath: string | null;
  /** 谁起的我（relation = spawned_by） */
  parentId: string | null;
  /** 我起的（子会话） */
  childIds: string[];
  /** 同项目下还有谁在跑 */
  peers: Array<{ sessionId: string; source: string; topology: string; idleSec: number }>;
  /** 跟我有过交流的会话数 */
  talkedWith: number;
  /**
   * 树状归属是否可信（即：这个 CLI 有「子代理」这个概念吗）。
   *
   * 实测结论（2026-09-12 核过源码与数据）：
   *   · claude / hermes / opencode / codex —— 子代理会落**独立会话文件**并带
   *     agentId / parent_session_id 等字段 → 树边真实可建。
   *   · **pi 根本没有子代理机制** —— 它的工具集里没有 task/agent 类工具
   *     （只有 bash/edit/read/write/mcp）。所谓「起个子代理」就是拿 bash
   *     再跑一个 pi 进程，父子之间**没有任何记录**（session header 无 parent 字段，
   *     文件里也没有 parentSessionId）。
   *     所以 pi 显示 0 个 subagent 是**事实，不是采集缺失**。
   *
   * 对 pi 来说「树」只能靠人/编排层补：ymesh 自己 launch 的会话可以记关系。
   */
  treeReliable: boolean;
}

export interface Situation {
  /** 处境窗口内总共有多少会话在活动 */
  present: number;
  /** 用户发起的（root） */
  userInitiated: number;
  /** 其他 agent 发起的（subagent） */
  agentInitiated: number;
  /** 有下属的会话数（树里有分叉的节点） */
  branching: number;
  live: number;
  me?: SituationMe;
  /** 渲染好的多行文本（直接拼进工具响应） */
  text: string;
}

/** 哪些 CLI 的子代理会落成独立会话文件（因此树边可信） */
export const TREE_RELIABLE_SOURCES = new Set([
  'claude',
  'claude-code',
  'claude_code',
  'hermes',
  'opencode',
  'codex',
]);

/**
 * 组装情境包。
 *
 * @param store   SessionStore
 * @param selfId  当前会话 id（不传则只有全局部分）
 */
export function buildSituation(store: SessionStore, selfId?: string | null): Situation {
  const now = Date.now();
  let sessions: Awaited<ReturnType<SessionStore['getActiveSessionsSummary']>>['sessions'] = [];
  try {
    sessions = store.getActiveSessionsSummary(PRESENCE_MS).sessions;
  } catch {
    sessions = [];
  }

  const root = sessions.filter((s) => s.topology === 'root').length;
  const sub = sessions.filter((s) => s.topology !== 'root').length;
  const live = sessions.filter((s) => now - s.fileModifiedAt < LIVE_MS).length;

  let branching = 0;
  try {
    // 只统计「当前在处境窗口内的会话」里有多少是父节点，避免把历史也算进来
    const ids = new Set(sessions.map((s) => s.sessionId));
    const parents = new Set<string>();
    for (const s of sessions) {
      for (const r of store.queryRelationships(s.sessionId)) {
        if (r.relationType !== 'spawned_by') continue;
        const parent = r.direction === 'incoming' ? r.fromSessionId : r.toSessionId;
        if (ids.has(r.fromSessionId) || ids.has(r.toSessionId)) parents.add(parent);
      }
    }
    branching = parents.size;
  } catch {
    branching = 0;
  }

  const situation: Situation = {
    present: sessions.length,
    userInitiated: root,
    agentInitiated: sub,
    branching,
    live,
    text: '',
  };

  if (selfId) {
    situation.me = buildMe(store, selfId, sessions);
  }
  situation.text = render(situation);
  return situation;
}

function buildMe(
  store: SessionStore,
  selfId: string,
  sessions: Array<{
    sessionId: string;
    source: string;
    topology: string;
    projectPath: string | null;
    fileModifiedAt: number;
  }>,
): SituationMe | undefined {
  let session;
  try {
    session = store.getSession(selfId);
  } catch {
    return undefined;
  }
  if (!session) return undefined;

  let parentId: string | null = null;
  const childIds: string[] = [];
  try {
    // 方向约定：spawned_by = from(子) → to(父)。别按字面读 from/to。
    for (const r of store.queryRelationships(selfId)) {
      if (r.relationType !== 'spawned_by') continue;
      if (r.direction === 'outgoing') {
        // from === 我 → 我是子，to 是我的父
        if (!parentId) parentId = r.toSessionId;
      } else {
        // to === 我 → 我是父，from 是我的子
        childIds.push(r.fromSessionId);
      }
    }
  } catch {
    /* 关系表不可用就别挡着主流程 */
  }

  const now = Date.now();
  const peers = sessions
    .filter((s) => s.sessionId !== selfId && s.projectPath && s.projectPath === session.projectPath)
    .slice(0, 8)
    .map((s) => ({
      sessionId: s.sessionId,
      source: s.source,
      topology: s.topology,
      idleSec: Math.round((now - s.fileModifiedAt) / 1000),
    }));

  let talkedWith = 0;
  try {
    const msgs = store.queryAgentMessages({});
    const partners = new Set<string>();
    for (const m of msgs) {
      if (m.fromSessionId === selfId && m.toSessionId) partners.add(m.toSessionId);
      if (m.toSessionId === selfId && m.fromSessionId) partners.add(m.fromSessionId);
    }
    talkedWith = partners.size;
  } catch {
    talkedWith = 0;
  }

  return {
    sessionId: selfId,
    source: session.source,
    topology: session.topology,
    projectPath: session.projectPath ?? null,
    parentId,
    childIds,
    peers,
    talkedWith,
    treeReliable: TREE_RELIABLE_SOURCES.has(session.source),
  };
}

/** 渲染成人读的一小段（每行都带信息，不废话） */
function render(s: Situation): string {
  const parts: string[] = [];
  const bits = [`${s.present} 个会话在场（${s.live} 个正在写）`];
  bits.push(`用户发起 ${s.userInitiated} · agent 发起 ${s.agentInitiated}`);
  if (s.branching > 0) bits.push(`其中 ${s.branching} 个有下属`);
  parts.push(bits.join(' · '));

  if (s.me) {
    const me: string[] = [];
    me.push(`你：${s.me.source} ${s.me.topology}`);
    if (s.me.parentId) {
      // topology 说有父、但字段说 root 是实测存在的数据不一致（adapter 记的边含传递关系），
      // 不要假装两者都成立——直接标明。
      const inconsistent = s.me.topology === 'root';
      me.push(`树上有上级 ${s.me.parentId.slice(0, 12)}${inconsistent ? '（topology 与关系表不一致）' : ''}`);
    }
    if (s.me.childIds.length > 0) me.push(`你起了 ${s.me.childIds.length} 个`);
    if (!s.me.treeReliable) me.push('（本 CLI 没有子代理机制，所以没有上下级）');
    parts.push(me.join(' · '));
    if (s.me.peers.length > 0) {
      const peer = s.me.peers
        .slice(0, 4)
        .map((p) => `${p.source}${p.idleSec < 120 ? '*' : ''}`)
        .join(' ');
      parts.push(`同项目还有 ${s.me.peers.length} 个在跑：${peer}（* = 正在写）`);
    }
    if (s.me.talkedWith > 0) parts.push(`跟你交流过的会话：${s.me.talkedWith} 个`);
  }

  return ['── 现状 ──────────────────────────────', ...parts.map((p) => ` ${p}`), '──────────────────────────────────────'].join(
    '\n',
  );
}

/**
 * 把情境包拼到工具响应前面/后面。
 *
 * 放在**后面**：先给模型它要的答案，再接全局图——避免它把情境当成答案本身。
 */
export function attachSituation(body: string, situation: Situation | undefined): string {
  if (!situation?.text) return body;
  return `${body}\n\n${situation.text}`;
}
