import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolsRail } from './ToolsRail'
import { CollapsibleSection } from './CollapsibleSection'

// fe-tools-rail 测试：三分区渲染 + 可折叠 + 终端输入回显 + 任务清单空态。

function mockFetch(tasks: unknown[] | null = null) {
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

describe('ToolsRail · 三分区渲染', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('渲染三个分区：终端 / 任务清单 / 文件浏览', () => {
    mockFetch([])
    withClient(<ToolsRail />)
    const sections = screen.getAllByTestId('tool-section')
    expect(sections).toHaveLength(3)
    const titles = sections.map((s) => within(s).getByTestId('tool-section-toggle').textContent)
    expect(titles).toEqual(['终端', '任务清单', '文件浏览'])
  })

  it('默认展开终端 + 任务清单，收起文件浏览', () => {
    mockFetch([])
    withClient(<ToolsRail />)
    const sections = screen.getAllByTestId('tool-section')
    expect(sections[0].dataset.open).toBe('true') // 终端
    expect(sections[1].dataset.open).toBe('true') // 任务清单
    expect(sections[2].dataset.open).toBe('false') // 文件浏览
  })

  it('点折叠按钮收起/展开分区', () => {
    mockFetch([])
    withClient(<ToolsRail />)
    const sections = screen.getAllByTestId('tool-section')
    const terminalToggle = within(sections[0]).getByTestId('tool-section-toggle')
    // 收起
    fireEvent.click(terminalToggle)
    expect(sections[0].dataset.open).toBe('false')
    expect(within(sections[0]).queryByTestId('terminal-panel')).toBeNull()
    // 再展开
    fireEvent.click(terminalToggle)
    expect(sections[0].dataset.open).toBe('true')
    expect(within(sections[0]).getByTestId('terminal-panel')).toBeTruthy()
  })
})

describe('ToolsRail · 终端面板', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('输入命令回车 → 回显到输出', () => {
    mockFetch([])
    withClient(<ToolsRail />)
    const input = screen.getByTestId('terminal-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ls -la' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const lines = screen.getAllByTestId('terminal-line')
    const stdinLine = lines.find((l) => l.dataset.stream === 'stdin')
    expect(stdinLine?.textContent).toBe('ls -la')
  })

  it('点"运行"按钮提交命令', () => {
    mockFetch([])
    withClient(<ToolsRail />)
    const input = screen.getByTestId('terminal-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'pwd' } })
    fireEvent.click(screen.getByTestId('terminal-run'))
    const lines = screen.getAllByTestId('terminal-line')
    expect(lines.some((l) => l.textContent === 'pwd')).toBe(true)
  })
})

describe('ToolsRail · 任务清单面板', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('空态：无任务时提示', async () => {
    mockFetch([])
    withClient(<ToolsRail />)
    expect(await screen.findByTestId('tasks-empty')).toBeTruthy()
  })

  it('有任务时渲染列表（按最后活动排序）', async () => {
    mockFetch([
      {
        id: 't1',
        title: '老任务',
        status: 'idle',
        agent: 'aider',
        lastActivity: new Date(Date.now() - 2 * 3600000).toISOString(),
        device: '本机',
        summary: '',
        project: 'p',
        category: 'c',
      },
      {
        id: 't2',
        title: '新任务',
        status: 'live',
        agent: 'claude',
        lastActivity: new Date(Date.now() - 60000).toISOString(),
        device: '本机',
        summary: '',
        project: 'p',
        category: 'c',
      },
    ])
    withClient(<ToolsRail />)
    const list = await screen.findByTestId('task-list')
    const items = within(list).getAllByTestId('task-list-item')
    expect(items).toHaveLength(2)
    // 新任务排前
    expect(items[0].dataset.status).toBe('live')
    expect(items[1].dataset.status).toBe('idle')
  })
})

describe('ToolsRail · 文件浏览面板', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('渲染工作目录 + 文件树', () => {
    mockFetch([])
    withClient(<ToolsRail cwd="/Users/x/yondermesh" defaultOpen={{ files: true }} />)
    expect(screen.getByTestId('file-cwd').textContent).toBe('/Users/x/yondermesh')
    const nodes = screen.getAllByTestId('file-node')
    expect(nodes.length).toBeGreaterThan(0)
  })

  it('点击目录节点展开子项', () => {
    mockFetch([])
    withClient(<ToolsRail defaultOpen={{ files: true }} />)
    const dirNode = screen.getAllByTestId('file-node').find((n) => n.dataset.dir === 'true')
    expect(dirNode).toBeTruthy()
    const initialNodes = screen.getAllByTestId('file-node').length
    fireEvent.click(within(dirNode!).getByRole('button'))
    expect(screen.getAllByTestId('file-node').length).toBeGreaterThan(initialNodes)
  })
})

describe('CollapsibleSection · 独立单测', () => {
  it('defaultOpen=false 时初始收起', () => {
    render(
      <CollapsibleSection title="x" defaultOpen={false}>
        <div data-testid="body">content</div>
      </CollapsibleSection>,
    )
    const section = screen.getByTestId('tool-section')
    expect(section.dataset.open).toBe('false')
    expect(screen.queryByTestId('body')).toBeNull()
  })
})
