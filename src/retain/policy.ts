/**
 * Retention 策略配置（纯规则，零 LLM）
 *
 * 三层筛除：
 *   L0 噪音筛除：匹配已知噪音模板或极短高频内容 → 整条删
 *   L2 长内容截断：tool 消息超阈值 → 截断保留前缀
 *   L3 老旧归档：超过 TTL 的 session 的 messages → 删（保留 session 元数据）
 *
 * 策略可由 ~/.yondermesh/retain.yaml 覆盖（可选），无配置文件时用 DEFAULT_POLICY。
 */

/** 噪音匹配规则 */
export interface NoiseRule {
  /** 规则名（用于报告） */
  name: string;
  /** 精确匹配（content === match） */
  exact?: string;
  /** 正则匹配（content =~ pattern） */
  regex?: string;
  /** 前缀匹配（content.startsWith(prefix)） */
  prefix?: string;
}

/** 截断规则 */
export interface TruncateRule {
  /** 应用到哪个 role */
  role: 'tool' | 'assistant' | 'user' | 'system';
  /** 超过此字节数才截断 */
  maxBytes: number;
  /** 截断后保留的前缀字节数 */
  keepBytes: number;
}

/** 归档规则 */
export interface ArchiveRule {
  /** 超过 N 天未活动的 session 归档 */
  olderThanDays: number;
  /** 归档时是否保留 session 元数据（sessions 表行） */
  keepSessionMetadata: boolean;
}

/** Session 级分类策略（在消息级 L0/L2/L3 之上的 session 级筛除） */
export interface SessionClassifyRule {
  /** SL0 纯噪音 session：噪音消息占比超过此阈值（0-1）→ 整 session 删 */
  noiseRatio: number;
  /** SL0 触发最小消息数（< 此值的 session 不算噪音 session，避免误删短会话） */
  noiseMinMessages: number;
  /** SL1 短问答 session：消息数 < 此值 且 时长 < shortMaxDurationMs → 删 messages 保留 metadata */
  shortMaxMessages: number;
  /** SL1 短问答 session：时长上限（ms） */
  shortMaxDurationMs: number;
  /** SL2 重复 session：同 cwd + 同 source + 首条 user 消息相同 + 此时间窗内的 session 算重复（ms） */
  duplicateWindowMs: number;
}

/** 完整策略 */
export interface RetainPolicy {
  /** L0 噪音规则列表 */
  noise: NoiseRule[];
  /** L0 极短高频阈值：<此字节数 且 全库出现 > 此次数 视为噪音 */
  noiseShortBytes: number;
  noiseShortMinOccurrences: number;
  /** L2 截断规则 */
  truncate: TruncateRule[];
  /** L3 归档规则 */
  archive: ArchiveRule;
  /** Session 级分类策略（SL0/SL1/SL2） */
  sessionClassify: SessionClassifyRule;
  /** 备份目录（被删消息去重导出到此目录，jsonl.gz） */
  backupDir: string;
}

/**
 * 默认噪音模板（基于真实数据分析得出）。
 *
 * Top 5 高频噪音（占 97% 重复内容）：
 *   - "No response requested."        51922 次（agent 主动跳过占位符）
 *   - "[Request interrupted by user]" 51758 次（用户打断）
 *   - "继续"                          37457 次（用户让 agent 继续）
 *   - "API Error: 5xx ..."            30896 次（API 错误重试）
 *   - "那就跳过..."                    25749 次
 *
 * 这些是 agent 协议占位符 / 用户极短确认 / 错误重试，对"看见自己工作"
 * 和"跨工具检索"零价值，直接删除。
 */
