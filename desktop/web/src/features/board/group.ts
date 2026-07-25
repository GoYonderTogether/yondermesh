// fe-board：把扁平任务列表按项目 → 类别分组的纯函数（供组件 + 测试复用）。

import type { TaskCardData, TaskGroup } from './types'

export function groupTasks(tasks: TaskCardData[]): TaskGroup[] {
  const byProject = new Map<string, Map<string, TaskCardData[]>>()
  for (const t of tasks) {
    if (!byProject.has(t.project)) byProject.set(t.project, new Map())
    const cats = byProject.get(t.project)!
    if (!cats.has(t.category)) cats.set(t.category, [])
    cats.get(t.category)!.push(t)
  }
  const groups: TaskGroup[] = []
  for (const [project, cats] of byProject) {
    groups.push({
      project,
      categories: [...cats.entries()].map(([category, tasks]) => ({ category, tasks })),
    })
  }
  return groups
}
