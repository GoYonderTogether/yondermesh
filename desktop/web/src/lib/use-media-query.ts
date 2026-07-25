import { useSyncExternalStore } from 'react'

/** 订阅媒体查询（JS 判断，避免 CSS/JS 不同步；规约见 design/01 §2.3） */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => true, // 服务端/首屏默认按桌面
  )
}

/** 桌面断点：>=768px */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)')
}
