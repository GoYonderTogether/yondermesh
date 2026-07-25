/**
 * 使用画像（portrait）
 *
 * 从 SessionStore 聚合出"你最常用哪个 agent / 哪个项目 / 高峰时段 /
 * 调研 vs 写代码占比"等指标，输出结构化 portrait JSON。
 *
 * 供前端 /api/portrait 与看板悬停摘要消费。deterministic，零 LLM。
 *
 * 工作类型启发式（无 LLM 时的确定性判定）：
 *   - toolCallCount > 0  → coding（写代码：调用了工具）
 *   - toolCallCount == 0 / null → research（调研：纯对话）
 */

import type { SessionStore } from '../store/index.js';

/** 画像中的领先项（最常用的 agent / 项目） */
export interface PortraitLeader {
  /** agent source 名 或 项目路径 */
  key: string;
  /** session 数 */
  sessions: number;
  /** 消息数 */
  messages: number;
}

/** 工作类型分布 */
export interface WorkBreakdown {
  /** 调研 session 数（toolCallCount == 0 / null） */
  research: number;
  /** 写代码 session 数（toolCallCount > 0） */
  coding: number;
  /** 调研占比 = research / total（无 session 时为 0） */
  researchRate: number;
  /** 写代码占比 = coding / total（无 session 时为 0） */
  codingRate: number;
}

/** 按 source / project 切分的聚合项 */
export interface PortraitSlice {
  sessions: number;
  messages: number;
}

/** 使用画像 JSON */
export interface Portrait {
  /** 统计窗口 [from, to]（epoch ms）；null 表示不限制 */
  from: number | null;
  to: number | null;
  /** 总 session 数 */
  totalSessions: number;
  /** 总消息数 */
  totalMessages: number;
  /** 最常用的 agent（按 session 数降序，并列取消息数多的） */
  topAgent: PortraitLeader | null;
  /** 最常用的项目 */
  topProject: PortraitLeader | null;
  /** 高峰时段（0-23，按 session 起始小时；无数据为 null） */
  peakHour: { hour: number; sessions: number } | null;
  /** 工作类型分布 */
  workBreakdown: WorkBreakdown;
  /** 按 source 切分 */
  bySource: Record<string, PortraitSlice>;
  /** 按 project 切分（projectPath 优先，回退 cwd，再回退 '(unknown)'） */
  byProject: Record<string, PortraitSlice>;
  /** 按小时切分（0-23，startedAt 缺失记为 -1） */
  byHour: Record<number, number>;
  /** 涉及的 agent 列表（去重） */
  agents: string[];
  /** 涉及的设备列表（去重） */
  devices: string[];
}

/** compute() 可选参数 */
export interface PortraitOptions {
  /** startedAt 闭区间起点（含），默认不限制 */
  from?: number;
  /** startedAt 闭区间终点（含），默认不限制 */
  to?: number;
}

/**
 * 使用画像计算器
 */
export class PortraitGenerator {
  private store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  /** 计算使用画像（默认全量，可指定时间窗口） */
  compute(options?: PortraitOptions): Portrait {
    const from = options?.from ?? null;
    const to = options?.to ?? null;

    const query: { startedAtFrom?: number; startedAtTo?: number; limit: number } = {
      limit: 1_000_000,
    };
    if (from != null) query.startedAtFrom = from;
    if (to != null) query.startedAtTo = to;

    const stats = this.store.getSessionStats(query);
    const sessions = this.store.querySessions(query);

    const bySource: Record<string, PortraitSlice> = {};
    const byProject: Record<string, PortraitSlice> = {};
    const byHour: Record<number, number> = {};
    const agents = new Set<string>();
    const devices = new Set<string>();
    let research = 0;
    let coding = 0;

    for (const s of sessions) {
      // source 切分
      const src = s.source;
      const ss = bySource[src] ?? { sessions: 0, messages: 0 };
      ss.sessions += 1;
      ss.messages += s.messageCount;
      bySource[src] = ss;
      agents.add(src);

      // project 切分
      const proj = s.projectPath ?? s.cwd ?? '(unknown)';
      const ps = byProject[proj] ?? { sessions: 0, messages: 0 };
      ps.sessions += 1;
      ps.messages += s.messageCount;
      byProject[proj] = ps;

      // device
      devices.add(s.deviceId);

      // hour
      const hour = s.startedAt != null ? new Date(s.startedAt).getHours() : -1;
      byHour[hour] = (byHour[hour] ?? 0) + 1;

      // 工作类型启发式
      if (s.toolCallCount != null && s.toolCallCount > 0) {
        coding += 1;
      } else {
        research += 1;
      }
    }

    const total = sessions.length;
    const workBreakdown: WorkBreakdown = {
      research,
      coding,
      researchRate: total > 0 ? research / total : 0,
      codingRate: total > 0 ? coding / total : 0,
    };

    return {
      from,
      to,
      totalSessions: stats.totalSessions,
      totalMessages: stats.totalMessages,
      topAgent: pickLeader(bySource),
      topProject: pickLeader(byProject),
      peakHour: pickPeakHour(byHour),
      workBreakdown,
      bySource,
      byProject,
      byHour,
      agents: [...agents],
      devices: [...devices],
    };
  }
}

/**
 * 从切分记录中选出领先项（session 数降序，并列取消息数降序，再并列取 key 升序）。
 * 空记录返回 null。
 */
function pickLeader(
  rec: Record<string, PortraitSlice>,
): PortraitLeader | null {
  const entries = Object.entries(rec);
  if (entries.length === 0) return null;
  entries.sort((a, b) => {
    if (b[1].sessions !== a[1].sessions) return b[1].sessions - a[1].sessions;
    if (b[1].messages !== a[1].messages) return b[1].messages - a[1].messages;
    return a[0].localeCompare(b[0]);
  });
  const [key, slice] = entries[0]!;
  return { key, sessions: slice.sessions, messages: slice.messages };
}

/** 从 byHour 选出高峰时段（session 数降序，并列取小时升序）。无数据返回 null。 */
function pickPeakHour(byHour: Record<number, number>): { hour: number; sessions: number } | null {
  const entries = Object.entries(byHour);
  if (entries.length === 0) return null;
  entries.sort((a, b) => {
    const av = Number(a[1]);
    const bv = Number(b[1]);
    if (bv !== av) return bv - av;
    return Number(a[0]) - Number(b[0]);
  });
  const [hourStr, cnt] = entries[0]!;
  return { hour: Number(hourStr), sessions: cnt };
}
