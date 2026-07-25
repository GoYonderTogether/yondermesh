import { cn } from '@ymesh/ui'
import { Suspense } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { isTauriMacos } from '@/lib/env'
import { useIsDesktop } from '@/lib/use-media-query'
import { NavRail } from './NavRail'
import { TopBar } from '@/features/topbar'

/**
 * ymesh 桌面端壳：左 NavRail + 顶栏 + 主内容区。
 *
 * 四区布局（顶栏 / 看板 / 管家 / 工具栏）由各 feature 在主内容区内自行组织；
 * 本层负责侧栏 + 顶栏 + macOS 红绿灯让位 + 拖拽区。
 */
export function AppShell() {
  const isDesktop = useIsDesktop()
  const location = useLocation()
  const section = location.pathname.split('/')[1] || 'root'

  return (
    <div
      className={cn(
        'app-shell-root flex h-full w-full overflow-hidden bg-background text-foreground',
        isDesktop ? 'flex-row' : 'flex-col',
      )}
    >
      {isDesktop ? <NavRail /> : null}
      <main
        className={cn(
          'relative flex min-h-0 min-w-0 flex-1 flex-col bg-background',
          isTauriMacos && 'pt-7',
        )}
      >
        {isTauriMacos ? (
          <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-sticky h-7" />
        ) : null}
        <TopBar />
        <Suspense fallback={<div className="h-full" />}>
          <div key={section} className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
        </Suspense>
      </main>
    </div>
  )
}
