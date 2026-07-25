// fe-tools-rail：文件浏览面板（限定工作目录）。
//
// 首版为占位树（工作目录根 + 模拟条目）；Tauri FS 后续接入。
// 限定工作目录：不可向上越级（防误操作）。

import { ChevronRight, File, Folder } from 'lucide-react'
import { useState } from 'react'
import type { FileNode } from './types'
import { cn } from '@ymesh/ui'

const MOCK_TREE: FileNode[] = [
  {
    name: 'src',
    path: 'src',
    isDir: true,
    children: [
      { name: 'index.ts', path: 'src/index.ts', isDir: false },
      { name: 'adapters', path: 'src/adapters', isDir: true },
    ],
  },
  {
    name: 'desktop',
    path: 'desktop',
    isDir: true,
    children: [
      { name: 'web', path: 'desktop/web', isDir: true },
      { name: 'src-tauri', path: 'desktop/src-tauri', isDir: true },
    ],
  },
  { name: 'package.json', path: 'package.json', isDir: false },
  { name: 'README.md', path: 'README.md', isDir: false },
]

function TreeRow({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(false)
  const hasChildren = node.isDir && node.children && node.children.length > 0
  return (
    <div data-testid="file-node" data-path={node.path} data-dir={node.isDir}>
      <button
        type="button"
        onClick={() => hasChildren && setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs hover:bg-secondary/40"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {hasChildren ? (
          <ChevronRight className={cn('size-3 shrink-0', open && 'rotate-90')} />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {node.isDir ? (
          <Folder className="size-3.5 shrink-0 text-text-secondary" />
        ) : (
          <File className="size-3.5 shrink-0 text-text-tertiary" />
        )}
        <span className="truncate text-foreground">{node.name}</span>
      </button>
      {hasChildren && open ? (
        <div>
          {node.children!.map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function FileBrowserPanel({ cwd }: { cwd?: string }) {
  return (
    <div data-testid="file-browser-panel" className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-1.5 text-[10px] text-text-tertiary">
        <span data-testid="file-cwd">{cwd ?? '(工作目录未设置)'}</span>
      </div>
      <div className="flex-1 overflow-auto">
        {MOCK_TREE.map((n) => (
          <TreeRow key={n.path} node={n} depth={0} />
        ))}
      </div>
    </div>
  )
}
