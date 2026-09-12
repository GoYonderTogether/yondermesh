/**
 * observe —— 统一的「看」。
 *
 * 收敛前，「看」散在 9 个工具里：search_sessions / get_session / list_active /
 * overview / extract_project_history / query_user_requirements /
 * query_agent_responses / agents / whoami。它们其实是**同一个问题的不同切法**：
 * 区别只在 scope（看哪儿）和 shape（要什么形态）。
 *
 * 收敛后一次调用带齐三个正交维度：
 *   scope  —— 看哪儿（我 / 全局 / 项目 / 会话 / 正在跑 / 树）
 *   filter —— 只要什么（角色 / 长度 / 关键词 / 时间）  ← 「筛选」是查询的一部分，不是后处理
 *   shape  —— 要什么形态（列表 / 详情 / 摘要 / 树 / 统计）
 *
 * 关键设计：`filter` 让「只筛用户发的需求」「只筛超过多少字的」「排除工具链」
 * 变成三个字段，而不是三个工具。
 */

import type { SessionStore } from '../store/index.js';
import type { SessionRecord, MessageRole } from '../store/index.js';
import { buildSituation, attachSituation, TREE_RELIABLE_SOURCES } from './situation.js';

export type ObserveScope = 'me' | 'global' | 'project' | 'session' | 'active' | 'tree';
export type ObserveShape = 'list' | 'detail' | 'summary' | 'tree' | 'stats';

export interface ObserveFilter {
  /** 只要这些角色（如 ['user'] 就只看人的话） */
  roles?: string[];
  /** 排除这些角色（如 ['tool'] 排除工具链） */
  exclude?: string[];
  /** 只要长度超过这个字数的内容 */
  minLength?: number;
  /** 关键词（大小写不敏感） */
  keyword?: string;
  /** 只看这个时间之后，支持 '7d' / '24h' / epoch ms / ISO */
  since?: string | number;
  until?: string | number;
}

export interface ObserveInput {
  scope: ObserveScope;
  /** session id（scope=session/tree）或项目路径（scope=project） */
  target?: string;
  filter?: ObserveFilter;
  shape?: ObserveShape;
  limit?: number;
  offset?: number;
  selfSessionId?: string;
  /** scope=global 时是否附带 CLI 列表 */
  includeAgents?: boolean;
}

export interface ObserveResult {
  ok: boolean;
  scope: ObserveScope;
  shape: ObserveShape;
  /** 人类/模型可读的正文 */
  text: string;
  /** 结构化数据（给需要精确处理的调用方） */
  data?: unknown;
  error?: string;
}

