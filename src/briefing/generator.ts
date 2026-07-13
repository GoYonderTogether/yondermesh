/**
 * 每日晨报生成器
 *
 * 汇总当日所有设备、所有 agent 的 session，
 * 生成一份可分享的摘要。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqliteCollectorStore } from '../collector/store.js';
import type { BriefingConfig } from '../daemon/config.js';

/** 晨报内容 */
export interface Briefing {
  date: string;
  totalSessions: number;
  totalMessages: number;
  agents: string[];
  devices: string[];
  sessions: BriefingSession[];
  markdown: string;
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

/**
 * 晨报生成器
 */
export class BriefingGenerator {
  private store: SqliteCollectorStore;
  private config: BriefingConfig;
  private timer?: ReturnType<typeof setInterval>;

  constructor(store: SqliteCollectorStore, config: BriefingConfig) {
    this.store = store;
    this.config = config;
  }

  /** 启动定时生成（每天 0 点） */
  schedule(): void {
    // 简化：每小时检查一次是否到生成时间
    this.timer = setInterval(() => {
      this.generate().catch(err => {
        console.error('[yondermesh] 晨报生成失败:', err);
      });
    }, 3_600_000);
  }

  /** 取消定时 */
  unschedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 生成今天的晨报 */
  async generate(): Promise<Briefing> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayEnd = todayStart + 86_400_000;

    const result = this.store.query({ since: todayStart, until: todayEnd, limit: 100 });
    const sessions = result.sessions;

    const agents = [...new Set(sessions.map(s => s.agent))];
    const devices = [...new Set(sessions.map(s => s.device))];
    const totalMessages = sessions.reduce((sum, s) => sum + s.messageCount, 0);

    const date = now.toISOString().split('T')[0]!;
    const markdown = this.toMarkdown({
      date,
      totalSessions: sessions.length,
      totalMessages,
      agents,
      devices,
      sessions: sessions.map(s => ({
        agent: s.agent,
        device: s.device,
        projectPath: s.projectPath,
        startedAt: s.startedAt,
        messageCount: s.messageCount,
        summary: s.summary,
      })),
    });

    // 写入文件
    const outputPath = `${this.config.output}/${date}.md`;
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, markdown, 'utf-8');

    return {
      date,
      totalSessions: sessions.length,
      totalMessages,
      agents,
      devices,
      sessions: sessions.map(s => ({
        agent: s.agent,
        device: s.device,
        projectPath: s.projectPath,
        startedAt: s.startedAt,
        messageCount: s.messageCount,
        summary: s.summary,
      })),
      markdown,
    };
  }

  /** 转为 markdown 格式 */
  private toMarkdown(briefing: Briefing): string {
    const lines: string[] = [
      `# yondermesh 晨报 · ${briefing.date}`,
      '',
      `**${briefing.totalSessions} 个 session | ${briefing.totalMessages} 条消息 | ${briefing.agents.length} 个 agent | ${briefing.devices.length} 台设备**`,
      '',
      '| Agent | 设备 | 项目 | 时间 | 消息数 |',
      '|---|---|---|---|---|',
    ];

    for (const s of briefing.sessions) {
      const time = new Date(s.startedAt).toLocaleString('zh-CN');
      lines.push(`| ${s.agent} | ${s.device} | ${s.projectPath} | ${time} | ${s.messageCount} |`);
    }

    lines.push('', '---', '*由 yondermesh 自动生成*');

    return lines.join('\n');
  }
}
