// fe-tools-rail：可折叠分区（标题 + 展开/收起 + 内容）。
//
// 不引入 radix Collapsible（@ymesh/ui 暂无），用 state + CSS 自实现，零新增依赖。

import { cn } from '@ymesh/ui'
import { ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export interface CollapsibleSectionProps {
  title: string
  /** 默认展开 */
  defaultOpen?: boolean
  /** 右上角额外操作区 */
  actions?: ReactNode
  children: ReactNode
}

export function CollapsibleSection({
  title,
  defaultOpen = true,
  actions,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section
      data-testid="tool-section"
      data-open={open ? 'true' : 'false'}
      className="flex flex-col border-b border-border"
    >
      <header className="flex items-center justify-between px-3 py-2">
        <button
          type="button"
          data-testid="tool-section-toggle"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-sm font-medium text-foreground hover:opacity-80"
          aria-expanded={open}
        >
          <ChevronRight
            className={cn('size-4 transition-transform', open && 'rotate-90')}
          />
          {title}
        </button>
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </header>
      {open ? (
        <div data-testid="tool-section-body" className="min-h-0 flex-1 overflow-auto">
          {children}
        </div>
      ) : null}
    </section>
  )
}
