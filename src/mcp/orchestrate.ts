/**
 * orchestrate —— 统一的「管」（我对下属 agent 的动作）。
 *
 * 收敛前，这些动作散在 5 个工具里：handoff / yondermesh_launch_agent /
 * yondermesh_inject_session / yondermesh_transfer_session /
 * yondermesh_check_prior_attempts。它们其实是**同一件事在树上的不同操作**：
 * 起一个子节点 / 向已有节点派活 / 把活交给别的节点 / 等结果 / 拉几个节点互聊 / 剪枝。
 *
 * 于是收敛成一个工具 + 一个 action 参数：
 *   spawn   加子节点（可编排 cli/model/effort/cwd）
 *   assign  向已有会话派活（等价于 message(now)，但语义是"派任务"）
 *   handoff 生成接力包交给另一个 agent（跨 CLI / 跨机器）
 *   await   等子节点/目标出结果
 *   discuss 拉多个会话互相讨论（**必须异构 model**，否则是同一张嘴说三遍）
 *   stop    剪枝
 *   prior   这事以前有人试过吗（先查再动手，避免重复踩坑）
 *
 * 设计原则：本模块只做**编排决策与组装**，真正的投递仍走 MailboxCore.send /
 * agent_message —— 不重造投递层。
 */

import type { SessionStore } from '../store/index.js';
import type { MailboxCore } from '../mailbox/core.js';
import { agentMessage } from '../mailbox/unified.js';
import { buildStoreHandoff, buildSessionHandoff } from './codex-handoff.js';
import {
  findPriorAttempts,
  DEFAULT_PRIOR_ATTEMPTS_LIMIT,
  DEFAULT_PRIOR_ATTEMPTS_MIN_SCORE,
  type PriorAttemptSession,
} from '../derive/prior-attempts.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type OrchestrateAction =
  | 'spawn'
  | 'assign'
  | 'handoff'
  | 'await'
  | 'discuss'
  | 'stop'
  | 'prior';

export interface OrchestrateConfig {
  /** 用哪个 CLI 起（spawn 必填） */
  cli?: string;
  model?: string;
  effort?: string;
  /** 在哪个工作目录干活（spawn 强烈建议给） */
  cwd?: string;
  timeoutMs?: number;
}

export interface OrchestrateInput {
  action: OrchestrateAction;
  /** 目标任务（assign/await/stop：session id；handoff：source session id） */
  target?: string;
  /** 任务描述 */
  brief?: string;
  /** discuss：拉哪几个会话进来 */
  to?: string[];
  /** spawn/assign 等的执行配置 */
  config?: OrchestrateConfig;
  /** prior：要查的任务/报错关键词 */
  query?: string;
  limit?: number;
  selfSessionId?: string;
}

export interface OrchestrateResult {
  ok: boolean;
  action: OrchestrateAction;
  text: string;
  data?: unknown;
  error?: string;
  /** 给模型的下一步建议 */
  hint?: string;
}

export async function orchestrate(
  deps: { store: SessionStore; core: MailboxCore },
  input: OrchestrateInput,
): Promise<OrchestrateResult> {
  const { store, core } = deps;
  try {
    switch (input.action) {
      case 'spawn':
        return await doSpawn(core, input);
      case 'assign':
        return await doAssign(deps, input);
      case 'handoff':
        return doHandoff(store, input);
      case 'await':
        return doAwait(store, input);
      case 'discuss':
        return await doDiscuss(deps, input);
      case 'stop':
        return doStop(store, input);
      case 'prior':
        return doPrior(store, input);
      default:
        return { ok: false, action: input.action, text: `无效 action: ${String(input.action)}`, error: 'invalid action' };
    }
  } catch (err) {
    return {
      ok: false,
      action: input.action,
      text: `orchestrate 失败: ${String(err instanceof Error ? err.message : err)}`,
      error: String(err),
    };
  }
}

// ─── spawn ──────────────────────────────────────────────────────────────

async function doSpawn(core: MailboxCore, input: OrchestrateInput): Promise<OrchestrateResult> {
  const cfg = input.config ?? {};
  if (!cfg.cli) {
    return {
      ok: false,
      action: 'spawn',
      text: 'spawn 需要 config.cli（用哪个 CLI 起新会话）',
      error: 'missing cli',
      hint: '本机可用 CLI 见 agents 列表。强烈建议同时给 config.cwd，否则它不知道在哪干活。',
    };
  }
  if (!input.brief) {
    return { ok: false, action: 'spawn', text: 'spawn 需要 brief（任务描述）', error: 'missing brief' };
  }

  const res = await core.send({
    cli: cfg.cli,
    mode: 'new',
    message: input.brief,
    model: cfg.model,
    effort: cfg.effort,
    cwd: cfg.cwd,
    timeoutMs: cfg.timeoutMs,
    fromSessionId: input.selfSessionId,
  });

  const lines = [
    res.delivered ? `已起新会话（${cfg.cli}）` : `起会话失败（${cfg.cli}）`,
    cfg.cwd ? `  工作目录：${cfg.cwd}` : '  ⚠️ 未指定工作目录 —— 它可能不知道在哪干活',
    cfg.model ? `  模型：${cfg.model}${cfg.effort ? ` · effort ${cfg.effort}` : ''}` : '',
    res.error ? `  错误：${res.error}` : '',
  ].filter(Boolean);

  return {
    ok: res.delivered,
    action: 'spawn',
    text: lines.join('\n'),
    data: { response: res.response, exitCode: res.exitCode, channel: res.channel },
    error: res.error ?? undefined,
    hint: res.delivered
      ? '新会话的树状归属有两种情况：该 CLI 落独立会话文件（claude/hermes/opencode）→ 你能在 tree 里看到它；pi 不落 → 看不到。'
      : undefined,
  };
}

