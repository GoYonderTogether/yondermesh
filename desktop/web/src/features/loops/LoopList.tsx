// fe-loops-dashboard：loop 列表卡片。

import { Badge, cn } from '@ymesh/ui'
import type { Loop } from './types'
import { STATUS_LABEL } from './types'
import { STATUS_VARIANT } from './status'

export interface LoopListProps {
  loops: Loop[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function LoopList({ loops, selectedId, onSelect }: LoopListProps) {
  if (loops.length === 0) {
    return <div data-testid="loops-empty" className="p-4 text-sm text-muted-foreground">暂无 loop</div>
  }
  return (
    <ul data-testid="loop-list" className="flex flex-col gap-1.5 p-2">
      {loops.map((l) => (
        <li key={l.id}>
          <button
            type="button"
            data-testid="loop-item"
            data-loop-id={l.id}
            data-status={l.status}
            onClick={() => onSelect(l.id)}
            className={cn(
              'w-full rounded-lg border p-2.5 text-left transition-colors',
              l.id === selectedId
                ? 'border-primary bg-primary/5'
                : 'border-border bg-card hover:bg-sidebar-hover',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="line-clamp-1 text-sm font-medium text-foreground">{l.title || l.id}</span>
              <Badge variant={STATUS_VARIANT[l.status]} data-testid="loop-status">{STATUS_LABEL[l.status]}</Badge>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span data-testid="loop-id">{l.id}</span>
              {l.feature ? <span className="rounded bg-secondary px-1 py-0.5 text-text-tertiary">{l.feature}</span> : null}
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}
