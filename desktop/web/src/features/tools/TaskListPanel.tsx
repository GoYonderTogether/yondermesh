// fe-tools-rail：任务清单面板（看板的另一种视图——扁平列表）。
//
// 复用 fe-board 的 useTasks（同一份 /api/tasks 数据），渲染为紧凑列表。
// 与看板互补：看板按项目/类别分组，这里按最后活动时间排序，方便快速扫一眼进行中的任务。

import { Loader2 } from 'lucide-react'
import { useTasks } from '@/features/board'
import { STATUS_LABEL, type TaskStatus } from '@/features/board'

const STATUS_DOT: Record<TaskStatus, string> = {
  live: 'bg-success',
  idle: 'bg-muted-foreground',
  stopped: 'bg-text-tertiary',
  failed: 'bg-destructive',
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.floor(hr / 24)}d`
}

export function TaskListPanel() {
  const { data: tasks, isLoading, error } = useTasks()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-4 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span className="ml-2 text-xs">加载任务…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div data-testid="tasks-error" className="p-3 text-xs text-destructive">
        加载失败：{String(error.message)}
      </div>
    )
  }

  if (!tasks || tasks.length === 0) {
    return (
      <div data-testid="tasks-empty" className="p-3 text-xs text-muted-foreground">
        暂无任务
      </div>
    )
  }

  const sorted = [...tasks].sort(
    (a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity),
  )

  return (
    <ul data-testid="task-list" className="flex flex-col">
      {sorted.map((t) => (
        <li
          key={t.id}
          data-testid="task-list-item"
          data-status={t.status}
          className="flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/40"
          title={t.summary}
        >
          <span
            data-testid="task-status-dot"
            className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status]}`}
          />
          <span className="flex-1 truncate text-xs text-foreground">{t.title}</span>
          <span className="shrink-0 text-[10px] text-text-tertiary">
            {formatRelative(t.lastActivity)}
          </span>
        </li>
      ))}
    </ul>
  )
}

export { STATUS_LABEL }
