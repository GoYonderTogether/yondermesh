// fe-topbar：顶栏（项目/设备/模型切换 + 运行状态指示）。
//
// 类 Codex 顶栏：左侧项目 + 设备 + 模型切换，右侧运行状态指示。
// 数据来自 /api/state；切换交互为本地态（首版不持久化，接 /api/state PUT 后再持久化）。

import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { isTauriMacos } from '@/lib/env'
import { useTopBarState } from './use-topbar'
import { ProjectSwitcher, DeviceSwitcher, ModelSwitcher } from './Switchers'
import { StatusIndicator } from './StatusIndicator'
import type { Device, ModelOption, Project } from './types'

export function TopBar() {
  const { data, isLoading, error } = useTopBarState()
  // 首版本地态：切换后立即反映，不持久化（后端 PUT 后再接）
  const [project, setProject] = useState<Project | null>(null)
  const [device, setDevice] = useState<Device | null>(null)
  const [model, setModel] = useState<ModelOption | null>(null)

  if (isLoading) {
    return (
      <div
        data-testid="topbar"
        className="flex h-10 items-center justify-center border-b border-border bg-background"
      >
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div
        data-testid="topbar"
        className="flex h-10 items-center border-b border-border bg-background px-3"
      >
        <span className="text-xs text-destructive">状态加载失败</span>
      </div>
    )
  }

  const curProject = project ?? data?.currentProject ?? null
  const curDevice = device ?? data?.currentDevice ?? null
  const curModel = model ?? data?.currentModel ?? null
  const runStatus = data?.runStatus ?? 'idle'

  return (
    <div
      data-testid="topbar"
      className="flex h-10 items-center justify-between gap-2 border-b border-border bg-background px-2"
    >
      {/* macOS 红绿灯让位 */}
      {isTauriMacos ? <div className="w-16 shrink-0" /> : null}
      <div className="flex items-center gap-1">
        <ProjectSwitcher
          current={curProject}
          projects={data?.projects ?? []}
          onSelect={setProject}
        />
        <DeviceSwitcher
          current={curDevice}
          devices={data?.devices ?? []}
          onSelect={setDevice}
        />
        <ModelSwitcher
          current={curModel}
          models={data?.models ?? []}
          onSelect={setModel}
        />
      </div>
      <div className="flex items-center gap-2">
        <StatusIndicator status={runStatus} />
      </div>
    </div>
  )
}
