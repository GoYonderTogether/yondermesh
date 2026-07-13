/**
 * 每日晨报生成器
 *
 * 汇总当日所有设备、所有 agent 的 session，
 * 生成一份可分享的摘要。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  private store: SessionStore;
  private config: { enabled: boolean; output: string };
  private timer?: ReturnType<typeof setInterval>;

  constructor(store: SessionStore, config: { enabled: boolean; output: string }) {
    this.store = store;
    this.config = config;
  }

  /** 启动定时生成（每天 0 点） */
  schedule(): void {
    // 简化：每小时检查一次是否到生成时间
    this.timer = setInterval(() => {
      this.generate().catch((err) => {
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
    // TODO(LOOP-005): 基于 SessionStore 多维切分与关系渲染完整晨报
    void this.store;
    const date = new Date().toISOString().slice(0, 10);
    const markdown = `# yondermesh 晨报 · ${date}\n\n（待 LOOP-005 接入 SessionStore 多维切分）\n`;

    const outputPath = `${this.config.output}/${date}.md`;
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, markdown, 'utf-8');

    return {
      date,
      totalSessions: 0,
      totalMessages: 0,
      agents: [],
      devices: [],
      sessions: [],
      markdown,
    };
  }
}
