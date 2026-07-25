// fe-board：任务看板（核心颠覆页）。
//
// 连 /api/tasks，按项目/任务类别分组展示进行中任务卡片。
// 状态色（live/idle/stopped/failed）+ Agent + 最后活动 + 设备来源 + 悬停摘要。
// 空态：无任务时提示。加载/错误态由 hook 驱动。

import { ScrollArea } from '@ymesh/ui'
import { Loader2 } from 'lucide-react'
import { useTasks } from './use-tasks'
import { groupTasks } from './group'
import { TaskCard } from './TaskCard'
import type { TaskCardData } from './types'

export function Board({ onTaskClick }: { onTaskClick?: (task: TaskCardData) => void } = {}) {
  const { data: tasks, isLoading, error } = useTasks()

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span className="ml-2 text-sm">加载任务…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <div>
          <p className="text-sm text-destructive">加载失败</p>
          <p className="mt-1 text-xs text-muted-foreground">{String(error.message)}</p>
        </div>
      </div>
    )
  }

  const groups = groupTasks(tasks ?? [])

  if (groups.length === 0) {
    return (
      <div data-testid="board-empty" className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <p className="text-sm text-muted-foreground">暂无进行中的任务</p>
          <p className="mt-1 text-xs text-text-tertiary">管家派发任务后将在此展示</p>
        </div>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div data-testid="board" className="flex flex-col gap-6 p-4">
        {groups.map((g) => (
          <section key={g.project} data-testid="task-group" data-project={g.project}>
            <h3 className="mb-2 text-sm font-semibold text-foreground">{g.project}</h3>
            <div className="flex flex-col gap-3">
              {g.categories.map((c) => (
                <div key={c.category} data-testid="task-category" data-category={c.category}>
                  <p className="mb-1.5 text-xs font-medium text-text-secondary">{c.category}</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {c.tasks.map((t) => (
                      <TaskCard key={t.id} task={t} onClick={onTaskClick} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </ScrollArea>
  )
}