/** '7d' / '24h' / '30m' → epoch ms；已经是数字/ISO 就原样解析 */
export function parseWhen(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return v;
  const m = /^(\d+)\s*([smhdw])$/.exec(v.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as 's'];
    return Date.now() - n * unit;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** 按 filter 过一条消息 */
export function messageMatches(
  role: string,
  content: string,
  f: ObserveFilter | undefined,
  ts: number,
): boolean {
  if (!f) return true;
  if (f.roles && f.roles.length > 0 && !f.roles.includes(role)) return false;
  if (f.exclude && f.exclude.includes(role)) return false;
  if (f.minLength !== undefined && (content?.length ?? 0) < f.minLength) return false;
  if (f.keyword) {
    const kw = f.keyword.toLowerCase();
    if (!(content ?? '').toLowerCase().includes(kw)) return false;
  }
  const since = parseWhen(f.since);
  if (since !== undefined && ts < since) return false;
  const until = parseWhen(f.until);
  if (until !== undefined && ts > until) return false;
  return true;
}

function shortId(id: string): string {
  return id.slice(0, 12);
}

function agoText(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  if (s < 86400) return `${Math.round(s / 3600)}h 前`;
  return `${Math.round(s / 86400)}d 前`;
}

/**
 * 统一入口。CLI / MCP 共用。
 */
export async function observe(
  deps: { store: SessionStore; detectAgents?: () => unknown },
  input: ObserveInput,
): Promise<ObserveResult> {
  const { store } = deps;
  const scope = input.scope;
  const shape: ObserveShape = input.shape ?? defaultShape(scope);
  const limit = input.limit ?? 20;
  const selfId = resolveSelf(store, input);

  try {
    switch (scope) {
      case 'global':
        return globalView(store, shape, input, limit);
      case 'active':
        return activeView(store, shape, limit);
      case 'me':
        return selfView(store, selfId, shape, input, limit);
      case 'session':
        return sessionView(store, input, shape, limit);
      case 'project':
        return projectView(store, input, shape, limit);
      case 'tree':
        return treeView(store, input);
      default:
        return { ok: false, scope, shape, text: `无效 scope: ${String(scope)}`, error: 'invalid scope' };
    }
  } catch (err) {
    return {
      ok: false,
      scope,
      shape,
      text: `observe 失败: ${String(err instanceof Error ? err.message : err)}`,
      error: String(err),
    };
  }
}

function defaultShape(scope: ObserveScope): ObserveShape {
  if (scope === 'session') return 'detail';
  if (scope === 'tree') return 'tree';
  if (scope === 'global') return 'stats';
  return 'list';
}

function resolveSelf(store: SessionStore, input: ObserveInput): string | null {
  if (input.selfSessionId) {
    try {
      return store.resolveSessionId(input.selfSessionId) ?? input.selfSessionId;
    } catch {
      return input.selfSessionId;
    }
  }
  return process.env.YONDERMESH_SELF_SESSION_ID ?? null;
}

// ─── scope=global ───────────────────────────────────────────────────────

function globalView(
  store: SessionStore,
  shape: ObserveShape,
  input: ObserveInput,
  limit: number,
): ObserveResult {
  const stats = store.getSessionStats({ includeArchived: false });
  const breakdown = store.getSourceBreakdown();
  const situation = buildSituation(store, resolveSelf(store, input));

  const lines: string[] = [];
  lines.push(`本机会话总览`);
  lines.push(`  总 session : ${stats.totalSessions}（root ${stats.rootSessions} / subagent ${stats.subagentSessions}）`);
  lines.push(`  总消息     : ${stats.totalMessages}`);
  lines.push('');
  lines.push(`  按 CLI：`);
  for (const b of breakdown.slice(0, limit)) {
    lines.push(`    ${String(b.source).padEnd(14)} ${String(b.count).padStart(5)} sessions`);
  }

  return {
    ok: true,
    scope: 'global',
    shape,
    text: attachSituation(lines.join('\n'), situation),
    data: { stats, breakdown },
  };
}

// ─── scope=active ───────────────────────────────────────────────────────

function activeView(store: SessionStore, shape: ObserveShape, limit: number): ObserveResult {
  const summary = store.getActiveSessionsSummary(30 * 60 * 1000);
  const rows = summary.sessions.slice(0, limit);

  const lines: string[] = [];
  lines.push(
    `活跃 ${summary.sessions.length} 个（live ${rows.filter((r) => r.isLive).length}）` +
      ` · 等待审阅 ${store.getSessionsAwaitingReview(30 * 60 * 1000).length}`,
  );
  lines.push('');
  for (const r of rows) {
    const flag = r.isLive ? 'LIVE' : r.activityStatus;
    lines.push(
      `  [${flag.padEnd(7)}] ${String(r.source).padEnd(10)} ${shortId(r.sessionId)}  ` +
        `${agoText(r.fileModifiedAt)}  msgs=${r.messageCount}  ${r.projectPath ?? r.cwd ?? ''}`,
    );
  }

  return {
    ok: true,
    scope: 'active',
    shape,
    text: lines.join('\n'),
    data: rows,
  };
}

// ─── scope=me ───────────────────────────────────────────────────────────

function selfView(
  store: SessionStore,
  selfId: string | null,
  shape: ObserveShape,
  input: ObserveInput,
  limit: number,
): ObserveResult {
  if (!selfId) {
    return {
      ok: false,
      scope: 'me',
      shape,
      text:
        '解析不出自己的 session id。\n' +
        '  · 让 wrapper 注入 YONDERMESH_SELF_SESSION_ID（最稳）\n' +
        '  · 或显式传 self_session_id\n' +
        '  · 或在该会话对应的 cwd 下调用',
      error: 'self session unresolved',
    };
  }
  const s = store.getSession(selfId);
  if (!s) {
    return { ok: false, scope: 'me', shape, text: `会话不存在: ${selfId}`, error: 'not found' };
  }
  const situation = buildSituation(store, selfId);
  const msgs = store.getMessages(selfId).filter((m) =>
    messageMatches(m.role, m.content ?? '', input.filter, m.timestamp ?? 0),
  );
  const body = renderMessages(`你自己（${s.source} ${shortId(s.id)}）`, msgs, shape, limit);
  return { ok: true, scope: 'me', shape, text: attachSituation(body, situation), data: msgs.slice(0, limit) };
}

// ─── scope=session ──────────────────────────────────────────────────────

function sessionView(
  store: SessionStore,
  input: ObserveInput,
  shape: ObserveShape,
  limit: number,
): ObserveResult {
  const target = (input.target ?? '').trim();
  if (!target) {
    return { ok: false, scope: 'session', shape, text: 'scope=session 需要 target=<session id>', error: 'missing target' };
  }
  let id: string | null;
  try {
    id = store.resolveSessionId(target);
  } catch (err) {
    return { ok: false, scope: 'session', shape, text: String(err), error: 'ambiguous' };
  }
  if (!id) {
    return { ok: false, scope: 'session', shape, text: `找不到 session: ${target}`, error: 'not found' };
  }
  const s = store.getSession(id);
  if (!s) {
    return { ok: false, scope: 'session', shape, text: `找不到 session: ${target}`, error: 'not found' };
  }

  const msgs = store.getMessages(id).filter((m) =>
    messageMatches(m.role, m.content ?? '', input.filter, m.timestamp ?? 0),
  );
  const body = renderMessages(sessionHeader(s), msgs, shape, limit, input);
  return {
    ok: true,
    scope: 'session',
    shape,
    text: body,
    data: msgs.slice(input.offset ?? 0, (input.offset ?? 0) + limit),
  };
}

function sessionHeader(s: SessionRecord): string {
  return (
    `会话 ${shortId(s.id)}（${s.source} · ${s.topology}）\n` +
    `  项目：${s.projectPath ?? s.cwd ?? '(无)'}\n` +
    `  消息：${s.messageCount}  最后活动：${agoText(s.fileModifiedAt ?? s.lastSeenAt)}\n` +
    `  模型：${s.model ?? '(未知)'}`
  );
}

// ─── scope=project ──────────────────────────────────────────────────────

function projectView(
  store: SessionStore,
  input: ObserveInput,
  shape: ObserveShape,
  limit: number,
): ObserveResult {
  const path = (input.target ?? '').trim();
  const query = path ? { projectPath: path } : {};
  const sessions = store.querySessions({ ...query, limit: 200 } as never);
  if (sessions.length === 0) {
    return {
      ok: false,
      scope: 'project',
      shape,
      text: path ? `项目下没有会话: ${path}` : '未指定项目路径（target），且当前目录无匹配',
      error: 'not found',
    };
  }

  // 汇总模式：每个会话告诉你「筛完后还剩几条、都是什么角色」
  const perSession = sessions.map((s) => {
    const msgs = store.getMessages(s.id).filter((m) =>
      messageMatches(m.role, m.content ?? '', input.filter, m.timestamp ?? 0),
    );
    return { session: s, messages: msgs };
  });

  const totalMatched = perSession.reduce((n, p) => n + p.messages.length, 0);
  const lines: string[] = [];
  lines.push(
    `项目：${path || '(当前目录)'}  ·  ${sessions.length} 个会话  ·  筛选后命中 ${totalMatched} 条`,
  );
  if (input.filter) lines.push(`  筛选：${describeFilter(input.filter)}`);
  lines.push('');

  if (shape === 'list' || shape === 'summary') {
    for (const p of perSession.slice(0, limit)) {
      lines.push(
        `  ${shortId(p.session.id)}  ${String(p.session.source).padEnd(10)} ${String(p.messages.length).padStart(4)} 条  ` +
          `${agoText(p.session.fileModifiedAt ?? p.session.lastSeenAt)}`,
      );
      if (shape === 'summary' && p.messages.length > 0) {
        const last = p.messages[p.messages.length - 1];
        lines.push(`      ↳ ${oneLine(last.content ?? '', 110)}`);
      }
    }
    return { ok: true, scope: 'project', shape, text: lines.join('\n'), data: perSession.map((p) => ({ session: p.session.id, matched: p.messages.length })) };
  }

  // detail：直接给筛完的内容（跨会话按时间排）
  const flat = perSession
    .flatMap((p) => p.messages.map((m) => ({ ...m, sessionId: p.session.id })))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  for (const m of flat.slice(input.offset ?? 0, (input.offset ?? 0) + limit)) {
    lines.push(`[${shortId(m.sessionId)}] ${m.role}: ${oneLine(m.content ?? '', 200)}`);
  }
  if (flat.length > limit) lines.push(`… 还有 ${flat.length - limit} 条（用 limit/offset 翻页）`);
  return { ok: true, scope: 'project', shape, text: lines.join('\n'), data: flat.slice(0, limit) };
}

// ─── scope=tree ─────────────────────────────────────────────────────────

function treeView(store: SessionStore, input: ObserveInput): ObserveResult {
  const target = (input.target ?? input.selfSessionId ?? '').trim();
  if (!target) {
    return { ok: false, scope: 'tree', shape: 'tree', text: 'scope=tree 需要 target=<session id>', error: 'missing target' };
  }
  let id: string | null;
  try {
    id = store.resolveSessionId(target);
  } catch {
    id = null;
  }
  if (!id) {
    return { ok: false, scope: 'tree', shape: 'tree', text: `找不到 session: ${target}`, error: 'not found' };
  }

  const s = store.getSession(id);
  const lines: string[] = [];
  lines.push(`会话树（根：${shortId(id)}${s ? ` · ${s.source}` : ''}）`);

  const rels = store.queryRelationships(id);

  // ⚠️ 方向约定（实测确认，所有 importer 一致）：
  //   spawned_by 存的是 from=**子** 、to=**父**（子"被谁生"）。
  //   所以判断时要按这个来，别按字面读 from/to。
  //   · outgoing（from === 我）→ 我是**子**，to 是我的父
  //   · incoming（to  === 我）→ 我是**父**，from 是我的子
  const parents = rels.filter((r) => r.relationType === 'spawned_by' && r.direction === 'outgoing');
  const children = rels.filter((r) => r.relationType === 'spawned_by' && r.direction === 'incoming');

  const uniqueParents = [...new Set(parents.map((p) => p.toSessionId))];
  if (uniqueParents.length === 0) {
    lines.push('  无上级（这是个 root）');
  } else if (uniqueParents.length === 1) {
    const ps = store.getSession(uniqueParents[0]);
    lines.push(`  ↑ 由 ${shortId(uniqueParents[0])} 发起${ps ? `（${ps.source}）` : ''}`);
  } else {
    // 嵌套子代理场景：一个会话可能挂在多个上层之下（实测 520 个 subagent 也是别人的父）
    lines.push(`  ↑ 有 ${uniqueParents.length} 个上层（嵌套子代理）：`);
    for (const pid of uniqueParents.slice(0, 5)) {
      const ps = store.getSession(pid);
      lines.push(`      ${shortId(pid)}${ps ? `（${ps.source} ${ps.topology}）` : ''}`);
    }
  }

  if (children.length === 0) {
    lines.push('  ↓ 没有下属');
    if (s && !TREE_RELIABLE_SOURCES.has(s.source)) {
      lines.push(
        s.source === 'pi'
          ? '     ℹ️ pi 没有子代理机制（它的工具里没有 task 类工具）——"没有下属"是事实，不是采集缺失'
          : `     ℹ️ ${s.source} 的子代理不落独立会话文件，拿不到树边`,
      );
    }
  } else {
    lines.push(`  ↓ 起了 ${children.length} 个下属：`);
    for (const c of children.slice(0, 10)) {
      const cs = store.getSession(c.fromSessionId);
      lines.push(
        `      ${shortId(c.fromSessionId)}${cs ? `（${cs.source} ${cs.topology}）` : ''}  ` +
          `${cs ? agoText(cs.fileModifiedAt ?? cs.lastSeenAt) : ''}`,
      );
    }
    if (children.length > 10) lines.push(`      … 还有 ${children.length - 10} 个`);
  }

  return {
    ok: true,
    scope: 'tree',
    shape: 'tree',
    text: lines.join('\n'),
    data: { parents: uniqueParents, children: children.map((c) => c.fromSessionId) },
  };
}

// ─── 渲染助手 ───────────────────────────────────────────────────────────

function renderMessages(
  header: string,
  msgs: Array<{ role: string; content?: string; timestamp?: number; seq?: number }>,
  shape: ObserveShape,
  limit: number,
  input?: ObserveInput,
): string {
  const lines: string[] = [header];
  if (input?.filter) lines.push(`  筛选：${describeFilter(input.filter)}`);
  lines.push(`  命中 ${msgs.length} 条`);
  lines.push('');

  if (shape === 'stats') {
    const byRole = new Map<string, { n: number; chars: number }>();
    for (const m of msgs) {
      const e = byRole.get(m.role) ?? { n: 0, chars: 0 };
      e.n += 1;
      e.chars += (m.content ?? '').length;
      byRole.set(m.role, e);
    }
    for (const [role, e] of byRole) {
      lines.push(`  ${role.padEnd(10)} ${String(e.n).padStart(4)} 条  ${e.chars} 字`);
    }
    return lines.join('\n');
  }

  if (shape === 'summary') {
    for (const m of msgs) {
      lines.push(`  ${m.role}: ${oneLine(m.content ?? '', 140)}`);
    }
    return lines.join('\n');
  }

  const offset = input?.offset ?? 0;
  for (const m of msgs.slice(offset, offset + limit)) {
    lines.push(`--- ${m.role} (#${m.seq ?? '?'}) ---`);
    lines.push(m.content ?? '');
    lines.push('');
  }
  if (msgs.length > offset + limit) {
    lines.push(`… 还有 ${msgs.length - offset - limit} 条未显示（用 limit/offset 翻页）`);
  }
  return lines.join('\n');
}

function describeFilter(f: ObserveFilter): string {
  const bits: string[] = [];
  if (f.roles?.length) bits.push(`只要角色 ${f.roles.join('/')}`);
  if (f.exclude?.length) bits.push(`排除 ${f.exclude.join('/')}`);
  if (f.minLength !== undefined) bits.push(`≥${f.minLength} 字`);
  if (f.keyword) bits.push(`含「${f.keyword}」`);
  if (f.since) bits.push(`${f.since} 之后`);
  if (f.until) bits.push(`${f.until} 之前`);
  return bits.join(' · ') || '无';
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 供 MCP 层复用：从工具参数里挑出 filter */
export function pickFilter(raw: Record<string, unknown>): ObserveFilter | undefined {
  const f: ObserveFilter = {};
  let any = false;
  const roles = raw.roles ?? raw.include_roles;
  if (Array.isArray(roles) && roles.length > 0) {
    f.roles = roles.map(String);
    any = true;
  }
  const exclude = raw.exclude ?? raw.exclude_roles;
  if (Array.isArray(exclude) && exclude.length > 0) {
    f.exclude = exclude.map(String);
    any = true;
  }
  const minLength = raw.min_length ?? raw.minLength;
  if (typeof minLength === 'number') {
    f.minLength = minLength;
    any = true;
  }
  const keyword = raw.keyword ?? raw.query;
  if (typeof keyword === 'string' && keyword.trim()) {
    f.keyword = keyword.trim();
    any = true;
  }
  if (typeof raw.since === 'string' || typeof raw.since === 'number') {
    f.since = raw.since;
    any = true;
  }
  if (typeof raw.until === 'string' || typeof raw.until === 'number') {
    f.until = raw.until;
    any = true;
  }
  return any ? f : undefined;
}

/** MessageRole 白名单（给 MCP schema 用） */
export const OBSERVE_ROLES: MessageRole[] = ['user', 'assistant', 'system', 'tool'];
