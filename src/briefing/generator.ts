/**
 * 每日晨报生成器
 *
 * 汇总当日所有设备、所有 agent 的 session，
 * 生成一份可分享的摘要。基于 SessionStore 多维切分（source / cwd / 时段 /
 * 活跃度），deterministic，零 LLM。
 *
 * 产出：
 *   - 结构化 Briefing JSON（含完成数 / 成功率 / 卡住待办 / 多维切分）
 *   - 人类可读 markdown，写入 ~/.yondermesh/briefings/<date>.md
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionStore } from '../store/index.js';

/** 晨报内容 */
export interface Briefing {
  date: string;
  totalSessions: number;
  totalMessages: number;
  agents: string[];
  devices: string[];
  sessions: BriefingSession[];
  markdown: string;
  /** 今日已结束的 session 数（非活跃） */
  completedSessions: number;
  /** 今日仍活跃的 session 数（live / idle） */
  activeSessions: number;
  /** 今日等待审阅（agent 已回复、用户未跟进）的 session 数 */
  awaitingReview: number;
  /** 完成率 = completedSessions / totalSessions（无 session 时为 1） */
  successRate: number;
  /** 按 source 切分 */
  bySource: Record<string, number>;
  /** 按 project_path / cwd 切分 */
  byProject: Record<string, number>;
  /** 按 device 切分（跨设备汇总） */
  byDevice: Record<string, number>;
  /** 按小时切分（0-23，未知的记为 -1） */
  byHour: Record<number, number>;
  /** 卡住待审阅的 session（含摘要） */
  stuckSessions: BriefingSession[];
}

/** 晨报中的 session 摘要 */
export interface BriefingSession {
  agent: string;
  device: string;
  projectPath: string;
  startedAt: number;
  messageCount: number;
  summary?: string;
}

/** generate() 可选参数（测试注入确定性时间） */
export interface GenerateOptions {
  /** 覆盖日期（YYYY-MM-DD），默认今天（本地时区） */
  date?: string;
  /** 覆盖当前时间戳（测试用） */
  now?: number;
}

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 晨报生成器
 */
export class BriefingGenerator {
  private store: SessionStore;
  private config: { enabled: boolean; output: string };
  private timer?: ReturnType<typeof setInterval>;

  constructor(store: SessionStore, config: { enabled: boolean; output: string }) {
    this.store = store;
    this.config = config;
  }

