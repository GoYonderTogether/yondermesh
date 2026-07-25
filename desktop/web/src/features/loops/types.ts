// fe-loops-dashboard：loop 类型（镜像 scripts/loop/loop-lib.mjs 的 parseLoop 输出）。

export type LoopStatus = 'draft' | 'approved' | 'running' | 'passed' | 'failed'

export interface Loop {
  id: string
  title: string
  status: LoopStatus
  feature: string
  verifier: string
  created: string
  last_run: string
  goal: string
  context: string
  action: string
  observation: string
  prompt: string
  path: string
}

export const STATUS_LABEL: Record<LoopStatus, string> = {
  draft: '草稿',
  approved: '已审核',
  running: '运行中',
  passed: '通过',
  failed: '失败',
}
