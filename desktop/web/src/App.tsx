import { Providers } from './app/providers'
import { AppRouter } from './app/router'

/**
 * ymesh 桌面端 web 壳入口。
 *
 * fork 自 yonder apps/web，剥离全部业务（auth/contracts/bridge.rs），
 * 保留壳 + ui + 通用 hooks。四区布局（顶栏/看板/管家/工具栏）由各 feature loop 落地。
 */
export function App() {
  return (
    <Providers>
      <AppRouter />
    </Providers>
  )
}
