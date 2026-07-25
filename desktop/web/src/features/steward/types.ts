// fe-steward-chat：管家对话窗口类型。
//
// 多模态消息：每条消息可携带多块内容，按类型渲染（md/code/png/svg 首版先行；
// html/xml 后续扩展）。

export type MessageRole = 'user' | 'assistant' | 'system'

/** 内容块类型。首版：text(md) / code / image-png / image-svg。 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'image-png'; src: string; alt?: string }
  | { type: 'image-svg'; src: string; alt?: string }

export interface Message {
  id: string
  role: MessageRole
  contents: ContentBlock[]
  /** 创建时间（ISO 字符串） */
  createdAt: string
}

/** 发送消息的请求体。 */
export interface SendMessageInput {
  text: string
}

export const ROLE_LABEL: Record<MessageRole, string> = {
  user: '我',
  assistant: '管家',
  system: '系统',
}
