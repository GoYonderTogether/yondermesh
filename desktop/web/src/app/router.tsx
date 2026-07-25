import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './shell/AppShell'

const BoardPage = lazy(() => import('@/features/board/Board').then((m) => ({ default: m.Board })))

/**
 * ymesh 桌面端路由。
 *
 * 首页 = 任务看板（核心颠覆页）。其余 feature 落地后在此挂载。
 */
export function AppRouter() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<BoardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
