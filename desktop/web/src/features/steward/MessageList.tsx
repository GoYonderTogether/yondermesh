// fe-steward-chat：消息列表（滚动容器 + 空态 + 加载/错误态）。

import { ScrollArea } from '@ymesh/ui'
import { Loader2 } from 'lucide-react'
import type { Message } from './types'
import { MessageItem } from './MessageItem'

export interface MessageListProps {
  messages?: Message[]
  isLoading?: boolean
  error?: Error | null
}

export function MessageList({ messages, isLoading, error }: MessageListProps) {
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span className="ml-2 text-sm">加载对话…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <div>
          <p className="text-sm text-destructive">加载失败</p>
          <p className="mt-1 text-xs text-muted-foreground">{String(error.message)}</p>
        </div>
      </div>
    )
  }

  if (!messages || messages.length === 0) {
    return (
      <div
        data-testid="messages-empty"
        className="flex h-full items-center justify-center p-6 text-center"
      >
        <div>
          <p className="text-sm text-muted-foreground">和管家说点什么吧</p>
          <p className="mt-1 text-xs text-text-tertiary">管家会替你拆解任务并派发</p>
        </div>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div data-testid="message-list" className="flex flex-col">
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
      </div>
    </ScrollArea>
  )
}
