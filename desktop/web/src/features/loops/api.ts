// fe-loops-dashboard：loop 看板 API 层（对接 scripts/loop/server.mjs）。

import type { Loop } from './types'

const BASE = '/api'

export async function fetchLoops(signal?: AbortSignal): Promise<Loop[]> {
  const res = await fetch(`${BASE}/loops`, { signal })
  if (!res.ok) throw new Error(`fetchLoops: ${res.status}`)
  return (await res.json()) as Loop[]
}

export async function fetchLoop(id: string, signal?: AbortSignal): Promise<Loop> {
  const res = await fetch(`${BASE}/loop?id=${encodeURIComponent(id)}`, { signal })
  if (!res.ok) throw new Error(`fetchLoop: ${res.status}`)
  return (await res.json()) as Loop
}

export interface SaveLoopInput {
  id?: string
  title?: string
  status?: string
  feature?: string
  verifier?: string
  goal?: string
  context?: string
  action?: string
  observation?: string
  prompt?: string
}

export async function saveLoop(input: SaveLoopInput): Promise<{ ok: boolean; id: string; path: string }> {
  const res = await fetch(`${BASE}/loop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`saveLoop: ${res.status}`)
  return (await res.json()) as { ok: boolean; id: string; path: string }
}

export async function scanLoop(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/scan?id=${encodeURIComponent(id)}`, { method: 'POST' })
  if (!res.ok) throw new Error(`scanLoop: ${res.status}`)
  return (await res.json()) as { ok: boolean }
}
