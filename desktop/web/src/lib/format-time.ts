/**
 * 消息列表时间桶格式化：
 * - 当日 → 准确的 24 小时时间 HH:mm
 * - 1/2/3 天前 → i18n(time.oneDayAgo/twoDaysAgo/threeDaysAgo)
 * - 更早 → 日期（同年 M月D日，跨年 YYYY年M月D日，均经 i18n）
 */
import i18n from './i18n'

const DAY_MS = 86_400_000

/** 取某时刻的「当地午夜」时间戳，用于按自然日计算天数差 */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const DAYS_AGO_KEY: Record<number, string> = {
  1: 'time.oneDayAgo',
  2: 'time.twoDaysAgo',
  3: 'time.threeDaysAgo',
}

/** 格式化会话列表时间（入参 ISO 字符串；非法/空返回空串） */
export function formatListTime(iso?: string | null, now: Date = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''

  // 按自然日计算天数差（非 24h 滚动窗，避免「昨晚 23 点」被算成今天）
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(d)) / DAY_MS)

  // 当日（含时钟偏差导致的未来时间）→ 24 小时 HH:mm
  if (days <= 0) {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }

  const daysAgoKey = DAYS_AGO_KEY[days]
  if (daysAgoKey) return i18n.t(daysAgoKey)

  // 更早 → 日期
  const m = d.getMonth() + 1
  const day = d.getDate()
  if (d.getFullYear() === now.getFullYear()) return i18n.t('time.sameYearDate', { m, d: day })
  return i18n.t('time.crossYearDate', { y: d.getFullYear(), m, d: day })
}
