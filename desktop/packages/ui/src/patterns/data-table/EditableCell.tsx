import { Input } from '../../components/input'
import { useEffect, useRef, useState } from 'react'
import type { ColumnDef, RowLike } from './types'
import { cellText } from './use-data-table'

interface EditableCellProps<T extends RowLike> {
  col: ColumnDef<T>
  row: T
  testId: string
  /** 提交编辑值（待接后端持久化） */
  onCommit: (value: string) => void
}

/**
 * 行内编辑单元格：双击进入编辑态，Enter/失焦提交，Esc 取消。
 * 只读态优先使用列的 render，否则展示字符串值。
 */
export function EditableCell<T extends RowLike>({
  col,
  row,
  testId,
  onCommit,
}: EditableCellProps<T>) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const start = () => {
    setDraft(cellText(col, row))
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next !== cellText(col, row)) onCommit(next)
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        data-testid={`${testId}-input`}
        className="h-7"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }

  return (
    <button
      type="button"
      data-testid={testId}
      onDoubleClick={start}
      title="Double-click to edit"
      className="-mx-1 block w-full truncate rounded px-1 py-0.5 text-left hover:bg-secondary-button"
    >
      {col.render ? col.render(row[col.key], row) : cellText(col, row)}
    </button>
  )
}
