// packages/app/src/stores/team-members.ts
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type { TeamMember } from '../lib/git/types'
import { useWorkspaceStore } from './workspace'

type MemberRole = 'owner' | 'manager' | 'editor' | 'viewer'

interface TeamMembersState {
  members: TeamMember[]
  myRole: MemberRole | null
  loading: boolean
  error: string | null
  /** This device ID, loaded once and shared across components. */
  currentNodeId: string | null

  loadMembers: () => Promise<void>
  loadMyRole: () => Promise<void>
  loadCurrentNodeId: () => Promise<void>
  addMember: (member: TeamMember) => Promise<void>
  removeMember: (nodeId: string) => Promise<void>
  updateMemberRole: (nodeId: string, role: MemberRole) => Promise<void>
  canManageMembers: () => boolean
  reset: () => void
}

function getWorkspaceArgs() {
  const workspacePath = useWorkspaceStore.getState().workspacePath
  return workspacePath ? { workspacePath } : {}
}

export const useTeamMembersStore = create<TeamMembersState>((set, get) => ({
  members: [],
  myRole: null,
  loading: false,
  error: null,
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

  loadMembers: async () => {
    set({ loading: true, error: null })
    try {
      const members = await invoke<TeamMember[]>('unified_team_get_members', getWorkspaceArgs())
      set({ members, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  loadMyRole: async () => {
    try {
      const role = await invoke<MemberRole | null>('unified_team_get_my_role', getWorkspaceArgs())
      set({ myRole: role })
    } catch {
      set({ myRole: null })
    }
  },

  addMember: async (member: TeamMember) => {
    set({ error: null })
    try {
      await invoke('unified_team_add_member', { member, ...getWorkspaceArgs() })
      await get().loadMembers()
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  removeMember: async (nodeId: string) => {
    set({ error: null })
    try {
      await invoke('unified_team_remove_member', { nodeId, ...getWorkspaceArgs() })
      await get().loadMembers()
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  updateMemberRole: async (nodeId: string, role: MemberRole) => {
    set({ error: null })
    try {
      await invoke('unified_team_update_member_role', { nodeId, role, ...getWorkspaceArgs() })
      await get().loadMembers()
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  canManageMembers: () => {
    const { myRole } = get()
    return myRole === 'owner' || myRole === 'manager'
  },

  reset: () => {
    set({
      members: [],
      myRole: null,
      loading: false,
      error: null,
      currentNodeId: null,
    })
  },
}))
