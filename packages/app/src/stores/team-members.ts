// packages/app/src/stores/team-members.ts
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

// Device-identity store. Team roles/members now come from the cloud team
// (useCurrentTeamStore + useTeamPermissions); the legacy git-manifest member
// system was removed. This store only tracks the local device node id, used by
// shared-secrets / env-vars for per-device operations.
interface DeviceIdentityState {
  /** This device's node id, loaded once and shared across components. */
  currentNodeId: string | null
  loadCurrentNodeId: () => Promise<void>
  reset: () => void
}

export const useTeamMembersStore = create<DeviceIdentityState>((set, get) => ({
  currentNodeId: null,

  loadCurrentNodeId: async () => {
    if (get().currentNodeId) return
    try {
      const info = await invoke<{ nodeId: string }>('get_device_info')
      set({ currentNodeId: info.nodeId })
    } catch {
      // Device identity can be unavailable during early startup; retry next call.
    }
  },

  reset: () => set({ currentNodeId: null }),
}))
