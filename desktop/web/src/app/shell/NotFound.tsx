import { Compass } from 'lucide-react'

/** 未匹配路由的 404 兜底。 */
export function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="text-center">
        <Compass className="mx-auto size-10 text-muted-foreground" />
        <h1 className="mt-3 text-lg font-semibold text-foreground">页面不存在</h1>
        <p className="mt-1 text-sm text-muted-foreground">找不到你要的内容。</p>
        <a
          href="/"
          className="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          回首页
        </a>
      </div>
    </div>
  )
}
