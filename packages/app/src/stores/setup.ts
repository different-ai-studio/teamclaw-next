import { create } from 'zustand'
import { isTauri } from '@/lib/utils'

export type RequirementStatus = {
  id: string
  title: string
  optional: boolean
  present: boolean
  version: string | null
}

export type SetupProgress = {
  id: string
  status: 'started' | 'running' | 'done' | 'failed'
  line: string | null
  error: string | null
}

type SetupState = {
  requirements: RequirementStatus[]
  installing: string | null
  output: Record<string, string[]>
  errors: Record<string, string>
  loaded: boolean
  listRequirements: () => Promise<void>
  install: (id: string) => Promise<void>
  requiredSatisfied: () => boolean
}

export const useSetupStore = create<SetupState>((set, get) => ({
  requirements: [],
  installing: null,
  output: {},
  errors: {},
  loaded: false,

  requiredSatisfied: () =>
    get().requirements.filter((r) => !r.optional).every((r) => r.present),

  listRequirements: async () => {
    if (!isTauri()) {
      set({ loaded: true })
      return
    }
    const { invoke } = await import('@tauri-apps/api/core')
    const requirements = await invoke<RequirementStatus[]>('setup_list_requirements')
    set({ requirements, loaded: true })
  },

  install: async (id: string) => {
    if (!isTauri()) return
    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')
    set({ installing: id })
    const unlisten = await listen<SetupProgress>('setup-progress', (event) => {
      applyProgress(event.payload)
    })
    try {
      await invoke('setup_install', { id })
      const requirements = await invoke<RequirementStatus[]>('setup_list_requirements')
      set({ requirements })
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [id]: String(e) } }))
    } finally {
      unlisten()
      set({ installing: null })
    }
  },
}))

/** Pure reducer applied to each setup-progress event (exported for tests). */
export function applyProgress(p: SetupProgress) {
  useSetupStore.setState((s) => {
    const output = { ...s.output }
    const errors = { ...s.errors }
    let requirements = s.requirements

    if (p.status === 'running' && p.line) {
      output[p.id] = [...(output[p.id] ?? []), p.line]
    }
    if (p.status === 'failed' && p.error) {
      errors[p.id] = p.error
    }
    if (p.status === 'done') {
      requirements = requirements.map((r) => (r.id === p.id ? { ...r, present: true } : r))
    }
    return { output, errors, requirements }
  })
}
