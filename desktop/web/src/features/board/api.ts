// fe-board：/api/tasks 数据层。
//
// 依赖 build-task-aggregation / src/web/ 提供后端；后端未就绪时前端可 mock。
// 本模块只负责 fetch + 类型化，不做聚合（聚合由后端 /api/tasks 做）。

import type { TaskCardData } from './types'

const TASKS_ENDPOINT = '/api/tasks'

/** 拉取任务卡片列表（已按项目/类别聚合由后端完成；前端再分组渲染）。 */
export async function fetchTasks(signal?: AbortSignal): Promise<TaskCardData[]> {
  const res = await fetch(TASKS_ENDPOINT, { signal })
  if (!res.ok) throw new Error(`fetchTasks: ${res.status}`)
  const data = (await res.json()) as { tasks?: TaskCardData[] } | TaskCardData[]
  return Array.isArray(data) ? data : (data.tasks ?? [])
}
