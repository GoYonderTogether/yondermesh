import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

// 可拖拽分栏宽度（自研，无第三方库；参考 zeth-ai 的 PointerEvent + localStorage 实现）。
// 用法：const { width, dividerProps, containerRef } = useResizableWidth({ storageKey, min, max, default })
//   把 containerRef 挂到三栏容器、width 设给左列、dividerProps 摊给分隔手柄。

export interface ResizableWidthOptions {
  storageKey: string // localStorage 持久化键
  min: number
  max: number
  defaultWidth: number
  // 右侧面板最小宽度：拖动时左列最大 = 容器宽 - rightMin - 手柄宽。
  rightMin?: number
}

export interface ResizableWidthResult {
  width: number
  setWidth: (w: number) => void
  isDragging: boolean
  containerRef: React.RefObject<HTMLDivElement | null>
  dividerProps: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
    onDoubleClick: () => void
    role: 'separator'
    'aria-orientation': 'vertical'
    tabIndex: 0
  }
}

export function useResizableWidth(opts: ResizableWidthOptions): ResizableWidthResult {
  const { storageKey, min, max, defaultWidth, rightMin = 320 } = opts

  const clamp = useCallback((n: number) => Math.min(max, Math.max(min, n)), [min, max])

  const load = useCallback((): number => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return defaultWidth
      const n = Number(raw)
      return Number.isFinite(n) ? clamp(n) : defaultWidth
    } catch {
      return defaultWidth
    }
  }, [storageKey, defaultWidth, clamp])

  const [width, setWidthState] = useState<number>(load)
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWRef = useRef(0)

  const persist = useCallback(
    (w: number) => {
      try {
        localStorage.setItem(storageKey, String(w))
      } catch {
        /* 忽略持久化失败 */
      }
    },
    [storageKey],
  )

  const setWidth = useCallback(
    (w: number) => {
      const c = clamp(w)
      setWidthState(c)
      persist(c)
    },
    [clamp, persist],
  )

  const maxFromContainer = useCallback((): number => {
    const cw = containerRef.current?.clientWidth ?? 0
    return cw > 0 ? Math.max(min, cw - rightMin - 1) : max
  }, [min, max, rightMin])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      draggingRef.current = true
      setIsDragging(true)
      startXRef.current = e.clientX
      startWRef.current = width
      // 拖拽时全局禁选中文本 + 列调整光标。
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'

      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return
        const delta = ev.clientX - startXRef.current
        const upper = Math.min(max, maxFromContainer())
        const next = Math.min(upper, Math.max(min, startWRef.current + delta))
        setWidthState(next)
      }
      const onUp = () => {
        draggingRef.current = false
        setIsDragging(false)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        setWidthState((w) => {
          persist(w)
          return w
        })
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [width, min, max, maxFromContainer, persist],
  )

  // 双击分隔线复位默认宽度。
  const onDoubleClick = useCallback(() => setWidth(defaultWidth), [setWidth, defaultWidth])

  // 容器尺寸变化时夹取宽度，避免溢出。
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const upper = Math.min(max, maxFromContainer())
      setWidthState((cur) => Math.min(cur, upper))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [max, maxFromContainer])

  return {
    width,
    setWidth,
    isDragging,
    containerRef,
    dividerProps: {
      onPointerDown,
      onDoubleClick,
      role: 'separator',
      'aria-orientation': 'vertical',
      tabIndex: 0,
    },
  }
}
