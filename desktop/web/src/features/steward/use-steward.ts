// fe-steward-chat：管家对话窗口 hooks（react-query）。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchMessages, sendMessage } from './api'
import type { SendMessageInput } from './types'

export function useMessages() {
  return useQuery({
    queryKey: ['steward', 'messages'],
    queryFn: ({ signal }) => fetchMessages(signal),
    staleTime: 5 * 1000,
  })
}

export function useSendMessage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SendMessageInput) => sendMessage(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['steward', 'messages'] })
    },
  })
}
