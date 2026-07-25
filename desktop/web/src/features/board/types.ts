// fe-board：任务看板类型。/api/tasks 返回结构。

export type TaskStatus = 'live' | 'idle' | 'stopped' | 'failed'

export interface TaskCardData {
  id: string
  title: string
  status: TaskStatus
  /** 执行该任务的 Agent（claude / codex / …） */
  agent: string
  /** 最后活动时间（ISO 字符串） */
  lastActivity: string
  /** 设备来源（本机 / 设备X） */
  device: string
  /** 悬停摘要（来自 briefing/extract 的总结） */
  summary: string
  /** 所属项目 */
  project: string
  /** 任务类别 */
  category: string
}

export interface TaskGroup {
  project: string
  categories: { category: string; tasks: TaskCardData[] }[]
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  live: '进行中',
  idle: '空闲',
  stopped: '已停止',
  failed: '失败',
}
