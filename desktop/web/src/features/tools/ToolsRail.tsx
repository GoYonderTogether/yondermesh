// fe-tools-rail：右栏工具栏（终端 / 任务清单 / 文件浏览）。
//
// 类 Codex 右栏：三个可折叠分区。任务清单复用看板数据（另一种视图）。
// 终端首版占位（Tauri shell 后续）；文件浏览首版占位树（Tauri FS 后续）。

import { CollapsibleSection } from './CollapsibleSection'
import { TerminalPanel } from './TerminalPanel'
import { TaskListPanel } from './TaskListPanel'
import { FileBrowserPanel } from './FileBrowserPanel'

export interface ToolsRailProps {
  /** 工作目录（限定文件浏览范围） */
  cwd?: string
  /** 默认展开哪些分区 */
  defaultOpen?: {
    terminal?: boolean
    tasks?: boolean
    files?: boolean
  }
}

export function ToolsRail({
  cwd,
  defaultOpen = { terminal: true, tasks: true, files: false },
}: ToolsRailProps = {}) {
  return (
    <div
      data-testid="tools-rail"
      className="flex h-full min-h-0 w-full flex-col bg-background"
    >
      <CollapsibleSection title="终端" defaultOpen={defaultOpen.terminal}>
        <div className="h-64">
          <TerminalPanel />
        </div>
      </CollapsibleSection>
      <CollapsibleSection title="任务清单" defaultOpen={defaultOpen.tasks}>
        <div className="max-h-72">
          <TaskListPanel />
        </div>
      </CollapsibleSection>
      <CollapsibleSection title="文件浏览" defaultOpen={defaultOpen.files}>
        <div className="h-72">
          <FileBrowserPanel cwd={cwd} />
        </div>
      </CollapsibleSection>
    </div>
  )
}
