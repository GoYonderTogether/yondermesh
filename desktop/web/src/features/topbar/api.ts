// fe-topbar：/api/state 数据层。
//
// 顶栏所需的项目/设备/模型/状态来自 /api/state。后端未就绪时前端可 mock。

import type { TopBarState } from './types'

const ENDPOINT = '/api/state'

export async function fetchTopBarState(signal?: AbortSignal): Promise<TopBarState> {
  const res = await fetch(ENDPOINT, { signal })
  if (!res.ok) throw new Error(`fetchTopBarState: ${res.status}`)
  return (await res.json()) as TopBarState
}