export const DEFAULT_NOISE_RULES: NoiseRule[] = [
  // agent 协议占位符
  { name: 'no-response', exact: 'No response requested.' },
  { name: 'interrupted', exact: '[Request interrupted by user]' },
  { name: 'empty-assistant', exact: '' },

  // 用户极短确认（无信息量）
  { name: 'continue-zh', exact: '继续' },
  { name: 'ok', exact: 'ok' },
  { name: 'OK', exact: 'OK' },
  { name: 'okay', exact: 'okay' },
  { name: 'hi', exact: 'hi' },
  { name: 'Hi', exact: 'Hi' },
  { name: 'yes', exact: 'yes' },
  { name: 'no', exact: 'no' },
  { name: '好的', exact: '好的' },
  { name: '嗯', exact: '嗯' },
  { name: '嗯嗯', exact: '嗯嗯' },
  { name: '好的呢', exact: '好的呢' },
  { name: '收到', exact: '收到' },
  { name: '明白', exact: '明白' },
  { name: '了解', exact: '了解' },

  // API 错误（重试噪音，无检索价值）
  { name: 'api-error-5xx', regex: '^API Error: 5\\d{2}' },
  { name: 'api-error-4xx', regex: '^API Error: 4\\d{2}' },
  { name: 'api-error-network', prefix: 'API Error: 502' },
  { name: 'api-error-network-503', prefix: 'API Error: 503' },
  { name: 'api-error-network-504', prefix: 'API Error: 504' },

  // 用户"跳过"类指令（无检索价值）
  { name: 'skip-zh', prefix: '那就跳过' },
  { name: 'skip-zh-2', prefix: '跳过，未来' },

  // 工具调用失败的常见错误（无价值）
  { name: 'tool-not-found', exact: 'FILE_NOT_FOUND' },
  { name: 'tool-error-generic', regex: '^\\{"output":\\s*"[^"]*",\\s*"exit_code":\\s*[12]' },
];

/** 默认截断规则 */
export const DEFAULT_TRUNCATE_RULES: TruncateRule[] = [
  // tool 消息（工具输出，最冗余）：> 10KB 截断到 1KB
  { role: 'tool', maxBytes: 10_000, keepBytes: 1_000 },
  // assistant 消息（超长回复）：> 50KB 截断到 5KB
  { role: 'assistant', maxBytes: 50_000, keepBytes: 5_000 },
];

/** 默认 session 级分类策略 */
export const DEFAULT_SESSION_CLASSIFY: SessionClassifyRule = {
  // 噪音占比 > 80% 且消息数 >= 5 才算纯噪音 session（避免误删短问答）
  noiseRatio: 0.8,
  noiseMinMessages: 5,
  // < 10 条消息 且 < 5 分钟的算短问答
  shortMaxMessages: 10,
  shortMaxDurationMs: 5 * 60 * 1000,
  // 同 cwd + 同 source + 首条 user 消息相同 + 30 分钟内 → 重复
  duplicateWindowMs: 30 * 60 * 1000,
};

/** 默认策略 */
export const DEFAULT_POLICY: RetainPolicy = {
  noise: DEFAULT_NOISE_RULES,
  noiseShortBytes: 10,
  noiseShortMinOccurrences: 100,
  truncate: DEFAULT_TRUNCATE_RULES,
  archive: {
    olderThanDays: 90,
    keepSessionMetadata: true,
  },
  sessionClassify: DEFAULT_SESSION_CLASSIFY,
  backupDir: '', // 运行时填：~/.yondermesh/retention-backups/
};

/** 编译正则规则（避免每次匹配都重新编译） */
export interface CompiledNoiseRule {
  name: string;
  match: (content: string) => boolean;
}

export function compileNoiseRules(rules: NoiseRule[]): CompiledNoiseRule[] {
  return rules.map((r) => {
    let matchFn: (s: string) => boolean;
    if (r.exact !== undefined) {
      const e = r.exact;
      matchFn = (s) => s === e;
    } else if (r.regex !== undefined) {
      const re = new RegExp(r.regex);
      matchFn = (s) => re.test(s);
    } else if (r.prefix !== undefined) {
      const p = r.prefix;
      matchFn = (s) => s.startsWith(p);
    } else {
      matchFn = () => false;
    }
    return { name: r.name, match: matchFn };
  });
}
