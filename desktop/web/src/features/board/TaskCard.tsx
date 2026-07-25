// fe-board：单张任务卡片。状态色 + Agent + 最后活动 + 设备 + 悬停摘要。

import { Badge, Card, type BadgeProps } from '@ymesh/ui'
import { cn } from '@ymesh/ui'
import type { TaskCardData, TaskStatus } from './types'
import { STATUS_LABEL } from './types'

/** 状态 → Badge variant 映射。 */
export const STATUS_VARIANT: Record<TaskStatus, BadgeProps['variant']> = {
  live: 'success',
  idle: 'soft',
  stopped: 'outline',
  failed: 'destructive',
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  return `${day} 天前`
}

export interface TaskCardProps {
  task: TaskCardData
  onClick?: (task: TaskCardData) => void
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  return (
    <Card
      variant="default"
      data-testid="task-card"
      data-task-id={task.id}
      data-status={task.status}
      title={task.summary}
      className={cn(
        'cursor-pointer transition-shadow hover:shadow-[var(--shadow-soft-2)]',
        onClick && 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
      )}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick ? () => onClick(task) : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="line-clamp-1 text-sm font-medium text-foreground">{task.title}</h4>
        <Badge variant={STATUS_VARIANT[task.status]} data-testid="task-status">
          {STATUS_LABEL[task.status]}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-testid="task-agent">{task.agent}</span>
        <span data-testid="task-device">{task.device}</span>
        <span data-testid="task-last-activity">{formatRelative(task.lastActivity)}</span>
      </div>
      {task.summary ? (
        <p
          data-testid="task-summary"
          className="mt-2 line-clamp-2 text-xs text-text-secondary"
        >
          {task.summary}
        </p>
      ) : null}
    </Card>
  )
}
