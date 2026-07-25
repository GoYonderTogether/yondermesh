import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoopsDashboard } from './LoopsDashboard'
import type { Loop } from './types'

// fe-loops-dashboard 测试：mock /api，断言列表渲染 + 状态色 + 保存/扫描交互。

const LOOPS: Loop[] = [
  {
    id: 'fe-board', title: '任务看板', status: 'passed', feature: '', verifier: 'echo ok',
    created: '2026-07-21', last_run: '2026-07-25 10:00:00', goal: 'g', context: 'c',
    action: 'a', observation: 'o', prompt: 'p', path: 'tasks/loops/fe-board.md',
  },
  {
    id: 'fe-loops-dashboard', title: 'loop 看板', status: 'draft', feature: '', verifier: 'echo ok',
    created: '2026-07-21', last_run: '', goal: 'g2', context: 'c2',
    action: 'a2', observation: 'o2', prompt: 'p2', path: 'tasks/loops/fe-loops-dashboard.md',
  },
]

const fetchImpl = vi.fn()
function setupFetch() {
  fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/api/loops') && (!init || init.method === undefined)) {
      return { ok: true, status: 200, json: async () => LOOPS }
    }
    if (u.includes('/api/loop?id=')) {
      const id = new URL(u, 'http://x').searchParams.get('id')
      const found = LOOPS.find((l) => l.id === id) ?? LOOPS[0]
      return { ok: true, status: 200, json: async () => found }
    }
    if (u.includes('/api/loop') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      return { ok: true, status: 200, json: async () => ({ ok: true, id: body.id ?? 'new', path: 'x' }) }
    }
    if (u.includes('/api/scan') && init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  })
  vi.stubGlobal('fetch', fetchImpl)
}

function withClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('LoopsDashboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchImpl.mockReset()
  })

  it('loop 列表渲染 + 状态色正确', async () => {
    setupFetch()
    withClient(<LoopsDashboard />)
    const list = await screen.findByTestId('loop-list')
    expect(list).toBeTruthy()
    const items = screen.getAllByTestId('loop-item')
    expect(items).toHaveLength(2)
    const statuses = items.map((i) => i.dataset.status)
    expect(statuses).toEqual(['passed', 'draft'])
    const badges = items.map((i) => within(i).getByTestId('loop-status').textContent)
    expect(badges).toEqual(['通过', '草稿'])
  })

  it('点 loop 选中并加载编辑器', async () => {
    setupFetch()
    withClient(<LoopsDashboard />)
    await screen.findByTestId('loop-list')
    const draftItem = screen.getAllByTestId('loop-item').find((i) => i.dataset.status === 'draft')!
    draftItem.click()
    const editor = await screen.findByTestId('loop-editor')
    expect(editor).toBeTruthy()
    expect(screen.getByTestId('editor-title').textContent).toBe('loop 看板')
  })

  it('保存交互：点保存触发 POST /api/loop', async () => {
    setupFetch()
    withClient(<LoopsDashboard />)
    await screen.findByTestId('loop-list')
    screen.getAllByTestId('loop-item')[0].click()
    await screen.findByTestId('loop-editor')
    const saveBtn = screen.getByTestId('save-loop')
    saveBtn.click()
    await waitFor(() => {
      const calls = fetchImpl.mock.calls.filter(([u, init]) =>
        String(u).includes('/api/loop') && (init as RequestInit | undefined)?.method === 'POST')
      expect(calls.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('扫描交互：点扫描触发 POST /api/scan', async () => {
    setupFetch()
    withClient(<LoopsDashboard />)
    await screen.findByTestId('loop-list')
    screen.getAllByTestId('loop-item')[0].click()
    await screen.findByTestId('loop-editor')
    screen.getByTestId('scan-loop').click()
    await waitFor(() => {
      const calls = fetchImpl.mock.calls.filter(([u, init]) =>
        String(u).includes('/api/scan') && (init as RequestInit | undefined)?.method === 'POST')
      expect(calls.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('空态：无 loop 时提示', async () => {
    fetchImpl.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/loops')) return { ok: true, status: 200, json: async () => [] }
      return { ok: true, status: 200, json: async () => LOOPS[0] }
    })
    vi.stubGlobal('fetch', fetchImpl)
    withClient(<LoopsDashboard />)
    expect(await screen.findByTestId('loops-empty')).toBeTruthy()
  })
})
