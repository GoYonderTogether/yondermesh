/**
 * 蒸馏窄版（distill）模块入口
 */

export {
  distilledBaseDir,
  distillProject,
  listDistilled,
  getDistilled,
} from './distiller.js';

export type {
  DistillOptions,
  DistillStats,
  DistilledProject,
  PreferenceEntry,
  TagEntry,
  ThemeEntry,
} from './distiller.js';
