// fe-topbar：react-query hooks。

import { useQuery } from '@tanstack/react-query'
import { fetchTopBarState } from './api'

export function useTopBarState() {
  return useQuery({
    queryKey: ['topbar', 'state'],
    queryFn: ({ signal }) => fetchTopBarState(signal),
    staleTime: 10 * 1000,
  })
}
