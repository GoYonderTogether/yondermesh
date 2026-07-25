import { cn } from '@ymesh/ui'
import { Boxes, LayoutDashboard, MessageCircle, Settings, Wrench } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { isTauriMacos } from '@/lib/env'
import { useResizableWidth } from '@/lib/use-resizable-width'

interface NavEntry {
  to: string
  icon: typeof LayoutDashboard
  label: string
}

// ymesh 四区 + loops 看板 + 设置。各 feature loop 落地后页面真实存在。
const PRIMARY: NavEntry[] = [
  { to: '/', icon: LayoutDashboard, label: '看板' },
  { to: '/steward', icon: MessageCircle, label: '管家' },
  { to: '/tools', icon: Wrench, label: '工具栏' },
  { to: '/loops', icon: Boxes, label: 'Loops' },
  { to: '/settings', icon: Settings, label: '设置' },
]

const EXPAND_THRESHOLD = 140
const RAIL_MIN = 72
const RAIL_MAX = 220
const RAIL_KEY = 'ymesh:nav:railWidth'

function RailLink({ entry, expanded }: { entry: NavEntry; expanded: boolean }) {
  const Icon = entry.icon
  return (
    <NavLink
      to={entry.to}
      title={entry.label}
      aria-label={entry.label}
      end={entry.to === '/'}
      className={({ isActive }) =>
        cn(
          'relative flex items-center rounded-lg text-sidebar-foreground transition-colors hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          expanded ? 'h-10 w-full gap-3 px-3' : 'size-10 justify-center',
          isActive && 'bg-sidebar-selected',
        )
      }
    >
      <Icon className="size-5 shrink-0" />
      {expanded ? <span className="truncate text-sm">{entry.label}</span> : null}
    </NavLink>
  )
}

/**
 * 左侧导航栏（fork 自 yonder NavRail，剥离 auth/messages/update 业务）。
 * 可拖拽调宽，跨过 EXPAND_THRESHOLD 展开文字标签。
 */
export function NavRail() {
  const { width, isDragging, dividerProps } = useResizableWidth({
    storageKey: RAIL_KEY,
    min: RAIL_MIN,
    max: RAIL_MAX,
    defaultWidth: RAIL_MIN,
  })
  const expanded = width >= EXPAND_THRESHOLD

  return (
    <nav
      data-testid="nav-rail"
      style={{ width }}
      className={cn(
        'relative flex shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar py-3',
        expanded ? 'items-stretch px-2' : 'items-center',
        !isDragging && 'transition-[width] duration-200 ease-out',
      )}
    >
      {isTauriMacos ? <div data-tauri-drag-region className="h-4 w-full shrink-0" /> : null}

      <NavLink
        to="/"
        title="yondermesh"
        aria-label="yondermesh"
        className={cn(
          'mb-2 flex items-center rounded-lg py-1 transition-colors hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          expanded ? 'gap-2 px-1' : 'justify-center',
        )}
      >
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground text-xs font-bold">
          y
        </span>
        {expanded ? <span className="truncate text-sm font-semibold">yondermesh</span> : null}
      </NavLink>

      {PRIMARY.map((e) => (
        <RailLink key={e.to} entry={e} expanded={expanded} />
      ))}

      <div className="flex-1" />

      <div
        {...dividerProps}
        className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-border-strong"
      />
    </nav>
  )
}