  /** 启动定时生成（默认每小时） */
  schedule(intervalMs: number = 3_600_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.generate().catch((err) => {
        console.error('[yondermesh] 晨报生成失败:', err);
      });
    }, intervalMs);
  }

  /** 取消定时 */
  unschedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 生成某天的晨报（默认今天） */
  async generate(options?: GenerateOptions): Promise<Briefing> {
    const now = options?.now ?? Date.now();
    const date = options?.date ?? this.localDate(now);
    const { startMs, endMs } = this.dayBounds(date);

    const window = { startedAtFrom: startMs, startedAtTo: endMs };

    // 权威计数（无 limit）
    const stats = this.store.getSessionStats(window);
    // 列表（含切分所需字段，上限保护）
    const sessions = this.store.querySessions({ ...window, limit: 100_000 });

    // 多维切分
    const bySource: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    const byDevice: Record<string, number> = {};
    const byHour: Record<number, number> = {};
    const agents = new Set<string>();
    const devices = new Set<string>();
    for (const s of sessions) {
      bySource[s.source] = (bySource[s.source] ?? 0) + 1;
      const proj = s.projectPath ?? s.cwd ?? '(unknown)';
      byProject[proj] = (byProject[proj] ?? 0) + 1;
      byDevice[s.deviceId] = (byDevice[s.deviceId] ?? 0) + 1;
      devices.add(s.deviceId);
      agents.add(s.source);
      const hour = s.startedAt != null ? new Date(s.startedAt).getHours() : -1;
      byHour[hour] = (byHour[hour] ?? 0) + 1;
    }

    // 活跃度判定：用 getActiveSessionsSummary（最近 30 分钟内有 mtime）识别"还在跑"
    const activeSummary = this.store.getActiveSessionsSummary(30 * 60_000);
    const activeIds = new Set(activeSummary.sessions.map((s) => s.sessionId));
    const activeSessions = sessions.filter((s) => activeIds.has(s.id)).length;
    const completedSessions = sessions.length - activeSessions;

    // 卡住待审阅：agent 已回复、用户未跟进（限定今日）
    const awaiting = this.store.getSessionsAwaitingReview(30 * 60_000);
    const awaitingToday = awaiting.filter((a) => {
      const s = this.store.getSession(a.sessionId);
      return s?.startedAt != null && s.startedAt >= startMs && s.startedAt <= endMs;
    });

    const successRate = sessions.length > 0 ? completedSessions / sessions.length : 1;

    // session 摘要列表（全量）
    const briefSessions: BriefingSession[] = sessions.map((s) => ({
      agent: s.source,
      device: s.deviceId,
      projectPath: s.projectPath ?? s.cwd ?? '(unknown)',
      startedAt: s.startedAt ?? 0,
      messageCount: s.messageCount,
    }));

    // 卡住 session 的摘要（取最后一条 user 消息预览，便于快速回忆"卡在哪"）
    const idToSession = new Map(sessions.map((s) => [s.id, s] as const));
    const stuckSessions: BriefingSession[] = awaitingToday.map((a) => {
      const s = idToSession.get(a.sessionId);
      let summary: string | undefined;
      try {
        const msgs = this.store.getMessages(a.sessionId);
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
        summary = lastUser ? lastUser.content.slice(0, 80) : a.lastMessagePreview;
      } catch {
        summary = a.lastMessagePreview;
      }
      return {
        agent: a.source,
        device: s?.deviceId ?? '(unknown)',
        projectPath: a.projectPath ?? a.cwd ?? '(unknown)',
        startedAt: s?.startedAt ?? 0,
        messageCount: a.messageCount,
        summary,
      };
    });

    const markdown = this.renderMarkdown({
      date,
      totalSessions: stats.totalSessions,
      totalMessages: stats.totalMessages,
      completedSessions,
      activeSessions,
      awaitingReview: awaitingToday.length,
      successRate,
      bySource,
      byProject,
      byDevice,
      byHour,
      agents: [...agents],
      devices: [...devices],
      stuckSessions,
      sessions: briefSessions,
    });

    if (this.config.enabled) {
      const outputPath = join(this.config.output, `${date}.md`);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, markdown, 'utf-8');
    }

    return {
      date,
      totalSessions: stats.totalSessions,
      totalMessages: stats.totalMessages,
      agents: [...agents],
      devices: [...devices],
      sessions: briefSessions,
      markdown,
      completedSessions,
      activeSessions,
      awaitingReview: awaitingToday.length,
      successRate,
      bySource,
      byProject,
      byDevice,
      byHour,
      stuckSessions,
    };
  }

  // ─── 私有助手 ────────────────────────────────────────────────────────

  /** 本地时区日期串（YYYY-MM-DD） */
  private localDate(now: number): string {
    const d = new Date(now);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** 某天的本地 [start, end] 闭区间（epoch ms） */
  private dayBounds(date: string): { startMs: number; endMs: number } {
    const startMs = new Date(`${date}T00:00:00`).getTime();
    const endMs = startMs + DAY_MS - 1;
    return { startMs, endMs };
  }

  /** 渲染 markdown */
  private renderMarkdown(input: {
    date: string;
    totalSessions: number;
    totalMessages: number;
    completedSessions: number;
    activeSessions: number;
    awaitingReview: number;
    successRate: number;
    bySource: Record<string, number>;
    byProject: Record<string, number>;
    byDevice: Record<string, number>;
    byHour: Record<number, number>;
    agents: string[];
    devices: string[];
    stuckSessions: BriefingSession[];
    sessions: BriefingSession[];
  }): string {
    const pct = (input.successRate * 100).toFixed(1);
    const lines: string[] = [];
    lines.push(`# yondermesh 晨报 · ${input.date}`);
    lines.push('');
    lines.push('## 概览');
    lines.push('');
    lines.push(`- 总 session: **${input.totalSessions}**`);
    lines.push(`- 总消息数: ${input.totalMessages}`);
    lines.push(`- 完成 / 活跃: ${input.completedSessions} / ${input.activeSessions}`);
    lines.push(`- 完成率: ${pct}%`);
    lines.push(`- 等待审阅（卡住）: ${input.awaitingReview}`);
    lines.push(`- agents: ${input.agents.join(', ') || '(无)'}`);
    lines.push(`- devices: ${input.devices.join(', ') || '(无)'}`);
    lines.push('');

    lines.push('## 按 agent');
    lines.push('');
    lines.push('| agent | sessions |');
    lines.push('|---|---|');
    for (const [k, v] of this.sortedEntries(input.bySource)) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');

    lines.push('## 按项目');
    lines.push('');
    lines.push('| 项目 | sessions |');
    lines.push('|---|---|');
    for (const [k, v] of this.sortedEntries(input.byProject)) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');

    lines.push('## 按设备');
    lines.push('');
    lines.push('| 设备 | sessions |');
    lines.push('|---|---|');
    for (const [k, v] of this.sortedEntries(input.byDevice)) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');

    lines.push('## 按小时');
    lines.push('');
    const hours = Object.keys(input.byHour)
      .map((h) => Number(h))
      .sort((a, b) => a - b);
    if (hours.length) {
      lines.push('| 小时 | sessions |');
      lines.push('|---|---|');
      for (const h of hours) {
        lines.push(`| ${h < 0 ? '未知' : h} | ${input.byHour[h]} |`);
      }
    } else {
      lines.push('(无数据)');
    }
    lines.push('');

    lines.push('## 卡住待审阅');
    lines.push('');
    if (input.stuckSessions.length === 0) {
      lines.push('(无)');
    } else {
      for (const s of input.stuckSessions) {
        lines.push(`- **${s.agent}** · ${s.projectPath} · ${s.messageCount} msg`);
        if (s.summary) lines.push(`  > ${s.summary.replace(/\n/g, ' ')}`);
      }
    }
    lines.push('');

    lines.push('## 全部 session');
    lines.push('');
    if (input.sessions.length === 0) {
      lines.push('(今日无 session)');
    } else {
      lines.push('| agent | 设备 | 项目 | 消息数 |');
      lines.push('|---|---|---|---|');
      for (const s of input.sessions) {
        lines.push(`| ${s.agent} | ${s.device} | ${s.projectPath} | ${s.messageCount} |`);
      }
    }
    lines.push('');

    return lines.join('\n');
  }

  /** Record 按 value 降序、key 升序排列为 [k, v] 数组 */
  private sortedEntries(rec: Record<string, number>): Array<[string, number]> {
    return Object.entries(rec).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
}