// ─── assign ─────────────────────────────────────────────────────────────

async function doAssign(
  deps: { store: SessionStore; core: MailboxCore },
  input: OrchestrateInput,
): Promise<OrchestrateResult> {
  if (!input.target) {
    return { ok: false, action: 'assign', text: 'assign 需要 target（派给哪个会话）', error: 'missing target' };
  }
  // 派活 = 发消息 + delivery 选择。语义上比 message 更强：这是"你去做这个"。
  const r = await agentMessage(deps, {
    action: 'send',
    to: input.target,
    body: input.brief ?? '',
    delivery: pickDelivery(input),
    selfSessionId: input.selfSessionId,
  });
  if (r.action !== 'send') {
    return { ok: false, action: 'assign', text: '内部错误：assign 走到了 check 分支', error: 'internal' };
  }
  return {
    ok: r.ok,
    action: 'assign',
    text: r.ok ? `已派活给 ${r.to?.source ?? ''} ${r.to ? shortId(r.to.sessionId) : ''}` : r.error ?? '派活失败',
    data: r,
    error: r.error,
    hint: r.hint,
  };
}

/** assign 的 delivery 策略：目标在跑就一定用 on_reply（now 会被双写守卫拒） */
function pickDelivery(input: OrchestrateInput): 'now' | 'after_turn' | 'on_reply' {
  const raw = (input as { delivery?: string }).delivery;
  if (raw === 'now' || raw === 'after_turn' || raw === 'on_reply') return raw;
  return 'on_reply';
}

// ─── handoff ────────────────────────────────────────────────────────────

function doHandoff(store: SessionStore, input: OrchestrateInput): OrchestrateResult {
  if (!input.target) {
    return { ok: false, action: 'handoff', text: 'handoff 需要 target（源会话 id）', error: 'missing target' };
  }
  // 先走原始 jsonl 路径（有 tool_call 细节），失败回退 DB（覆盖全部 adapter）
  let pkg = buildSessionHandoff(
    input.target,
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.codex', 'sessions'),
    { tailMessages: input.limit ?? 30 },
  );
  if (!pkg) pkg = buildStoreHandoff(input.target, store, { tailMessages: input.limit ?? 30 });
  if (!pkg) {
    return { ok: false, action: 'handoff', text: `找不到会话: ${input.target}`, error: 'not found' };
  }
  const lines = [
    `接力包已生成（来源 ${pkg.source}）`,
    `  会话：${pkg.session_id ?? '(未知)'}`,
    `  消息数：${pkg.message_count}  最后活动：${pkg.last_activity_sec_ago}s 前`,
    `  工作目录：${pkg.session_meta.cwd ?? '(未知)'}`,
    pkg.last_user_message ? `\n  最后一条需求：${oneLine(pkg.last_user_message, 200)}` : '',
  ].filter(Boolean);
  return { ok: true, action: 'handoff', text: lines.join('\n'), data: pkg };
}

// ─── await ──────────────────────────────────────────────────────────────

function doAwait(store: SessionStore, input: OrchestrateInput): OrchestrateResult {
  if (!input.target) {
    return { ok: false, action: 'await', text: 'await 需要 target', error: 'missing target' };
  }
  let id: string | null;
  try {
    id = store.resolveSessionId(input.target);
  } catch {
    id = null;
  }
  if (!id) return { ok: false, action: 'await', text: `找不到会话: ${input.target}`, error: 'not found' };

  const s = store.getSession(id);
  if (!s) return { ok: false, action: 'await', text: `找不到会话: ${input.target}`, error: 'not found' };

  const idleMs = Date.now() - (s.fileModifiedAt ?? s.lastSeenAt);
  const running = idleMs < 120_000;
  const msgs = store.getMessages(id);
  const last = msgs[msgs.length - 1];
  const lines = [
    running ? `还在跑（最后活动 ${Math.round(idleMs / 1000)}s 前）` : `已停（最后活动 ${Math.round(idleMs / 1000)}s 前）`,
    `  消息数：${msgs.length}`,
    last ? `  最后一条（${last.role}）：${oneLine(last.content ?? '', 180)}` : '',
  ].filter(Boolean);
  return {
    ok: true,
    action: 'await',
    text: lines.join('\n'),
    data: { running, messageCount: msgs.length, lastRole: last?.role ?? null },
    hint: running ? '还没结束。等一下再查，或先去做别的。' : undefined,
  };
}

