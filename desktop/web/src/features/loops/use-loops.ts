// fe-loops-dashboard：loop 看板 hooks（react-query）。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchLoop, fetchLoops, saveLoop, scanLoop, type SaveLoopInput } from './api'

export function useLoops() {
  return useQuery({ queryKey: ['loops'], queryFn: ({ signal }) => fetchLoops(signal), staleTime: 5 * 1000 })
}

export function useLoop(id: string | null) {
  return useQuery({
    queryKey: ['loop', id],
    queryFn: ({ signal }) => fetchLoop(id!, signal),
    enabled: !!id,
  })
}

export function useSaveLoop() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SaveLoopInput) => saveLoop(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loops'] })
    },
  })
}

export function useScanLoop() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => scanLoop(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loops'] })
    },
  })
}
