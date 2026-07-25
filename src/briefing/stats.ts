/**
 * 工作统计（stats）
 *
 * 多维切片聚合：按天 / 项目 / 模型 统计 session 数与消息数。
 * 复用 SessionStore 现有查询方法（querySessions / getSessionStats），不改 schema。
 *
 * 供 `ymesh stats` 命令与前端 /api/stats 消费。deterministic，零 LLM。
 */

import type { SessionStore } from '../store/index.js';

/** 切片聚合项 */
export interface StatsSlice {
  sessions: number;
  messages: number;
}

/** 工作统计 JSON */
export interface WorkStats {
  /** 统计窗口 [from, to]（epoch ms）；null 表示不限制 */
  from: number | null;
  to: number | null;
  /** 总 session 数 */
  totalSessions: number;
  /** 总消息数 */
  totalMessages: number;
  /** root session 数 */
  rootSessions: number;
  /** subagent session 数 */
  subagentSessions: number;
  /** 涉及的 agent 列表 */
  agents: string[];
  /** 涉及的设备列表 */
  devices: string[];
  /** 按天切分（YYYY-MM-DD，本地时区） */
  byDay: Record<string, StatsSlice>;
  /** 按项目切分（projectPath 优先，回退 cwd，再回退 '(unknown)'） */
  byProject: Record<string, StatsSlice>;
  /** 按模型切分（model 为 null 时记为 '(unknown)'） */
  byModel: Record<string, StatsSlice>;
}

/** compute() 可选参数 */
export interface StatsOptions {
  /** startedAt 闭区间起点（含），默认不限制 */
  from?: number;
  /** startedAt 闭区间终点（含），默认不限制 */
  to?: number;
}

/**
 * 工作统计计算器
 */
export class StatsGenerator {
  private store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  /** 计算工作统计（默认全量，可指定时间窗口） */
  compute(options?: StatsOptions): WorkStats {
    const from = options?.from ?? null;
    const to = options?.to ?? null;

    const query: { startedAtFrom?: number; startedAtTo?: number; limit: number } = {
      limit: 1_000_000,
    };
    if (from != null) query.startedAtFrom = from;
    if (to != null) query.startedAtTo = to;

    const stats = this.store.getSessionStats(query);
    const sessions = this.store.querySessions(query);

    const byDay: Record<string, StatsSlice> = {};
    const byProject: Record<string, StatsSlice> = {};
    const byModel: Record<string, StatsSlice> = {};
    const agents = new Set<string>();
    const devices = new Set<string>();

    for (const s of sessions) {
      agents.add(s.source);
      devices.add(s.deviceId);

      // 按天：startedAt 缺失记为 '(unknown)'
      const dayKey = s.startedAt != null ? this.localDate(s.startedAt) : '(unknown)';
      bumpSlice(byDay, dayKey, s.messageCount);

      // 按项目
      const projKey = s.projectPath ?? s.cwd ?? '(unknown)';
      bumpSlice(byProject, projKey, s.messageCount);

      // 按模型
      const modelKey = s.model ?? '(unknown)';
      bumpSlice(byModel, modelKey, s.messageCount);
    }

    return {
      from,
      to,
      totalSessions: stats.totalSessions,
      totalMessages: stats.totalMessages,
      rootSessions: stats.rootSessions,
      subagentSessions: stats.subagentSessions,
      agents: [...agents],
      devices: [...devices],
      byDay,
      byProject,
      byModel,
    };
  }

  /** 本地时区日期串（YYYY-MM-DD） */
  private localDate(ms: number): string {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

/** 累加切片计数 */
function bumpSlice(rec: Record<string, StatsSlice>, key: string, messages: number): void {
  const slice = rec[key] ?? { sessions: 0, messages: 0 };
  slice.sessions += 1;
  slice.messages += messages;
  rec[key] = slice;
}

/** 按天切分的排序键数组（日期升序，'(unknown)' 排最后） */
export function sortedDays(byDay: Record<string, StatsSlice>): string[] {
  return Object.keys(byDay).sort((a, b) => {
    if (a === '(unknown)') return 1;
    if (b === '(unknown)') return -1;
    return a.localeCompare(b);
  });
}
