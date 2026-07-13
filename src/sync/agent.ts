/**
 * 跨设备同步 agent
 *
 * 通过自托管 relay 进行 E2E 加密同步。
 * 代码离开设备前永远是密文。
 */

import type { SessionStore } from '../store/index.js';
import type { SyncConfig } from '../daemon/config.js';

/**
 * 同步 agent
 *
 * 职责：
 * 1. 定时将本地新 session 推送到 relay（E2E 加密）
 * 2. 从 relay 拉取其他设备的 session
 * 3. 解密后入库
 */
export class SyncAgent {
  private store: SessionStore;
  private config: SyncConfig;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(store: SessionStore, config: SyncConfig) {
    this.store = store;
    this.config = config;
  }

  /** 启动同步 */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (!this.config.relayUrl) {
      console.warn('[yondermesh] 同步已启用但未配置 relay_url，跳过');
      return;
    }

    // 首次立即同步
    await this.sync();

    // 定时同步（每 60 秒）
    this.timer = setInterval(() => {
      this.sync().catch((err) => {
        console.error('[yondermesh] 同步失败:', err);
      });
    }, 60_000);
  }

  /** 停止同步 */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 执行一次同步 */
  private async sync(): Promise<void> {
    // TODO: 实现 E2E 加密推送 + 拉取
    // 1. 查询本地未同步的 session
    // 2. 加密 session 内容
    // 3. POST 到 relay
    // 4. GET 其他设备的加密 session
    // 5. 解密并入库
    // 6. 更新 sync_state
    void this.store;
  }
}
