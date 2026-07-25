// fe-loops-dashboard：loop 编辑器（四模块 + Prompt + verifier + 状态 + 保存/扫描/复制提示词）。

import { Badge, Button, Input, Label, Textarea } from '@ymesh/ui'
import { useEffect, useState } from 'react'
import { STATUS_LABEL, type Loop, type LoopStatus } from './types'
import { STATUS_VARIANT } from './status'

export interface LoopEditorProps {
  loop: Loop
  onSave: (input: {
    id: string
    title: string
    status: string
    feature: string
    verifier: string
    goal: string
    context: string
    action: string
    observation: string
    prompt: string
  }) => void
  onScan: (id: string) => void
  saving?: boolean
  scanning?: boolean
}

const STATUSES: LoopStatus[] = ['draft', 'approved', 'running', 'passed', 'failed']

export function LoopEditor({ loop, onSave, onScan, saving, scanning }: LoopEditorProps) {
  const [form, setForm] = useState({
    title: loop.title,
    status: loop.status,
    feature: loop.feature,
    verifier: loop.verifier,
    goal: loop.goal,
    context: loop.context,
    action: loop.action,
    observation: loop.observation,
    prompt: loop.prompt,
  })

  // 切换 loop 时重置表单
  useEffect(() => {
    setForm({
      title: loop.title,
      status: loop.status,
      feature: loop.feature,
      verifier: loop.verifier,
      goal: loop.goal,
      context: loop.context,
      action: loop.action,
      observation: loop.observation,
      prompt: loop.prompt,
    })
  }, [loop.id, loop.title, loop.status, loop.feature, loop.verifier, loop.goal, loop.context, loop.action, loop.observation, loop.prompt])

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const copyPrompt = async () => {
    const text = form.prompt.trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* ignore */
    }
  }

  return (
    <div data-testid="loop-editor" className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 data-testid="editor-title" className="text-base font-semibold text-foreground">
          {loop.title || loop.id}
        </h2>
        <Badge variant={STATUS_VARIANT[loop.status]}>{STATUS_LABEL[loop.status]}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="f-title">标题</Label>
          <Input id="f-title" value={form.title} onChange={(e) => set('title', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="f-status">状态</Label>
          <select
            id="f-status"
            data-testid="f-status"
            value={form.status}
            onChange={(e) => set('status', e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="f-feature">feature 关联</Label>
          <Input id="f-feature" value={form.feature} onChange={(e) => set('feature', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="f-verifier">verifier</Label>
          <Input id="f-verifier" data-testid="f-verifier" value={form.verifier} onChange={(e) => set('verifier', e.target.value)} />
        </div>
      </div>

      {(['goal', 'context', 'action', 'observation'] as const).map((k) => (
        <div key={k}>
          <Label htmlFor={`f-${k}`}>{k}</Label>
          <Textarea id={`f-${k}`} value={form[k]} onChange={(e) => set(k, e.target.value)} />
        </div>
      ))}

      <div>
        <div className="flex items-center justify-between">
          <Label htmlFor="f-prompt">Prompt</Label>
          <Button variant="outline" size="sm" data-testid="copy-prompt" onClick={copyPrompt}>复制提示词</Button>
        </div>
        <Textarea id="f-prompt" data-testid="f-prompt" value={form.prompt} onChange={(e) => set('prompt', e.target.value)} className="min-h-32" />
      </div>

      <div className="flex gap-2">
        <Button data-testid="save-loop" disabled={saving} onClick={() => onSave({ id: loop.id, ...form })}>
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button variant="outline" data-testid="scan-loop" disabled={scanning} onClick={() => onScan(loop.id)}>
          {scanning ? '扫描中…' : '扫描'}
        </Button>
      </div>
    </div>
  )
}
