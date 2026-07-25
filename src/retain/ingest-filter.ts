/**
 * Ingest Filter —— 入库时过滤钩子。
 *
 * 目标：控制未来数据膨胀 < 20%。
 *
 * 工作原理：
 *   在 SessionStore.ingestSession 入库前，对每条 message 跑噪音规则：
 *   - 命中噪音规则 → 标记为 filtered，不入库（或入库但 content 替换为占位符）
 *   - 超长内容 → 入库时直接截断
 *
 * 当前实现：纯函数，由 SessionStore 调用。
 * 未来可加配置开关（默认开启 L0，L2 截断可选）。
 *
 * 不做的事：
 *   - 不去重（去重是 schema 改造，影响大，留作 L1 后续工作）
 *   - 不归档（归档是周期性任务，由 ymesh retain apply 触发）
 */

import type { SessionMessageInput } from '../store/types.js';
import {
  compileNoiseRules,
  DEFAULT_POLICY,
  DEFAULT_TRUNCATE_RULES,
} from './policy.js';
import type {
  CompiledNoiseRule,
  RetainPolicy,
} from './policy.js';

/** 编译后的过滤器（复用 compiled rules，避免每次重新编译） */
export class IngestFilter {
  private readonly noiseRules: CompiledNoiseRule[];
  private readonly policy: RetainPolicy;

  constructor(policy: RetainPolicy = DEFAULT_POLICY) {
    this.policy = policy;
    this.noiseRules = compileNoiseRules(policy.noise);
  }

  /**
   * 判断单条消息是否为噪音（应被过滤）。
   * 命中任何规则即视为噪音。
   */
  isNoise(content: string): boolean {
    if (content.length < this.policy.noiseShortBytes) {
      // 极短内容：检查是否高频噪音（入库时无法知道全局频次，
      // 但已知噪音模板已覆盖，未匹配的极短内容保留——用户可能真的输入"ok"）
      // 这里只跑显式规则
    }
    for (const rule of this.noiseRules) {
      if (rule.match(content)) return true;
    }
    return false;
  }

  /**
   * 过滤 + 截断一批消息。
   *
   * 返回：
   *   - filtered: 被过滤掉的消息（调用方可记日志）
   *   - kept: 保留的消息（可能被截断）
   *   - truncatedCount: 被截断的消息数
   *
   * 注意：被过滤的消息不保留 seq 顺序——调用方需要按 kept 数组的顺序入库，
   * 并重新计算 seq（seq 是连续的，不能有空洞）。
   */
  filterMessages(messages: SessionMessageInput[]): {
    filtered: SessionMessageInput[];
    kept: SessionMessageInput[];
    truncatedCount: number;
  } {
    const filtered: SessionMessageInput[] = [];
    const kept: SessionMessageInput[] = [];
    let truncatedCount = 0;

    for (const msg of messages) {
      // L0：噪音过滤
      if (this.isNoise(msg.content)) {
        filtered.push(msg);
        continue;
      }
      // L2：长内容截断
      const truncated = this.truncateIfLong(msg);
      if (truncated !== msg.content) {
        truncatedCount++;
      }
      kept.push({ ...msg, content: truncated });
    }

    return { filtered, kept, truncatedCount };
  }

  /** 对单条消息跑截断规则，返回截断后的 content（未超长则原样返回） */
  private truncateIfLong(msg: SessionMessageInput): string {
    for (const rule of DEFAULT_TRUNCATE_RULES) {
      if (rule.role !== msg.role) continue;
      if (msg.content.length <= rule.maxBytes) continue;
      const marker = `\n\n[... truncated by ymesh ingest-filter, original ${msg.content.length} chars ...]`;
      return msg.content.slice(0, rule.keepBytes) + marker;
    }
    return msg.content;
  }
}

/**
 * 单例过滤器（默认策略）。
 * SessionStore 在 ingestSession 时调用此单例。
 */
let defaultFilter: IngestFilter | null = null;

export function getDefaultIngestFilter(): IngestFilter {
  if (!defaultFilter) {
    defaultFilter = new IngestFilter();
  }
  return defaultFilter;
}
