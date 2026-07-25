// fe-tools-rail：右栏工具栏类型。

export type ToolKind = 'terminal' | 'tasks' | 'files'

export interface FileNode {
  name: string
  /** 相对工作目录的路径 */
  path: string
  /** 是否目录 */
  isDir: boolean
  /** 子节点（仅目录且有展开数据时） */
  children?: FileNode[]
}

export interface TerminalLine {
  id: string
  /** 输出来源 */
  stream: 'stdout' | 'stderr' | 'stdin'
  text: string
}
