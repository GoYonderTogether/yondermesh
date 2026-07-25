/**
 * Retention 模块 barrel
 *
 * 提供数据库压缩/筛除/归档能力：
 *   - policy: 策略配置（噪音模板 + 截断 + 归档 + session 级分类阈值）
 *   - analyzer: 扫描报告（只读，含 session 级分类）
 *   - applier: 执行筛除（含 dry-run + 备份）
 *   - session-classifier: session 级分类器（SL0/SL1/SL2，纯 SQL）
 *   - ingest-filter: 入库时过滤（控制未来膨胀）
 *
 * CLI 入口：`ymesh retain analyze|apply|config`
 */

export {
  DEFAULT_POLICY,
  DEFAULT_NOISE_RULES,
  DEFAULT_TRUNCATE_RULES,
  DEFAULT_SESSION_CLASSIFY,
  compileNoiseRules,
} from './policy.js';
export type {
  NoiseRule,
  TruncateRule,
  ArchiveRule,
  SessionClassifyRule,
  RetainPolicy,
  CompiledNoiseRule,
} from './policy.js';

export { analyze } from './analyzer.js';
export type {
  NoiseReport,
  TruncateReport,
  ArchiveReport,
  RetainReport,
} from './analyzer.js';

export { apply } from './applier.js';
export type { ApplyResult } from './applier.js';

export { classifySessions } from './session-classifier.js';
export type {
  ClassifiedSession,
  SessionClassification,
} from './session-classifier.js';

export { IngestFilter, getDefaultIngestFilter } from './ingest-filter.js';
