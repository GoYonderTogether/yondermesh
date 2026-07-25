/**
 * 任务看板数据层（task-aggregation）
 *
 * 把 session 按项目聚合成"任务卡片"（状态 live/idle/stopped/failed +
 * Agent + 最后活动 + 摘要 + 设备来源），输出供前端看板与 /api/tasks。
 *
 * 任务为单位，非原始 session 列表。跨设备汇总。
 * deterministic，零 LLM（摘要取最后一条 user 消息预览）。
 */

import type { SessionStore } from '../store/index.js';
import type { SessionRecord, ActiveSummary } from '../store/index.js';

/** 任务卡片状态 */
export type TaskStatus = 'live' | 'idle' | 'stopped' | 'failed';

/** 任务类别（从内容启发式分类） */
export type TaskCategory =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'testing'
  | 'docs'
  | 'config'
  | 'other';

/** 任务卡片中的 session 摘要 */
export interface TaskSessionSummary {
  sessionId: string;
  source: string;
  deviceId: string;
  status: 'live' | 'idle' | 'stopped';
  messageCount: number;
  lastActivityAt: number;
  /** 最后一条 user 消息预览（前 100 字符） */
  lastUserPreview: string | null;
}

/** 任务卡片 */
export interface TaskCard {
  /** 确定性 id：projectHash + category */
  id: string;
  /** 项目路径（projectPath 优先，回退 cwd，再回退 '(unknown)'） */
  projectPath: string;
  /** 任务类别 */
  category: TaskCategory;
  /** 任务状态（取所有 session 的最高活跃度） */
  status: TaskStatus;
  /** 涉及的 agent 列表（去重） */
  agents: string[];
  /** 涉及的设备列表（去重） */
  devices: string[];
  /** 跨设备标记（devices.length > 1） */
  crossDevice: boolean;
  /** 聚合的 session 数 */
  sessionCount: number;
  /** 最后活动时间（max lastActivityAt） */
  lastActivityAt: number;
  /** 任务摘要（取最新 session 的最后 user 消息预览） */
  summary: string | null;
  /** 卡片下的 session 列表 */
  sessions: TaskSessionSummary[];
}

/** 聚合选项 */
export interface AggregateOptions {
  /** startedAt 闭区间起点（含），默认不限制 */
  from?: number;
  /** startedAt 闭区间终点（含），默认不限制 */
  to?: number;
  /** 活跃度窗口（毫秒，默认 30 分钟） */
  activeWithinMs?: number;
  /** 是否只返回活跃任务（live/idle），默认 false（返回全部） */
  activeOnly?: boolean;
}

/** 类别关键词（小写匹配） */
const CATEGORY_KEYWORDS: Record<Exclude<TaskCategory, 'other'>, string[]> = {
  bugfix: ['bug', 'fix', 'error', 'crash', 'broken', 'fail', 'regression', 'wrong'],
  feature: ['feature', 'add', 'implement', 'support', 'new', 'create'],
  refactor: ['refactor', 'cleanup', 'clean up', 'simplify', 'restructure', 'rename'],
  testing: ['test', 'vitest', 'jest', 'spec', 'coverage', 'mock', 'assert'],
  docs: ['doc', 'readme', 'documentation', 'comment', 'changelog', 'guide'],
  config: ['config', 'setting', 'option', 'env', 'variable', 'preference'],
};

/** 失败信号关键词 */
const FAILURE_KEYWORDS = ['error:', 'failed:', 'exception', 'panic', 'fatal', 'traceback'];

/**
 * 任务聚合器
 */
