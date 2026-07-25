import { useEffect, useState } from 'react'

// 本地优先（US5）：离线态检测 hook。
// - 基于 navigator.onLine + window online/offline 事件
// - 返回当前在线态与「曾经离线」标记（用于重连后触发数据 refetch）
//
// 注：navigator.onLine 在某些场景（DNS 失败但网络栈仍在）会误报 online，
// 属已知限制；真实连通性以 WS/请求失败为准（ws-client 已自带重连）。
// 本 hook 只做粗粒度 UI 提示 + 重连后批量 refetch 触发。

export interface OnlineStatus {
  isOnline: boolean
  /** 本次会话内是否出现过离线（重连后用于触发 refetch）。 */
  wasOffline: boolean
}

export function useOnlineStatus(): OnlineStatus {
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  )
  const [wasOffline, setWasOffline] = useState<boolean>(false)

  useEffect(() => {
    const handleOnline = (): void => {
      setIsOnline(true)
    }
    const handleOffline = (): void => {
      setIsOnline(false)
      setWasOffline(true)
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return { isOnline, wasOffline }
}
