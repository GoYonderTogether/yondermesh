// fe-topbar：项目/设备/模型切换器（DropdownMenu 实现）。

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ymesh/ui'
import { Check, ChevronDown, Cpu, Folder, Laptop } from 'lucide-react'
import type { Device, ModelOption, Project } from './types'

interface SwitcherProps<T> {
  label: string
  icon: typeof Folder
  current: T | null
  options: T[]
  onSelect: (item: T) => void
  getKey: (item: T) => string
  getLabel: (item: T) => string
  getSublabel?: (item: T) => string
  testId: string
}

function Switcher<T>({
  label,
  icon: Icon,
  current,
  options,
  onSelect,
  getKey,
  getLabel,
  getSublabel,
  testId,
}: SwitcherProps<T>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid={testId}
          className="gap-1.5"
          aria-label={label}
        >
          <Icon className="size-3.5 text-text-secondary" />
          <span className="max-w-32 truncate text-sm">
            {current ? getLabel(current) : `选择${label}`}
          </span>
          <ChevronDown className="size-3 text-text-tertiary" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.length === 0 ? (
          <div className="px-2.5 py-1.5 text-xs text-muted-foreground">无可用项</div>
        ) : (
          options.map((item) => {
            const key = getKey(item)
            const isCurrent = current && getKey(current) === key
            return (
              <DropdownMenuItem
                key={key}
                data-testid={`${testId}-item`}
                data-value={key}
                onClick={() => onSelect(item)}
                className="flex items-center justify-between gap-3"
              >
                <div className="flex flex-col">
                  <span className="text-sm">{getLabel(item)}</span>
                  {getSublabel ? (
                    <span className="text-[10px] text-text-tertiary">
                      {getSublabel(item)}
                    </span>
                  ) : null}
                </div>
                {isCurrent ? <Check className="size-3.5 text-success" /> : null}
              </DropdownMenuItem>
            )
          })
        )}
        {options.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem className="text-xs text-text-tertiary">
          管理{label}…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ProjectSwitcher({
  current,
  projects,
  onSelect,
}: {
  current: Project | null
  projects: Project[]
  onSelect: (p: Project) => void
}) {
  return (
    <Switcher<Project>
      label="项目"
      icon={Folder}
      current={current}
      options={projects}
      onSelect={onSelect}
      getKey={(p) => p.id}
      getLabel={(p) => p.name}
      getSublabel={(p) => p.cwd}
      testId="project-switcher"
    />
  )
}

export function DeviceSwitcher({
  current,
  devices,
  onSelect,
}: {
  current: Device | null
  devices: Device[]
  onSelect: (d: Device) => void
}) {
  return (
    <Switcher<Device>
      label="设备"
      icon={Laptop}
      current={current}
      options={devices}
      onSelect={onSelect}
      getKey={(d) => d.id}
      getLabel={(d) => d.name}
      getSublabel={(d) => `${d.kind === 'local' ? '本机' : '远端'} · ${d.online ? '在线' : '离线'}`}
      testId="device-switcher"
    />
  )
}

export function ModelSwitcher({
  current,
  models,
  onSelect,
}: {
  current: ModelOption | null
  models: ModelOption[]
  onSelect: (m: ModelOption) => void
}) {
  return (
    <Switcher<ModelOption>
      label="模型"
      icon={Cpu}
      current={current}
      options={models}
      onSelect={onSelect}
      getKey={(m) => m.id}
      getLabel={(m) => m.name}
      getSublabel={(m) => m.provider}
      testId="model-switcher"
    />
  )
}
