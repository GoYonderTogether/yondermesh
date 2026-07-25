import { type ComponentType, lazy } from 'react'

/**
 * 懒加载路由组件，并在 chunk 加载失败时自动整页刷新一次。
 * 场景：发版后构建产物 hash 变化，用户旧标签页里 import() 去拉已不存在的旧 chunk → 404 →
 * 整页打不开（表现为「页面消失/不存在」）。刷新会拿到 no-cache 的新 index.html + 新 chunk。
 * 用 sessionStorage 标记，避免真·加载错误时无限刷新。
 */
export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    const KEY = 'yonder:chunk-reloaded'
    try {
      const mod = await factory()
      window.sessionStorage.removeItem(KEY)
      return mod
    } catch (err) {
      if (!window.sessionStorage.getItem(KEY)) {
        window.sessionStorage.setItem(KEY, '1')
        window.location.reload()
        // 返回永不 resolve 的 promise，等刷新接管，避免闪现错误边界
        return new Promise<{ default: T }>(() => {})
      }
      throw err
    }
  })
}
