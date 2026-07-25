// fe-steward-chat：中栏管家对话窗口（消息列表 + 输入框）。
//
// 与主 Agent（管家）多模态交互：按 ContentBlock.type 渲染产出——
// md(text)/code/png/svg 首版先行；html/xml 后续。管家在此接收需求、汇报安排。
//
// 依赖 /api/steward/messages（GET 历史 + POST 发送），后端未就绪时前端可 mock。
// 依赖 fork-yonder-shell（@ymesh/ui + AppShell 已就位）。

import { useMessages, useSendMessage } from './use-steward'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'

export function StewardChat() {
  const { data: messages, isLoading, error } = useMessages()
  const sendMut = useSendMessage()

  return (
    <div data-testid="steward-chat" className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0">
        <MessageList messages={messages} isLoading={isLoading} error={error} />
      </div>
      <ChatInput onSend={(text) => sendMut.mutate({ text })} sending={sendMut.isPending} />
    </div>
  )
}
