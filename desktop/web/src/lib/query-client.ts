import { QueryClient } from '@tanstack/react-query'

/** 共享 QueryClient 单例（router providers 注入）。 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5 * 1000,
    },
  },
})
