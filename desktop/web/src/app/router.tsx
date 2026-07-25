import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './shell/AppShell'

const HelloPage = lazy(() => import('@/pages/HelloPage').then((m) => ({ default: m.HelloPage })))

/**
 * ymesh 桌面端路由。
 *
 * fork 后首版只有一个 hello 页（验证壳可跑）。
 * 各 feature loop（fe-board / fe-steward-chat / fe-tools-rail / fe-topbar / fe-settings-paged /
 * fe-loops-dashboard）落地后，在此挂载对应路由。
 */
export function AppRouter() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HelloPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
