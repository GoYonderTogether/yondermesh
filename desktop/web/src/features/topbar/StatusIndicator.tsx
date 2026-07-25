// fe-topbar：运行状态指示器（Badge + 脉冲点）。

import { Badge, type BadgeProps } from '@ymesh/ui'
import { cn } from '@ymesh/ui'
import type { RunStatus } from './types'
import { RUN_STATUS_LABEL } from './types'

const STATUS_VARIANT: Record<RunStatus, BadgeProps['variant']> = {
  idle: 'soft',
  running: 'success',
  syncing: 'warning',
  error: 'destructive',
}

const STATUS_DOT: Record<RunStatus, string> = {
  idle: 'bg-muted-foreground',
  running: 'bg-success',
  syncing: 'bg-warning',
  error: 'bg-destructive',
}

export function StatusIndicator({ status }: { status: RunStatus }) {
  return (
    <Badge
      variant={STATUS_VARIANT[status]}
      data-testid="status-indicator"
      data-status={status}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          STATUS_DOT[status],
          status === 'running' && 'animate-pulse',
        )}
      />
      {RUN_STATUS_LABEL[status]}
    </Badge>
  )
}
