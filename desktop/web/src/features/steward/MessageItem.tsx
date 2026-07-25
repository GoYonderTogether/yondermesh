// fe-steward-chat：单条消息渲染（角色头像 + 内容块列表）。

import { Avatar, AvatarFallback, cn } from '@ymesh/ui'
import type { Message } from './types'
import { ROLE_LABEL } from './types'
import { MultimodalContent } from './MultimodalContent'

const ROLE_AVATAR: Record<Message['role'], string> = {
  user: '我',
  assistant: '管',
  system: '系',
}

const ROLE_AVATAR_CLASS: Record<Message['role'], string> = {
  user: 'bg-secondary text-secondary-foreground',
  assistant: 'bg-primary text-primary-foreground',
  system: 'bg-muted text-muted-foreground',
}

export function MessageItem({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  return (
    <div
      data-testid="message-item"
      data-role={message.role}
      data-message-id={message.id}
      className={cn(
        'flex gap-3 px-4 py-3',
        isUser && 'flex-row-reverse',
      )}
    >
      <Avatar className="size-8 shrink-0">
        <AvatarFallback
          className={cn('text-xs font-medium', ROLE_AVATAR_CLASS[message.role])}
        >
          {ROLE_AVATAR[message.role]}
        </AvatarFallback>
      </Avatar>
      <div
        className={cn(
          'flex min-w-0 max-w-[calc(100%-3rem)] flex-col gap-2',
          isUser && 'items-end',
        )}
      >
        <div className="flex items-center gap-2">
          <span data-testid="message-role" className="text-xs font-medium text-text-secondary">
            {ROLE_LABEL[message.role]}
          </span>
        </div>
        <div
          className={cn(
            'flex flex-col gap-2',
            isUser ? 'items-end' : 'items-start',
          )}
        >
          {message.contents.map((block, i) => (
            <MultimodalContent key={i} block={block} />
          ))}
        </div>
      </div>
    </div>
  )
}
