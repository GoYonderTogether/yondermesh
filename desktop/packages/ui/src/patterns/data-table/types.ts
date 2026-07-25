import type { ReactNode } from 'react'

/** 行数据最小约束：必须有稳定 id 用于 React key 与编辑定位 */
export interface RowLike {
  id: string
}

/**
 * 列配置：DataTable 由「列配置 + 数据 props」驱动，组件本身不内置任何业务字段。
 * 任意字段均可声明 搜索/排序/行内编辑/深入编辑 能力。
 */
export interface ColumnDef<T extends RowLike> {
  /** 字段键（取值用） */
  key: keyof T & string
  /** 表头标题 */
  header: string
  /** 是否参与全局搜索（默认 false） */
  searchable?: boolean
  /** 是否可排序（默认 false） */
  sortable?: boolean
  /** 是否支持行内编辑（默认 false；编辑后回调 onEditCell） */
  editable?: boolean
  /** 自定义单元格渲染（只读展示用，行内编辑态不走此函数） */
  render?: (value: T[keyof T & string], row: T) => ReactNode
  /** 取用于搜索/排序/编辑的字符串值（默认 String(value)） */
  accessor?: (row: T) => string
  /** 列宽（CSS 值，如 '12rem'；不传则自适应） */
  width?: string
}

export type SortDirection = 'asc' | 'desc'

export interface SortState {
  key: string
  direction: SortDirection
}

/** DataTable 主 props：纯受控数据驱动，无任何内置 mock 种子数据 */
export interface DataTableProps<T extends RowLike> {
  /** 列配置 */
  columns: ColumnDef<T>[]
  /** 数据；默认 []（空数据 → 空状态） */
  data?: T[]
  /** 行内编辑某单元格后回调（待接后端持久化） */
  onEditCell?: (rowId: string, key: keyof T & string, value: string) => void
  /** 点击行「深入编辑」回调（打开抽屉/弹窗，由调用方决定） */
  onDeepEdit?: (row: T) => void
  /** 搜索框占位文案 */
  searchPlaceholder?: string
  /** 空状态文案 */
  emptyText?: string
  /** 用于 data-testid 前缀，便于测试定位 */
  testId?: string
}
