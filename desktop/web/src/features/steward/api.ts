// fe-steward-chat：管家对话窗口 API 层。
//
// 对接 /api/steward/messages（GET 历史 + POST 发送）。后端未就绪时前端可 mock。
// 首版只做 fetch + 类型化，不做轮询/流式。

import type { Message, SendMessageInput } from './types'

const ENDPOINT = '/api/steward/messages'

/** 拉取对话历史。 */
export async function fetchMessages(signal?: AbortSignal): Promise<Message[]> {
  const res = await fetch(ENDPOINT, { signal })
  if (!res.ok) throw new Error(`fetchMessages: ${res.status}`)
  const data = (await res.json()) as { messages?: Message[] } | Message[]
  return Array.isArray(data) ? data : (data.messages ?? [])
}

/** 发送一条用户消息，返回新增的消息（含 assistant 回复，若有）。 */
export async function sendMessage(input: SendMessageInput): Promise<Message> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`sendMessage: ${res.status}`)
  return (await res.json()) as Message
}
