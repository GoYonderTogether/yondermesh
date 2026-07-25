/**
 * Retention 模块 barrel
 *
 * 提供数据库压缩/筛除/归档能力：
 *   - policy: 策略配置（噪音模板 + 截断 + 归档阈值）
 *   - analyzer: 扫描报告（只读）
 *   - applier: 执行筛除（含 dry-run + 备份）
 *   - ingest-filter: 入库时过滤（控制未来膨胀）
 *
 * CLI 入口：`ymesh retain analyze|apply|config`
 */

export {
  DEFAULT_POLICY,
  DEFAULT_NOISE_RULES,
  DEFAULT_TRUNCATE_RULES,
  compileNoiseRules,
} from './policy.js';
export type {
  NoiseRule,
  TruncateRule,
  ArchiveRule,
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

export { IngestFilter, getDefaultIngestFilter } from './ingest-filter.js';
