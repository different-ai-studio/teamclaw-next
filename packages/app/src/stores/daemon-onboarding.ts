import { create } from 'zustand'
import { isTauri } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { probeDaemonHttp, invalidateDaemonConnection } from '@/lib/daemon-local-client'

// 'unknown'        — no current team yet (don't block)
// 'needs-onboard'  — daemon not bound to any team -> interactive wizard
// 'mismatch'       — daemon bound to a different team -> force reset wizard
// 'starting'       — onboarded to this team but daemon down/token-stale -> auto-recovering
// 'ready'          — onboarded to this team, running, token valid
// 'error'          — auto-recovery failed -> show retry
export type OnboardingStatus = 'unknown' | 'needs-onboard' | 'mismatch' | 'starting' | 'ready' | 'error'
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
    // Short TTL: this invite is claimed immediately by `amuxd init`; a tight
    // window avoids leaving orphan agent invites if init fails.
    ttlSeconds: 600,
    targetActorId,
  })
  const inviteUrl = `teamclaw://invite?token=${encodeURIComponent(invite.token)}`
  const result = await invoke<{ actorId: string; teamId: string }>('daemon_init', { inviteUrl })
  await invoke('daemon_install_service')
  return result.actorId
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The daemon is onboarded to the current team — ensure it's actually running with a
 * valid token. Auto-recover (start/restart) and poll until healthy. Returns true if ready. */
async function ensureHealthy(): Promise<boolean> {
  let probe = await probeDaemonHttp()
  if (probe.ok) return true
  // not_running / port_file_missing / token_invalid all recover the same way:
  // (re)register + (re)start the service (install-service kickstarts an already-loaded
  // job, so a stale token gets rewritten). Then poll — the daemon needs a moment to
  // bind its port and write fresh ~/.amuxd/amuxd.http.{port,token}.
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    await invoke('daemon_install_service')
  } catch {
    /* fall through to polling; surfacing the probe failure is more useful */
  }
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    invalidateDaemonConnection()
    probe = await probeDaemonHttp()
    if (probe.ok) return true
  }
  return false
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
    const base = computeOnboardingStatus(dTeam, currentTeamId)
    if (base !== 'ready') {
      // unknown / needs-onboard / mismatch — team-level, handled by the wizard.
      set({ status: base, loaded: true })
      return
    }
    // Onboarded to the current team: also verify running + token valid, auto-recover.
    const first = await probeDaemonHttp()
    if (first.ok) {
      set({ status: 'ready', loaded: true })
      return
    }
    set({ status: 'starting', loaded: true, error: null })
    const ok = await ensureHealthy()
    set({
      status: ok ? 'ready' : 'error',
      loaded: true,
      error: ok ? null : 'amuxd 启动失败：请确认本机 amuxd 可运行后重试。',
    })
  },

  loadOwnedAgents: async () => {
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) return
    const rows = await getBackend().actors.listConnectedAgents(teamId)
    set({
      ownedAgents: rows
        .filter((r) => r.is_owner)
        .map((r) => ({
          agentId: r.agent_id ?? r.id,
          displayName: r.display_name ?? '',
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
      // Optimistically clear the mismatch screen while refresh re-resolves.
      set({ status: 'unknown' })
      await get().refresh()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },
}))