export class TaskAggregator {
  private store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  /** 聚合任务卡片 */
  aggregate(options?: AggregateOptions): TaskCard[] {
    const from = options?.from;
    const to = options?.to;
    const activeWithinMs = options?.activeWithinMs ?? 30 * 60 * 1000;
    const activeOnly = options?.activeOnly ?? false;

    const query: { startedAtFrom?: number; startedAtTo?: number; limit: number } = {
      limit: 1_000_000,
    };
    if (from != null) query.startedAtFrom = from;
    if (to != null) query.startedAtTo = to;

    const sessions = this.store.querySessions(query);

    // 活跃度判定
    const activeSummary: ActiveSummary = this.store.getActiveSessionsSummary(activeWithinMs);
    const liveIds = new Set<string>();
    const idleIds = new Set<string>();
    for (const s of activeSummary.sessions) {
      if (s.isLive) liveIds.add(s.sessionId);
      else idleIds.add(s.sessionId);
    }

    // 按 project 分组
    const byProject = new Map<string, SessionRecord[]>();
    for (const s of sessions) {
      const proj = s.projectPath ?? s.cwd ?? '(unknown)';
      const arr = byProject.get(proj) ?? [];
      arr.push(s);
      byProject.set(proj, arr);
    }

    const cards: TaskCard[] = [];
    for (const [projectPath, projSessions] of byProject) {
      // 取每个 session 的最后 user 消息预览 + 类别
      const sessionSummaries: TaskSessionSummary[] = [];
      for (const s of projSessions) {
        const isLive = liveIds.has(s.id);
        const isIdle = idleIds.has(s.id);
        const status: 'live' | 'idle' | 'stopped' = isLive ? 'live' : isIdle ? 'idle' : 'stopped';
        const lastActivityAt = s.fileModifiedAt ?? s.lastSeenAt;
        const { preview, category } = this.extractPreviewAndCategory(s.id);
        sessionSummaries.push({
          sessionId: s.id,
          source: s.source,
          deviceId: s.deviceId,
          status,
          messageCount: s.messageCount,
          lastActivityAt,
          lastUserPreview: preview,
        });
        // 标记类别到 session 上（用 _category 临时字段避免改类型）
        (s as SessionRecord & { _category?: TaskCategory })._category = category;
      }

      // 任务状态：取最高活跃度
      let hasLive = false;
      let hasIdle = false;
      let hasFailed = false;
      for (const ss of sessionSummaries) {
        if (ss.status === 'live') hasLive = true;
        else if (ss.status === 'idle') hasIdle = true;
        // 失败启发式：stopped + 最后 user 消息含失败信号
        if (ss.status === 'stopped' && ss.lastUserPreview) {
          const lower = ss.lastUserPreview.toLowerCase();
          if (FAILURE_KEYWORDS.some((k) => lower.includes(k))) {
            hasFailed = true;
          }
        }
      }
      const status: TaskStatus = hasLive ? 'live' : hasIdle ? 'idle' : hasFailed ? 'failed' : 'stopped';

      // 活跃过滤
      if (activeOnly && status === 'stopped') continue;

      // 类别：取多数票
      const category = pickCategory(projSessions);

      // agents / devices 去重
      const agents = new Set<string>();
      const devices = new Set<string>();
      let lastActivityAt = 0;
      for (const ss of sessionSummaries) {
        agents.add(ss.source);
        devices.add(ss.deviceId);
        if (ss.lastActivityAt > lastActivityAt) lastActivityAt = ss.lastActivityAt;
      }

      // 摘要：取最新 session 的最后 user 消息
      const sorted = [...sessionSummaries].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      const summary = sorted[0]?.lastUserPreview ?? null;

      cards.push({
        id: `${projectHash(projectPath)}:${category}`,
        projectPath,
        category,
        status,
        agents: [...agents].sort(),
        devices: [...devices].sort(),
        crossDevice: devices.size > 1,
        sessionCount: sessionSummaries.length,
        lastActivityAt,
        summary,
        sessions: sorted,
      });
    }

    // 按最后活动倒序
    cards.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return cards;
  }

  /** 取 session 最后一条 user 消息预览 + 推断类别 */
  private extractPreviewAndCategory(
    sessionId: string,
  ): { preview: string | null; category: TaskCategory } {
    try {
      const msgs = this.store.getMessages(sessionId);
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      const preview = lastUser ? lastUser.content.slice(0, 100) : null;
      const category = classifyCategory(preview ?? '');
      return { preview, category };
    } catch {
      return { preview: null, category: 'other' };
    }
  }
}

/** 从文本推断任务类别 */
export function classifyCategory(text: string): TaskCategory {
  const lower = text.toLowerCase();
  let best: TaskCategory = 'other';
  let bestScore = 0;
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS) as Array<
    [Exclude<TaskCategory, 'other'>, string[]]
  >) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return best;
}

/** 取多数类别（从 session 列表的 _category 临时字段） */
function pickCategory(sessions: SessionRecord[]): TaskCategory {
  const counts: Record<string, number> = {};
  for (const s of sessions) {
    const cat = (s as SessionRecord & { _category?: TaskCategory })._category ?? 'other';
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (entries[0]?.[0] as TaskCategory) ?? 'other';
}

/** 项目哈希（确定性，用于 card id） */
function projectHash(projectPath: string): string {
  // 简单哈希（避免引入 crypto 依赖到这个纯逻辑模块）
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) {
    h = (h * 31 + projectPath.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
