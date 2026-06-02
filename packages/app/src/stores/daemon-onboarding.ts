import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'

export type OnboardingStatus = 'unknown' | 'needs-onboard' | 'mismatch' | 'ready'
export type Visibility = 'team' | 'personal'

export type OwnedAgent = { agentId: string; displayName: string; visibility: string }

/** Pure status from daemon-bound teamId vs the logged-in current teamId. */
export function computeOnboardingStatus(
  daemonTeamId: string | null,
  currentTeamId: string | null,
): OnboardingStatus {
  if (!currentTeamId) return 'unknown'
  if (!daemonTeamId) return 'needs-onboard'
  return daemonTeamId === currentTeamId ? 'ready' : 'mismatch'
}

type DaemonOnboardingState = {
  status: OnboardingStatus
  loaded: boolean
  busy: boolean
  error: string | null
  ownedAgents: OwnedAgent[]
  refresh: () => Promise<void>
  loadOwnedAgents: () => Promise<void>
  createNewAgent: (name: string, visibility: Visibility) => Promise<void>
  bindExistingAgent: (agentId: string, displayName: string) => Promise<void>
  forceReset: () => Promise<void>
}

async function daemonTeamId(): Promise<string | null> {
  if (!isTauri()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return (await invoke<string | null>('get_daemon_team_id')) ?? null
}

/** Run create-invite → amuxd init → install-service. Returns the claimed agentId. */
async function onboard(teamId: string, displayName: string, targetActorId: string | null): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core')
  const invite = await getBackend().teams.createTeamInvite({
    teamId,
    kind: 'agent',
    displayName,
    agentKind: 'claude',
    ttlSeconds: null,
    targetActorId,
  })
  const inviteUrl = `teamclaw://invite?token=${encodeURIComponent(invite.token)}`
  const result = await invoke<{ actorId: string; teamId: string }>('daemon_init', { inviteUrl })
  await invoke('daemon_install_service')
  return result.actorId
}

export const useDaemonOnboardingStore = create<DaemonOnboardingState>((set, get) => ({
  status: 'unknown',
  loaded: false,
  busy: false,
  error: null,
  ownedAgents: [],

  refresh: async () => {
    if (!isTauri()) {
      set({ status: 'ready', loaded: true })
      return
    }
    const currentTeamId = useCurrentTeamStore.getState().team?.id ?? null
    const dTeam = await daemonTeamId()
    set({ status: computeOnboardingStatus(dTeam, currentTeamId), loaded: true })
  },

  loadOwnedAgents: async () => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) return
    const rows = await getBackend().actors.listConnectedAgents(teamId)
    set({
      ownedAgents: rows
        .filter((r: any) => r.isOwner ?? r.is_owner)
        .map((r: any) => ({
          agentId: r.agentId ?? r.agent_id ?? r.id,
          displayName: r.displayName ?? r.display_name ?? '',
          visibility: r.visibility ?? 'team',
        })),
    })
  },

  createNewAgent: async (name, visibility) => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) { set({ error: 'no current team' }); return }
    set({ busy: true, error: null })
    try {
      const agentId = await onboard(teamId, name, null)
      if (visibility === 'personal') {
        await getBackend().actors.makeAgentPersonal(agentId)
      }
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  bindExistingAgent: async (agentId, displayName) => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) { set({ error: 'no current team' }); return }
    set({ busy: true, error: null })
    try {
      await onboard(teamId, displayName, agentId)
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  forceReset: async () => {
    if (!isTauri()) return
    set({ busy: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('daemon_clear')
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },
}))
