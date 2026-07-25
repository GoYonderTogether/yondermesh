import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StewardChat } from './StewardChat'
import { MessageList } from './MessageList'
import type { Message } from './types'

// fe-steward-chat 组件测试：
//   - 多模态渲染（md 代码块 / png / svg）
//   - 消息流正确（角色 + 内容顺序）
//   - 输入提交（Enter 发送、空内容禁用、Shift+Enter 换行）
//   - 空态

const MOCK_MESSAGES: Message[] = [
  {
    id: 'm1',
    role: 'user',
    createdAt: new Date(Date.now() - 60000).toISOString(),
    contents: [{ type: 'text', text: '帮我修登录 bug' }],
  },
  {
    id: 'm2',
    role: 'assistant',
    createdAt: new Date(Date.now() - 30000).toISOString(),
    contents: [
      { type: 'text', text: '正在排查 `auth-store` 的 token 刷新逻辑。' },
      {
        type: 'code',
        language: 'typescript',
        code: 'function refreshToken(t: string) { return t + Date.now() }',
      },
      {
        type: 'image-svg',
        src: 'data:image/svg+xml;base64,PHN2Zy8+',
        alt: '调用关系图',
      },
    ],
  },
  {
    id: 'm3',
    role: 'assistant',
    createdAt: new Date().toISOString(),
    contents: [
      {
        type: 'image-png',
        src: 'data:image/png;base64,iVBORw0KGgo=',
        alt: '截图',
      },
    ],
  },
]

const fetchImpl = vi.fn()
function setupFetch(messages: Message[] | null = MOCK_MESSAGES) {
  fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/api/steward/messages') && (!init || init.method === undefined)) {
      return { ok: true, status: 200, json: async () => ({ messages: messages ?? [] }) }
    }
    if (u.includes('/api/steward/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'm-new',
          role: 'assistant',
          createdAt: new Date().toISOString(),
          contents: [{ type: 'text', text: `收到：${body.text}` }],
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  })
  vi.stubGlobal('fetch', fetchImpl)
}

function withClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('StewardChat · 消息流', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchImpl.mockReset()
  })

  it('渲染消息列表 + 角色 + 顺序', async () => {
    setupFetch()
    withClient(<StewardChat />)
    const list = await screen.findByTestId('message-list')
    expect(list).toBeTruthy()
    const items = screen.getAllByTestId('message-item')
    expect(items).toHaveLength(3)
    const roles = items.map((i) => i.dataset.role)
    expect(roles).toEqual(['user', 'assistant', 'assistant'])
    expect(within(items[0]).getByTestId('message-role').textContent).toBe('我')
    expect(within(items[1]).getByTestId('message-role').textContent).toBe('管家')
  })

  it('md 代码块渲染（行内 code + 代码块 + 语言标签）', async () => {
    setupFetch()
    withClient(<StewardChat />)
    await screen.findByTestId('message-list')
    // 行内 code
    expect(screen.getByText('auth-store').tagName).toBe('CODE')
    // 代码块
    const codeBlocks = screen.getAllByTestId('content-code')
    expect(codeBlocks).toHaveLength(1)
    expect(codeBlocks[0].dataset.language).toBe('typescript')
    expect(within(codeBlocks[0]).getByText(/function refreshToken/)).toBeTruthy()
  })

  it('png/svg 图预览渲染', async () => {
    setupFetch()
    withClient(<StewardChat />)
    await screen.findByTestId('message-list')
    const svg = screen.getByTestId('content-image-svg')
    expect(svg.querySelector('img')?.getAttribute('src')).toContain('image/svg+xml')
    expect(within(svg).getByText('调用关系图')).toBeTruthy()
    const png = screen.getByTestId('content-image-png')
    expect(png.querySelector('img')?.getAttribute('src')).toContain('image/png')
    expect(within(png).getByText('截图')).toBeTruthy()
  })

  it('空态：无消息时显示提示', async () => {
    setupFetch([])
    withClient(<StewardChat />)
    expect(await screen.findByTestId('messages-empty')).toBeTruthy()
    expect(screen.queryByTestId('message-item')).toBeNull()
  })

  it('加载错误态', async () => {
    fetchImpl.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    }))
    vi.stubGlobal('fetch', fetchImpl)
    withClient(<StewardChat />)
    expect(await screen.findByText('加载失败')).toBeTruthy()
  })
})

describe('StewardChat · 输入提交', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchImpl.mockReset()
  })

  it('空内容禁用发送按钮', async () => {
    setupFetch()
    withClient(<StewardChat />)
    await screen.findByTestId('message-list')
    const sendBtn = screen.getByTestId('chat-send') as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
  })

  it('输入后点按钮发送 → POST /api/steward/messages', async () => {
    setupFetch([])
    withClient(<StewardChat />)
    await screen.findByTestId('messages-empty')
    const ta = screen.getByTestId('chat-textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '帮我跑下测试' } })
    const sendBtn = screen.getByTestId('chat-send') as HTMLButtonElement
    await waitFor(() => expect(sendBtn.disabled).toBe(false))
    fireEvent.click(sendBtn)
    await waitFor(() => {
      const calls = fetchImpl.mock.calls.filter(
        ([u, init]) =>
          String(u).includes('/api/steward/messages') &&
          (init as RequestInit | undefined)?.method === 'POST',
      )
      expect(calls.length).toBeGreaterThanOrEqual(1)
      const body = JSON.parse(String((calls[0][1] as RequestInit).body))
      expect(body.text).toBe('帮我跑下测试')
    })
  })

  it('Enter 发送、Shift+Enter 不发送（仅换行）', async () => {
    setupFetch([])
    withClient(<StewardChat />)
    await screen.findByTestId('messages-empty')
    const ta = screen.getByTestId('chat-textarea') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hi' } })
    // Shift+Enter：不应触发 POST
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    const postsBefore = fetchImpl.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    ).length
    expect(postsBefore).toBe(0)
    // Enter：触发 POST
    fireEvent.keyDown(ta, { key: 'Enter' })
    await waitFor(() => {
      const posts = fetchImpl.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      ).length
      expect(posts).toBeGreaterThanOrEqual(1)
    })
  })

  it('MessageList 直接渲染：仅传入 props（不依赖 react-query）', () => {
    render(<MessageList messages={MOCK_MESSAGES} />)
    expect(screen.getByTestId('message-list')).toBeTruthy()
    expect(screen.getAllByTestId('message-item')).toHaveLength(3)
  })
})
