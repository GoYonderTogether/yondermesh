// fe-loops-dashboard：loop 状态 → Badge variant 映射。

import type { BadgeProps } from '@ymesh/ui'
import type { LoopStatus } from './types'

export const STATUS_VARIANT: Record<LoopStatus, BadgeProps['variant']> = {
  draft: 'soft',
  approved: 'outline',
  running: 'warning',
  passed: 'success',
  failed: 'destructive',
}
