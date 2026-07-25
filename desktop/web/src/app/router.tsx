import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './shell/AppShell'

const BoardPage = lazy(() => import('@/features/board/Board').then((m) => ({ default: m.Board })))
const StewardPage = lazy(() => import('@/features/steward/StewardChat').then((m) => ({ default: m.StewardChat })))
const LoopsPage = lazy(() => import('@/features/loops/LoopsDashboard').then((m) => ({ default: m.LoopsDashboard })))
const SettingsLayout = lazy(() => import('@/features/settings/SettingsLayout').then((m) => ({ default: m.SettingsLayout })))
const DevicesPage = lazy(() => import('@/features/settings/pages').then((m) => ({ default: m.DevicesPage })))
const SyncPage = lazy(() => import('@/features/settings/pages').then((m) => ({ default: m.SyncPage })))
const ModelPage = lazy(() => import('@/features/settings/pages').then((m) => ({ default: m.ModelPage })))
const AppearancePage = lazy(() => import('@/features/settings/pages').then((m) => ({ default: m.AppearancePage })))
const PermissionsPage = lazy(() => import('@/features/settings/pages').then((m) => ({ default: m.PermissionsPage })))
const AboutPage = lazy(() => import('@/features/settings/pages').then((m) => ({ default: m.AboutPage })))

/**
 * ymesh 桌面端路由。
 * 首页 = 任务看板；/steward = 管家对话；/loops = loop 看板；/settings/* = 页式设置（6 子页独立路由）。
 */
export function AppRouter() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<BoardPage />} />
        <Route path="steward" element={<StewardPage />} />
        <Route path="loops" element={<LoopsPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<DevicesPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="sync" element={<SyncPage />} />
          <Route path="model" element={<ModelPage />} />
          <Route path="appearance" element={<AppearancePage />} />
          <Route path="permissions" element={<PermissionsPage />} />
          <Route path="about" element={<AboutPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
