// fe-steward-chat：输入框（多行 textarea + 发送按钮）。
//
// - Enter 发送，Shift+Enter 换行
// - 空内容禁用发送
// - sending 时禁用输入 + 显示"发送中…"

import { Button, Textarea } from '@ymesh/ui'
import { Send } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'

export interface ChatInputProps {
  onSend: (text: string) => void
  sending?: boolean
  placeholder?: string
}

export function ChatInput({ onSend, sending, placeholder }: ChatInputProps) {
  const [text, setText] = useState('')
  const trimmed = text.trim()
  const canSend = trimmed.length > 0 && !sending

  const submit = () => {
    if (!canSend) return
    onSend(trimmed)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      data-testid="chat-input"
      className="flex items-end gap-2 border-t border-border bg-background p-3"
    >
      <Textarea
        data-testid="chat-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? '和管家说点什么…（Enter 发送，Shift+Enter 换行）'}
        disabled={sending}
        className="min-h-10 max-h-48 flex-1"
        rows={1}
      />
      <Button
        data-testid="chat-send"
        size="icon"
        disabled={!canSend}
        onClick={submit}
        aria-label="发送"
      >
        <Send className="size-4" />
      </Button>
    </div>
  )
}
