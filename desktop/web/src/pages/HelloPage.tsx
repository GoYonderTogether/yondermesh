import { Card } from '@ymesh/ui'

/**
 * fork-yonder-shell 的 hello 页：验证壳 + ui + 路由可跑。
 * 各 feature loop 落地后由对应页面替换。
 */
export function HelloPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground">yondermesh 桌面端</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          壳已就绪。看板 / 管家 / 工具栏 / 设置 / Loops 由各 feature loop 落地。
        </p>
      </Card>
    </div>
  )
}
