/** 是否运行在 Tauri 壳层内（桌面端）。 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 运行时平台标识：用 UA + Tauri 探测。 */
function detectPlatform(): 'web' | 'desktop' {
  if (!isTauri()) return 'web'
  return 'desktop'
}

export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api',
  platform: detectPlatform(),
}

/** 是否 macOS 桌面 Tauri（驱动红绿灯让位/拖拽条）。 */
export const isTauriMacos =
  env.platform === 'desktop' &&
  typeof navigator !== 'undefined' &&
  /Mac/i.test(navigator.userAgent)

/** 是否 Windows 桌面 Tauri（自定义标题栏预留区）。 */
export const isTauriWindows =
  env.platform === 'desktop' &&
  typeof navigator !== 'undefined' &&
  /Windows/i.test(navigator.userAgent)