// ─── discuss ────────────────────────────────────────────────────────────

async function doDiscuss(
  deps: { store: SessionStore; core: MailboxCore },
  input: OrchestrateInput,
): Promise<OrchestrateResult> {
  const targets = input.to ?? [];
  if (targets.length < 2) {
    return { ok: false, action: 'discuss', text: 'discuss 至少需要 2 个参与方（to: [...]）', error: 'too few targets' };
  }
  const brief = input.brief ?? '';
  if (!brief) return { ok: false, action: 'discuss', text: 'discuss 需要 brief（讨论什么）', error: 'missing brief' };

  // 异构检查：同 CLI 同模型的三方讨论 = 同一张嘴说三遍，先警告
  const sources = targets.map((t) => {
    try {
      return deps.store.getSession(deps.store.resolveSessionId(t) ?? t)?.source ?? '?';
    } catch {
      return '?';
    }
  });
  const distinct = new Set(sources).size;
  const warning =
    distinct < targets.length
      ? `⚠️ 有 ${targets.length - distinct} 个参与方是同一个 CLI —— 同构讨论收益很低，建议给它们配不同 model。`
      : '';

  const results: Array<{ to: string; ok: boolean; error?: string }> = [];
  for (const t of targets) {
    const r = await agentMessage(deps, {
      action: 'send',
      to: t,
      body: `【多方讨论】${brief}\n\n请给出你的判断和理由；若与其他方结论冲突，明确指出分歧点。`,
      delivery: pickDelivery(input),
      selfSessionId: input.selfSessionId,
    });
    results.push({ to: t, ok: r.action === 'send' ? r.ok : false, error: r.action === 'send' ? r.error : 'internal' });
  }

  const okCount = results.filter((r) => r.ok).length;
  const lines = [
    `已把讨论题发给 ${targets.length} 个会话（成功 ${okCount}）`,
    warning,
    ...results.map((r) => `  ${r.ok ? '✅' : '❌'} ${shortId(r.to)}${r.error ? ` — ${r.error}` : ''}`),
  ].filter(Boolean);
  return { ok: okCount > 0, action: 'discuss', text: lines.join('\n'), data: results, hint: warning || undefined };
}

// ─── stop ───────────────────────────────────────────────────────────────

function doStop(_store: SessionStore, input: OrchestrateInput): OrchestrateResult {
  if (!input.target) {
    return { ok: false, action: 'stop', text: 'stop 需要 target', error: 'missing target' };
  }
  // ymesh 不拥有别人的进程句柄（除自己 launch 的），所以"停"只能传达意图，不能真的 kill。
  return {
    ok: false,
    action: 'stop',
    text:
      '暂不支持：ymesh 不持有其他 agent 的进程句柄，无法真正终止它。\n' +
      '  可行的替代：给它发一条「停止当前工作」的消息（assign，delivery=on_reply）。',
    error: 'not supported',
    hint: '要真的能停，需要 ymesh 自己 launch 并持有句柄（句柄池，尚未实现）。',
  };
}

// ─── prior ──────────────────────────────────────────────────────────────

function doPrior(store: SessionStore, input: OrchestrateInput): OrchestrateResult {
  const q = (input.query ?? input.brief ?? '').trim();
  if (!q) return { ok: false, action: 'prior', text: 'prior 需要 query（要查的任务/报错）', error: 'missing query' };

  const limit = input.limit ?? DEFAULT_PRIOR_ATTEMPTS_LIMIT;
  const records = store.querySessions({ limit: 500, includeArchived: false });
  const sessions: PriorAttemptSession[] = [];
  for (const r of records) {
    const messages = store.getMessages(r.id);
    if (messages.length === 0) continue;
    sessions.push({
      id: r.id,
      source: r.source,
      cwd: r.cwd,
      projectPath: r.projectPath,
      startedAt: r.startedAt,
      lastSeenAt: r.lastSeenAt,
      messages: messages.map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
    });
  }

  const results = findPriorAttempts(
    { query: q, limit, minScore: DEFAULT_PRIOR_ATTEMPTS_MIN_SCORE },
    sessions,
  );

  const lines: string[] = [`查了 ${sessions.length} 个会话，${results.length} 个可能有关系`];
  for (const r of results.slice(0, limit)) {
    lines.push(`  ${shortId(r.sessionId)}  ${r.source ?? ''}  ${oneLine(r.conclusion ?? r.matchedSnippet ?? '', 150)}`);
  }
  if (results.length === 0) lines.push('  （没找到历史尝试 —— 这可能是新问题）');
  return {
    ok: true,
    action: 'prior',
    text: lines.join('\n'),
    data: { query: q, searchedSessions: sessions.length, count: results.length, results },
  };
}

// ─── helpers ────────────────────────────────────────────────────────────

function shortId(id: string): string {
  return id.slice(0, 12);
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
