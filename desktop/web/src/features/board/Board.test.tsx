import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { Board } from './Board'
import type { TaskCardData } from './types'

// fe-board 组件测试：mock /api/tasks，断言渲染卡片 + 状态色 + 悬停摘要 + 空态。

const MOCK_TASKS: TaskCardData[] = [
  {
    id: 't1',
    title: '修登录 bug',
    status: 'live',
    agent: 'claude',
    lastActivity: new Date(Date.now() - 5 * 60000).toISOString(),
    device: '本机',
    summary: '正在排查 auth-store 的 token 刷新逻辑',
    project: 'yondermesh',
    category: 'bugfix',
  },
  {
    id: 't2',
    title: '写看板组件',
    status: 'idle',
    agent: 'codex',
    lastActivity: new Date(Date.now() - 2 * 3600000).toISOString(),
    device: '设备-桌面',
    summary: 'Board 组件骨架已搭好，等 /api/tasks',
    project: 'yondermesh',
    category: 'feature',
  },
  {
    id: 't3',
    title: '跑测试',
    status: 'failed',
    agent: 'aider',
    lastActivity: new Date(Date.now() - 60000).toISOString(),
    device: '本机',
    summary: 'vitest 超时',
    project: '其他项目',
    category: 'ci',
  },
]

function mockFetch(tasks: TaskCardData[] | null) {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => (tasks === null ? { tasks: [] } : { tasks }),
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

function withClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('Board', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('按项目/类别分组渲染卡片', async () => {
    mockFetch(MOCK_TASKS)
    withClient(<Board />)
    await screen.findByTestId('board')
    const projects = screen.getAllByTestId('task-group').map((e) => e.dataset.project)
    expect(projects).toEqual(['yondermesh', '其他项目'])
    const ymGroup = screen.getAllByTestId('task-group')[0]
    const cats = within(ymGroup).getAllByTestId('task-category').map((e) => e.dataset.category)
    expect(cats).toEqual(['bugfix', 'feature'])
    expect(screen.getAllByTestId('task-card')).toHaveLength(3)
  })

  it('状态色正确映射到 Badge variant（data-status）', async () => {
    mockFetch(MOCK_TASKS)
    withClient(<Board />)
    await screen.findByTestId('board')
    const cards = screen.getAllByTestId('task-card')
    const statuses = cards.map((c) => c.dataset.status)
    expect(statuses).toContain('live')
    expect(statuses).toContain('idle')
    expect(statuses).toContain('failed')
    const liveCard = cards.find((c) => c.dataset.status === 'live')!
    expect(within(liveCard).getByTestId('task-status').textContent).toBe('进行中')
    const failedCard = cards.find((c) => c.dataset.status === 'failed')!
    expect(within(failedCard).getByTestId('task-status').textContent).toBe('失败')
  })

  it('悬停摘要显示（title + summary 段落）', async () => {
    mockFetch(MOCK_TASKS)
    withClient(<Board />)
    await screen.findByTestId('board')
    const liveCard = screen.getAllByTestId('task-card').find((c) => c.dataset.status === 'live')!
    expect(liveCard.getAttribute('title')).toBe('正在排查 auth-store 的 token 刷新逻辑')
    expect(within(liveCard).getByTestId('task-summary').textContent).toContain('auth-store')
  })

  it('空态处理：无任务时显示空态', async () => {
    mockFetch([])
    withClient(<Board />)
    expect(await screen.findByTestId('board-empty')).toBeTruthy()
    expect(screen.queryByTestId('task-card')).toBeNull()
  })
})
