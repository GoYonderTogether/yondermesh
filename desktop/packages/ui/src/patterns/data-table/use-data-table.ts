import { useMemo, useState } from 'react'
import type { ColumnDef, RowLike, SortState } from './types'

/** 取列在某行的字符串值（搜索/排序统一口径） */
export function cellText<T extends RowLike>(col: ColumnDef<T>, row: T): string {
  if (col.accessor) return col.accessor(row)
  const v = row[col.key]
  return v == null ? '' : String(v)
}

/**
 * 表格派生状态 hook：搜索 + 排序。
 * 纯前端计算，作用于传入的 data props；不持有数据源。
 */
export function useDataTable<T extends RowLike>(columns: ColumnDef<T>[], data: T[]) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)

  const searchableCols = useMemo(() => columns.filter((c) => c.searchable), [columns])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return data
    return data.filter((row) =>
      searchableCols.some((col) => cellText(col, row).toLowerCase().includes(q)),
    )
  }, [data, query, searchableCols])

  const sorted = useMemo(() => {
    if (!sort) return filtered
    const col = columns.find((c) => c.key === sort.key)
    if (!col) return filtered
    const factor = sort.direction === 'asc' ? 1 : -1
    // 复制后排序，避免就地修改 props 数据
    return [...filtered].sort(
      (a, b) => cellText(col, a).localeCompare(cellText(col, b), 'zh') * factor,
    )
  }, [filtered, sort, columns])

  /** 点击表头：none → asc → desc → none 循环 */
  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, direction: 'asc' }
      if (prev.direction === 'asc') return { key, direction: 'desc' }
      return null
    })
  }

  return { query, setQuery, sort, toggleSort, rows: sorted }
}
