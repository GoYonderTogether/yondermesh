// fe-tools-rail：终端面板。
//
// 首版为本地态占位（输入回显 + 模拟提示），Tauri shell 进程能力后续接入。
// 不直接 spawn shell（浏览器/纯前端模式下无能力），留 Tauri IPC 钩子。

import { Button, Input } from '@ymesh/ui'
import { useState } from 'react'
import type { TerminalLine } from './types'

let lineSeq = 0
function nextId() {
  lineSeq += 1
  return `tl-${lineSeq}`
}

export function TerminalPanel() {
  const [lines, setLines] = useState<TerminalLine[]>([
    { id: nextId(), stream: 'stdout', text: 'yondermesh terminal · 首版占位（Tauri shell 后续接入）' },
    { id: nextId(), stream: 'stdout', text: '$ ' },
  ])
  const [input, setInput] = useState('')

  const submit = () => {
    const text = input.trim()
    if (!text) return
    setLines((prev) => [
      ...prev,
      { id: nextId(), stream: 'stdin', text },
      { id: nextId(), stream: 'stdout', text: `（占位）未连接 shell：${text}` },
      { id: nextId(), stream: 'stdout', text: '$ ' },
    ])
    setInput('')
  }

  return (
    <div data-testid="terminal-panel" className="flex h-full min-h-0 flex-col">
      <div
        data-testid="terminal-output"
        className="flex-1 min-h-0 overflow-auto bg-card px-3 py-2 font-mono text-xs"
      >
        {lines.map((l) => (
          <div
            key={l.id}
            data-testid="terminal-line"
            data-stream={l.stream}
            className={
              l.stream === 'stderr'
                ? 'text-destructive'
                : l.stream === 'stdin'
                  ? 'text-foreground'
                  : 'text-text-secondary'
            }
          >
            {l.text}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
        <Input
          data-testid="terminal-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="输入命令…（Enter 执行）"
          className="h-7 font-mono text-xs"
        />
        <Button size="xs" data-testid="terminal-run" onClick={submit}>
          运行
        </Button>
      </div>
    </div>
  )
}
