/**
 * Briefing 调度器 —— 把 BriefingGenerator 接入 daemon 生命周期
 *
 * daemon 启动时调用 start()：立即生成一次（让晨报尽快可见）+ 每小时定时刷新；
 * daemon 停止时调用 stop() 清理 timer。失败只写 stderr，不影响 daemon 主流程。
 */

import { join } from 'node:path';
import { BriefingGenerator } from '../briefing/generator.js';
import type { SessionStore } from '../store/index.js';

export class BriefingScheduler {
  private readonly generator: BriefingGenerator;
  private timer?: ReturnType<typeof setInterval>;
  private readonly intervalMs: number;

  constructor(store: SessionStore, dataDir: string, intervalMs: number = 3_600_000) {
    this.generator = new BriefingGenerator(store, {
      enabled: true,
      output: join(dataDir, 'briefings'),
    });
    this.intervalMs = intervalMs;
  }

  /** 启动调度：立即生成一次 + 定时刷新 */
  start(): void {
    if (this.timer) return;
    this.generateSafe();
    this.timer = setInterval(() => this.generateSafe(), this.intervalMs);
  }

  /** 停止调度 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private generateSafe(): void {
    this.generator
      .generate()
      .catch((err) => {
        process.stderr.write(`[yondermesh] briefing 生成失败: ${String(err)}\n`);
      });
  }
}
