import { Component, type ReactNode } from 'react'

interface State {
  hasError: boolean
  message?: string
}

/** 顶层错误兜底：子树抛错时显示提示，不白屏。 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(err: unknown): State {
    const message = err instanceof Error ? err.message : String(err)
    return { hasError: true, message }
  }

  componentDidCatch(error: unknown) {
    console.error('[ErrorBoundary]', error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="max-w-md text-center">
            <h1 className="text-lg font-semibold text-foreground">出错了</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {this.state.message ?? '未知错误'}
            </p>
            <button
              type="button"
              className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
              onClick={() => location.reload()}
            >
              刷新
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
