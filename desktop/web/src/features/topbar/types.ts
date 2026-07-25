// fe-topbar：顶栏类型。

export interface Project {
  id: string
  name: string
  /** 工作目录路径 */
  cwd: string
}

export interface Device {
  id: string
  name: string
  /** 本机 / 远端设备名 */
  kind: 'local' | 'remote'
  /** 是否在线 */
  online: boolean
}

export interface ModelOption {
  id: string
  name: string
  /** 提供方 */
  provider: string
}

export type RunStatus = 'idle' | 'running' | 'syncing' | 'error'

export interface TopBarState {
  currentProject: Project | null
  projects: Project[]
  currentDevice: Device | null
  devices: Device[]
  currentModel: ModelOption | null
  models: ModelOption[]
  runStatus: RunStatus
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  idle: '空闲',
  running: '运行中',
  syncing: '同步中',
  error: '错误',
}
