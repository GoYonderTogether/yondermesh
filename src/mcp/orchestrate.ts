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
import { homedir, hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import { getAdapter } from '../adapters/registry.js';
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
  const { store } = deps;
  try {
    switch (input.action) {
      case 'spawn':
        return await doSpawn(deps, input);
      case 'assign':
        return await doAssign(deps, input);
      case 'handoff':
        return doHandoff(store, input);
      case 'await':
        return doAwait(store, input);
      case 'discuss':
        return await doDiscuss(deps, input);
      case 'stop':
        return await doStop(deps, input);
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

/**
 * spawn 之后补记「父子血缘」。
 *
 * 为什么需要：pi **没有子代理机制**（工具集里没有 task 类工具，session header
 * 也没有 parent 字段），所以它自己永远不会产生 spawned_by 边。
 * 但**ymesh 自己 launch 的会话是知道父子关系的** —— 触发器会回传
 * `newSessionId`。于是这里把它补成一条真实的关系记录，
 * 让编排出来的会话在 `observe scope=tree` 里能看出归属。
 *
 * 覆盖范围说明（诚实）：只覆盖**经 ymesh 编排启动**的会话；
 * 你在终端手工起的 pi 进程，父子之间没有任何记录可依，补不了。
 */
async function recordSpawnLineage(
  store: SessionStore,
  opts: {
    cli: string;
    newSessionId?: string;
    parentSessionId?: string;
    cwd?: string;
    /** spawn 开始的时刻（用于「按时间窗找最新会话」的兜底） */
    since: number;
  },
): Promise<{ childId: string | null; via: 'reported-id' | 'cwd+time' | null }> {
  const { cli, newSessionId, parentSessionId, cwd, since } = opts;
  if (!parentSessionId) return { childId: null, via: null };
  try {
    // 新会话可能还没被扫描入库 → 先对该 CLI 做一次增量刷新（现在是毫秒级）
    const adapter = getAdapter(cli);
    if (adapter?.importerLoader) {
      const mod = (await adapter.importerLoader()) as Record<string, unknown>;
      for (const key of Object.keys(mod)) {
        if ((key.endsWith('Importer') || key.endsWith('Extractor')) && typeof mod[key] === 'function') {
          const Cls = mod[key] as new (s: unknown, o: unknown) => { import?: () => unknown };
          new Cls(store, { deviceId: hostname() }).import?.();
          break;
        }
      }
    }

    // 优先用触发器回传的 id
    let childId: string | null = null;
    let via: 'reported-id' | 'cwd+time' | null = null;
    if (newSessionId) {
      childId = store.resolveSessionId(newSessionId);
      if (childId) via = 'reported-id';
    }

    // 兜底：不是所有 CLI 都会回传新会话 id（实测 pi 的 getState 常拿不到）。
    // 这时用「同一 CLI + 同一 cwd + 启动时间在 spawn 之后」找最新那个。
    // 这是启发式：同一秒内在同一目录起了两个会话才可能认错；宁可少记也不乱记。
    if (!childId) {
      // 路径归一化：macOS 上 /tmp 实际是 /private/tmp，直接字符串比较会对不上
      //（实测就是栽在这——spawn 传 /tmp，库里存的是 /private/tmp）。
      const norm = (p: string | null | undefined): string => {
        if (!p) return '';
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      };
      const targetCwd = norm(cwd);
      const candidates = store
        .querySessions({ source: cli, limit: 50 } as never)
        .filter(
          (x) =>
            targetCwd !== '' &&
            (norm(x.projectPath) === targetCwd || norm(x.cwd) === targetCwd) &&
            (x.startedAt ?? x.lastSeenAt ?? 0) >= since - 5_000 &&
            x.id !== parentSessionId,
        )
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      if (candidates.length > 0) {
        childId = candidates[0].id;
        via = 'cwd+time';
      }
    }

    if (!childId || childId === parentSessionId) return { childId: null, via: null };
    store.addRelationship({
      fromSessionId: childId, // 方向：from=子 → to=父
      toSessionId: parentSessionId,
      relationType: 'spawned_by',
      evidence: via === 'reported-id' ? 'ymesh orchestrate spawn' : 'ymesh orchestrate spawn (cwd+time 推断)',
    });
    return { childId, via };
  } catch {
    return { childId: null, via: null }; // 血缘补记失败不该影响 spawn 本身
  }
}

async function doSpawn(
  deps: { store: SessionStore; core: MailboxCore },
  input: OrchestrateInput,
): Promise<OrchestrateResult> {
  const { store } = deps;
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

  const spawnStartedAt = Date.now();
  const res = await deps.core.send({
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

  // 补记父子血缘（pi 之类没有原生子代理机制的 CLI 也能有树了）
  let linkedChild: string | null = null;
  if (res.delivered) {
    const link = await recordSpawnLineage(store, {
      cli: cfg.cli,
      newSessionId: res.newSessionId,
      parentSessionId: input.selfSessionId,
      cwd: cfg.cwd,
      since: spawnStartedAt,
    });
    linkedChild = link.childId;
    if (linkedChild) {
      lines.push(
        `  已记血缘：${linkedChild.slice(0, 12)} 由你发起（observe scope=tree 可见）` +
          (link.via === 'cwd+time' ? '（该 CLI 没回传 id，按 cwd+时间推断的）' : ''),
      );
    }
  }

  return {
    ok: res.delivered,
    action: 'spawn',
    text: lines.join('\n'),
    data: {
      response: res.response,
      exitCode: res.exitCode,
      channel: res.channel,
      newSessionId: res.newSessionId ?? null,
      linkedChild,
    },
    error: res.error ?? undefined,
    hint: res.delivered && !linkedChild
      ? input.selfSessionId
        ? '没补上血缘：该会话还没入库，或 cwd 对不上（spawn 时给了 cwd 才容易对上）。'
        : '没补上血缘：spawn 时没带 self_session_id，不知道谁是父。'
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

/**
 * stop —— **协作式叫停**（不是 kill）。
 *
 * 为什么不做成真 kill（实测核过触发层）：ymesh 的触发器在拿到回复后就
 * `handle.stop()` 了 —— 它**从不持有长活的进程句柄**。而别的终端/IDE 里
 * 跑着的 agent 进程，ymesh 本来就没有句柄。
 * 所以「杀进程」这条路在当前架构下不存在，硬做只能是假的。
 *
 * 能真做到的：**让目标自己停**。发一条明确的叫停指令，
 * 目标在它的下一轮边界读到并自己收手 —— 这也是编排者叫停下属的常规做法。
 * 投递时机选 on_reply：如果它正在跑，now 会被双写守卫拒绝；on_reply
 * 会在它这一轮结束的那一刻送达（最早的安全点）。
 */
async function doStop(
  deps: { store: SessionStore; core: MailboxCore },
  input: OrchestrateInput,
): Promise<OrchestrateResult> {
  if (!input.target) {
    return { ok: false, action: 'stop', text: 'stop 需要 target', error: 'missing target' };
  }
  const reason = input.brief?.trim();
  const body =
    '【叫停】请立即停止当前正在进行的工作，不要再继续这一步。' +
    (reason ? `\n原因：${reason}` : '') +
    '\n请用一两句话说明：你停在哪一步、已经改动了哪些文件、有没有留下半成品。';

  const r = await agentMessage(deps, {
    action: 'send',
    to: input.target,
    body,
    delivery: 'on_reply', // 目标在跑时 now 会被拒；on_reply 是它下一轮边界，最早的安全点
    selfSessionId: input.selfSessionId,
  });
  if (r.action !== 'send') {
    return { ok: false, action: 'stop', text: '内部错误：stop 走到了 check 分支', error: 'internal' };
  }
  return {
    ok: r.ok,
    action: 'stop',
    text: r.ok
      ? `已发出叫停（协作式）：${r.to?.source ?? ''} ${r.to ? shortId(r.to.sessionId) : input.target}` +
        '\n  它会在下一轮边界读到并自己收手。'
      : `叫停失败：${r.error ?? '未知原因'}`,
    data: r,
    error: r.error,
    hint:
      '这是**协作式**叫停，不是 kill —— ymesh 的触发器拿到回复后就把子进程停了，' +
      '从不持有长活句柄，所以没有进程可杀。要真正 force-kill，得先做「句柄池」' +
      '（ymesh 长期托管子进程），那是架构级改动。',
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
