/**
 * 相对时间格式化（统一实现，去重 5 处重复）。
 * 用 i18n 翻译「刚刚 / X 分钟前 / X 小时前 / X 天前 / 从未」。
 *
 * 替代原先散落在 ChannelList/SessionList/MePage/AgentManageModal/notification-store
 * 各自实现的中文相对时间函数。
 */
import i18n from './i18n'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/**
 * 格式化为相对时间字符串。
 * @param iso ISO 时间字符串；null/undefined/非法 → t('state.never')
 * @param now 当前时间基准（测试可注入）
 */
export function formatRelativeTime(iso?: string | null, now: Date = new Date()): string {
  if (!iso) return i18n.t('state.never')
  const d = new Date(iso)
  const ts = d.getTime()
  if (Number.isNaN(ts)) return i18n.t('state.never')

  const diff = now.getTime() - ts
  if (diff < 0) return i18n.t('time.justNow') // 未来时间兜底
  if (diff < MINUTE) return i18n.t('time.justNow')
  if (diff < HOUR) return i18n.t('time.minutesAgo', { count: Math.floor(diff / MINUTE) })
  if (diff < DAY) return i18n.t('time.hoursAgo', { count: Math.floor(diff / HOUR) })
  return i18n.t('time.daysAgo', { count: Math.floor(diff / DAY) })
}
