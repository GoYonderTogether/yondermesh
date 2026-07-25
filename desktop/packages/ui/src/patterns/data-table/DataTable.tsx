import { cn } from '../../utils/cn'
import { ArrowDown, ArrowUp, ArrowUpDown, Pencil, Search } from 'lucide-react'
import { EditableCell } from './EditableCell'
import type { DataTableProps, RowLike } from './types'
import { cellText, useDataTable } from './use-data-table'

/**
 * 通用 DataTable（design/00 §7 + §8 复用）：下沉至 @ymesh/ui，web 与 admin 共用。
 * - 任意字段 搜索 / 排序 / 行内编辑 / 深入编辑
 * - 列配置 + 数据 props 驱动，组件不内置任何业务字段或 mock 种子数据
 * - 默认空数据（data 缺省为 []）→ 展示空状态
 * 仅用语义 token，交互元素带 data-testid。
 */
export function DataTable<T extends RowLike>({
  columns,
  data = [],
  onEditCell,
  onDeepEdit,
  searchPlaceholder = 'Search…',
  emptyText = 'No data',
  testId = 'data-table',
}: DataTableProps<T>) {
  const { query, setQuery, sort, toggleSort, rows } = useDataTable(columns, data)
  const hasSearchable = columns.some((c) => c.searchable)
  const showActions = Boolean(onDeepEdit)

  return (
    <div data-testid={testId} className="flex h-full min-h-0 flex-col gap-3">
      {hasSearchable ? (
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-quaternary" />
          <input
            data-testid={`${testId}-search`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-9 w-full rounded-lg bg-input pl-8 pr-3 text-sm text-foreground outline-none placeholder:text-text-quaternary focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left text-text-tertiary">
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  className="px-3 py-2 font-medium"
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      data-testid={`${testId}-sort-${col.key}`}
                      onClick={() => toggleSort(col.key)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      {col.header}
                      <SortIcon active={sort?.key === col.key} direction={sort?.direction} />
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              ))}
              {showActions ? <th className="w-16 px-3 py-2 font-medium">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  data-testid={`${testId}-empty`}
                  colSpan={columns.length + (showActions ? 1 : 0)}
                  className="px-3 py-16 text-center text-text-tertiary"
                >
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border/60 last:border-0 hover:bg-secondary-button/40"
                >
                  {columns.map((col) => (
                    <td key={col.key} className="px-3 py-2 text-foreground">
                      {col.editable && onEditCell ? (
                        <EditableCell
                          col={col}
                          row={row}
                          testId={`${testId}-cell-${row.id}-${col.key}`}
                          onCommit={(value) => onEditCell(row.id, col.key, value)}
                        />
                      ) : col.render ? (
                        col.render(row[col.key], row)
                      ) : (
                        <span className="block truncate">{cellText(col, row)}</span>
                      )}
                    </td>
                  ))}
                  {showActions ? (
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        data-testid={`${testId}-deep-edit-${row.id}`}
                        onClick={() => onDeepEdit?.(row)}
                        aria-label="Edit"
                        title="Edit"
                        className={cn(
                          'inline-flex size-7 items-center justify-center rounded-md text-text-tertiary',
                          'transition-colors hover:bg-secondary-button hover:text-foreground',
                        )}
                      >
                        <Pencil className="size-4" />
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SortIcon({ active, direction }: { active: boolean; direction?: 'asc' | 'desc' }) {
  if (!active) return <ArrowUpDown className="size-3.5 opacity-50" />
  return direction === 'asc' ? (
    <ArrowUp className="size-3.5" />
  ) : (
    <ArrowDown className="size-3.5" />
  )
}
