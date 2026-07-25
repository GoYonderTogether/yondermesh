// fe-loops-dashboard：loop 看板主组件（迁移自 scripts/loop/dashboard.html）。
//
// 三栏：loop 列表（左）+ 编辑器（中）+ 说明（右）。
// 实时状态 + 新建/编辑/复制提示词/扫描，全部在 app 内。后端复用 scripts/loop/server.mjs API。

import { Button, ScrollArea } from '@ymesh/ui'
import { useState } from 'react'
import { LoopEditor } from './LoopEditor'
import { LoopList } from './LoopList'
import { useLoop, useLoops, useSaveLoop, useScanLoop } from './use-loops'

export function LoopsDashboard() {
  const { data: loops, isLoading } = useLoops()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const currentId = selectedId ?? loops?.[0]?.id ?? null
  const { data: current } = useLoop(currentId)
  const saveMut = useSaveLoop()
  const scanMut = useScanLoop()

  return (
    <div data-testid="loops-dashboard" className="flex h-full min-h-0">
      <aside className="w-72 shrink-0 overflow-hidden border-r border-border bg-sidebar">
        <div className="flex items-center justify-between p-3">
          <h2 className="text-sm font-semibold text-foreground">Loops</h2>
          <Button size="sm" data-testid="new-loop" onClick={() => setSelectedId(null)}>+ 新建</Button>
        </div>
        <ScrollArea className="h-[calc(100%-3rem)]">
          {isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">加载中…</div>
          ) : (
            <LoopList loops={loops ?? []} selectedId={currentId} onSelect={setSelectedId} />
          )}
        </ScrollArea>
      </aside>
      <main className="flex-1 overflow-auto">
        {current ? (
          <LoopEditor
            loop={current}
            saving={saveMut.isPending}
            scanning={scanMut.isPending}
            onSave={(input) => saveMut.mutate(input)}
            onScan={(id) => scanMut.mutate(id)}
          />
        ) : (
          <div data-testid="loops-editor-empty" className="flex h-full items-center justify-center text-sm text-muted-foreground">
            ← 选一个 loop，或点「新建」
          </div>
        )}
      </main>
    </div>
  )
}
