import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './shell/AppShell'

const BoardPage = lazy(() => import('@/features/board/Board').then((m) => ({ default: m.Board })))
const LoopsPage = lazy(() => import('@/features/loops/LoopsDashboard').then((m) => ({ default: m.LoopsDashboard })))

/**
 * ymesh 桌面端路由。首页 = 任务看板；/loops = loop 看板。其余 feature 落地后挂载。
 */
export function AppRouter() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<BoardPage />} />
        <Route path="loops" element={<LoopsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
