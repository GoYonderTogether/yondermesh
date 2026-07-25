// fe-settings-paged：设置页壳（左侧子页导航 + 右侧 Outlet）。
// 把 yonder 的弹窗设置改成正经的页式设置（一页一页，每页独立路由）。

import { cn } from '@ymesh/ui'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { SETTING_SECTIONS } from './sections'

export function SettingsLayout() {
  const location = useLocation()
  const activeSlug = location.pathname.split('/settings/')[1]?.split('/')[0] ?? ''

  return (
    <div data-testid="settings-layout" className="flex h-full min-h-0">
      <aside className="w-60 shrink-0 overflow-auto border-r border-border bg-sidebar p-3">
        <h2 className="mb-3 px-2 text-sm font-semibold text-foreground">设置</h2>
        <nav className="flex flex-col gap-0.5">
          {SETTING_SECTIONS.map((s) => (
            <NavLink
              key={s.slug}
              to={`/settings/${s.slug}`}
              data-testid="settings-nav"
              data-slug={s.slug}
              className={({ isActive }) =>
                cn(
                  'rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive || (s.slug === 'devices' && !activeSlug)
                    ? 'bg-sidebar-selected text-foreground font-medium'
                    : 'text-text-secondary hover:bg-sidebar-hover',
                )
              }
            >
              {s.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  )
}
