// fe-settings-paged：各子页（设备/同步/模型/外观/权限/关于）。
// 表单可填、状态可切；首版为本地态，接 /api/state 后再持久化。

import { Button, Card, Input, Label, Separator, Switch } from '@ymesh/ui'
import { useState } from 'react'

function SectionHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <header className="mb-4">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
    </header>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <Label className="mb-1.5">{label}</Label>
      {children}
    </div>
  )
}

function Toggle({ label, desc, defaultOn }: { label: string; desc: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(!!defaultOn)
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch data-testid="setting-toggle" checked={on} onCheckedChange={setOn} />
    </div>
  )
}

export function DevicesPage() {
  return (
    <div data-testid="settings-devices">
      <SectionHeader title="设备管理" desc="管理已连接的本机与远端设备" />
      <Card className="mb-4">
        <p className="text-sm text-muted-foreground">当前设备：本机（yondermesh 桌面端）</p>
        <Separator className="my-3" />
        <p className="text-xs text-text-tertiary">已连接设备首版仅占位；跨设备同步（src/sync/）落地后接入。</p>
      </Card>
      <Field label="设备名称">
        <Input defaultValue="yondermesh-mac" data-testid="device-name-input" />
      </Field>
      <Button>保存</Button>
    </div>
  )
}

export function SyncPage() {
  return (
    <div data-testid="settings-sync">
      <SectionHeader title="同步" desc="跨设备同步与中继配置" />
      <Card>
        <Toggle label="启用跨设备同步" desc="通过自托管 relay 同步 session（密文）" />
        <Separator className="my-2" />
        <Toggle label="自动同步新 session" desc="采集到新 session 后立即推送" defaultOn />
      </Card>
      <div className="mt-4">
        <Field label="中继地址">
          <Input placeholder="https://relay.example.com" data-testid="relay-url-input" />
        </Field>
        <Button>测试连接</Button>
      </div>
    </div>
  )
}

export function ModelPage() {
  return (
    <div data-testid="settings-model">
      <SectionHeader title="模型与 Key" desc="默认模型、API Key 与路由" />
      <Field label="默认模型">
        <Input defaultValue="claude-sonnet-4" data-testid="default-model-input" />
      </Field>
      <Field label="Anthropic API Key">
        <Input type="password" placeholder="sk-ant-..." data-testid="anthropic-key-input" />
      </Field>
      <Field label="OpenAI API Key">
        <Input type="password" placeholder="sk-..." data-testid="openai-key-input" />
      </Field>
      <Button>保存</Button>
    </div>
  )
}

export function AppearancePage() {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system')
  return (
    <div data-testid="settings-appearance">
      <SectionHeader title="外观" desc="主题、语言与显示偏好" />
      <Field label="主题">
        <select
          data-testid="theme-select"
          value={theme}
          onChange={(e) => setTheme(e.target.value as typeof theme)}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
        >
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
      </Field>
      <Field label="语言">
        <select className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm" defaultValue="zh-CN">
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </Field>
      <Toggle label="紧凑模式" desc="减小间距，单屏显示更多内容" />
    </div>
  )
}

export function PermissionsPage() {
  return (
    <div data-testid="settings-permissions">
      <SectionHeader title="权限" desc="Agent 能力边界与授权" />
      <Card>
        <Toggle label="允许 Agent 执行 shell 命令" desc="通过 trigger 引擎注入命令" defaultOn />
        <Separator className="my-2" />
        <Toggle label="允许修改文件" desc="Agent 可写入工作目录" defaultOn />
        <Separator className="my-2" />
        <Toggle label="IDE applescript 自动回复" desc="需单独授权辅助功能（可选）" />
      </Card>
    </div>
  )
}

export function AboutPage() {
  return (
    <div data-testid="settings-about">
      <SectionHeader title="关于" desc="版本、更新与开源信息" />
      <Card className="mb-4">
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted-foreground">应用</dt>
          <dd className="text-foreground">yondermesh 桌面端</dd>
          <dt className="text-muted-foreground">版本</dt>
          <dd className="text-foreground">0.1.0</dd>
          <dt className="text-muted-foreground">引擎</dt>
          <dd className="text-foreground">ymesh</dd>
          <dt className="text-muted-foreground">许可</dt>
          <dd className="text-foreground">MIT</dd>
        </dl>
      </Card>
      <Button variant="outline">检查更新</Button>
    </div>
  )
}
