// fe-board：useTasks hook（react-query 包 fetchTasks）。

import { useQuery } from '@tanstack/react-query'
import { fetchTasks } from './api'

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: ({ signal }) => fetchTasks(signal),
    staleTime: 10 * 1000,
  })
}
