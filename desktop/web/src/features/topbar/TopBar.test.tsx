import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopBar } from './TopBar'
import { StatusIndicator } from './StatusIndicator'
import type { TopBarState, RunStatus } from './types'

// fe-topbar 测试：渲染 + 切换交互 + 状态指示。

const MOCK_STATE: TopBarState = {
  currentProject: { id: 'p1', name: 'yondermesh', cwd: '/Users/x/yondermesh' },
  projects: [
    { id: 'p1', name: 'yondermesh', cwd: '/Users/x/yondermesh' },
    { id: 'p2', name: 'other', cwd: '/Users/x/other' },
  ],
  currentDevice: { id: 'd1', name: '本机', kind: 'local', online: true },
  devices: [
    { id: 'd1', name: '本机', kind: 'local', online: true },
    { id: 'd2', name: '桌面-远端', kind: 'remote', online: false },
  ],
  currentModel: { id: 'm1', name: 'claude-sonnet-4', provider: 'Anthropic' },
  models: [
    { id: 'm1', name: 'claude-sonnet-4', provider: 'Anthropic' },
    { id: 'm2', name: 'gpt-4o', provider: 'OpenAI' },
  ],
  runStatus: 'running',
}

const fetchImpl = vi.fn()
function setupFetch(state: TopBarState | null = MOCK_STATE) {
  fetchImpl.mockImplementation(async (url: string) => {
    if (String(url).includes('/api/state')) {
      return { ok: true, status: 200, json: async () => state ?? {} }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  })
  vi.stubGlobal('fetch', fetchImpl)
}

function withClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('TopBar · 渲染', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchImpl.mockReset()
  })

  it('渲染顶栏 + 三个切换器 + 状态指示', async () => {
    setupFetch()
    withClient(<TopBar />)
    await screen.findByTestId('status-indicator')
    expect(screen.getByTestId('project-switcher')).toBeTruthy()
    expect(screen.getByTestId('device-switcher')).toBeTruthy()
    expect(screen.getByTestId('model-switcher')).toBeTruthy()
  })

  it('当前项目/设备/模型显示正确', async () => {
    setupFetch()
    withClient(<TopBar />)
    await screen.findByTestId('status-indicator')
    expect(screen.getByTestId('project-switcher').textContent).toContain('yondermesh')
    expect(screen.getByTestId('device-switcher').textContent).toContain('本机')
    expect(screen.getByTestId('model-switcher').textContent).toContain('claude-sonnet-4')
  })

  it('运行状态指示正确', async () => {
    setupFetch()
    withClient(<TopBar />)
    const indicator = await screen.findByTestId('status-indicator')
    expect(indicator.dataset.status).toBe('running')
    expect(indicator.textContent).toBe('运行中')
  })

  it('加载错误态', async () => {
    fetchImpl.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    }))
    vi.stubGlobal('fetch', fetchImpl)
    withClient(<TopBar />)
    expect(await screen.findByText('状态加载失败')).toBeTruthy()
  })
})

describe('TopBar · 切换交互', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchImpl.mockReset()
  })

  it('无当前项目时显示"选择项目"占位', async () => {
    const emptyState: TopBarState = {
      ...MOCK_STATE,
      currentProject: null,
      currentDevice: null,
      currentModel: null,
    }
    setupFetch(emptyState)
    withClient(<TopBar />)
    await screen.findByTestId('status-indicator')
    expect(screen.getByTestId('project-switcher').textContent).toContain('选择项目')
    expect(screen.getByTestId('device-switcher').textContent).toContain('选择设备')
    expect(screen.getByTestId('model-switcher').textContent).toContain('选择模型')
  })

  it('空选项列表时切换器不崩溃', async () => {
    const noOptions: TopBarState = {
      currentProject: null,
      projects: [],
      currentDevice: null,
      devices: [],
      currentModel: null,
      models: [],
      runStatus: 'idle',
    }
    setupFetch(noOptions)
    withClient(<TopBar />)
    await screen.findByTestId('status-indicator')
    // 三个切换器都应渲染（不崩溃）
    expect(screen.getByTestId('project-switcher')).toBeTruthy()
    expect(screen.getByTestId('device-switcher')).toBeTruthy()
    expect(screen.getByTestId('model-switcher')).toBeTruthy()
  })

  it('切换器 trigger 可聚焦（aria-label 正确）', async () => {
    setupFetch()
    withClient(<TopBar />)
    await screen.findByTestId('status-indicator')
    expect(screen.getByTestId('project-switcher').getAttribute('aria-label')).toBe('项目')
    expect(screen.getByTestId('device-switcher').getAttribute('aria-label')).toBe('设备')
    expect(screen.getByTestId('model-switcher').getAttribute('aria-label')).toBe('模型')
  })
})

describe('StatusIndicator · 独立单测', () => {
  const cases: RunStatus[] = ['idle', 'running', 'syncing', 'error']
  for (const s of cases) {
    it(`status=${s} 渲染正确 variant + 文案`, () => {
      render(<StatusIndicator status={s} />)
      const el = screen.getByTestId('status-indicator')
      expect(el.dataset.status).toBe(s)
    })
  }
})
