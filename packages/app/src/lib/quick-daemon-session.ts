import { getLocalDaemonAgent } from '@/lib/daemon-agent-admin'
import { resolveCurrentMemberActorId } from '@/lib/current-actor'
import { createSessionShell } from '@/lib/session-create'
import { ensureSessionLiveSubscribed } from '@/lib/session-live-subscriptions'
import { useAuthStore } from '@/stores/auth-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useEngagedAgentStore } from '@/stores/engaged-agent-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionStore } from '@/stores/session'
import { useUIStore } from '@/stores/ui'

export type QuickDaemonSessionResult = {
  sessionId: string
  agentDisplayName: string
}

function soloAgentTitle(displayName: string): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const now = new Date()
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return `${displayName} (${hhmm})`
}

/**
 * One-click session: current member + local amuxd agent, no opening message.
 * Returns null when team/auth/member/agent prerequisites are missing.
 */
export async function createQuickDaemonSession(): Promise<QuickDaemonSessionResult | null> {
  const teamId = useCurrentTeamStore.getState().team?.id ?? null
  const currentMemberId = useCurrentTeamStore.getState().currentMember?.id ?? null
  const authUserId = useAuthStore.getState().session?.user?.id ?? null
  if (!teamId || !authUserId) return null

  const agent = await getLocalDaemonAgent(teamId)
  if (!agent?.id) return null

  const creatorActorId = await resolveCurrentMemberActorId(teamId, authUserId, {
    currentTeamId: teamId,
    currentMemberId,
  })
  if (!creatorActorId) return null

  const displayName = agent.displayName || agent.id
  const draftIdeaId = useUIStore.getState().draftIdeaId ?? null
  const { sessionId } = await createSessionShell({
    teamId,
    creatorActorId,
    title: soloAgentTitle(displayName),
    additionalActorIds: [agent.id],
    ideaId: draftIdeaId,
  })

  if (draftIdeaId) {
    useUIStore.getState().clearDraftIdeaId()
  }

  await ensureSessionLiveSubscribed(teamId, sessionId).catch((e) => {
    console.warn('[createQuickDaemonSession] live subscribe failed (non-fatal):', e)
  })

  useEngagedAgentStore.getState().setAgents(sessionId, [
    { id: agent.id, displayName },
  ])

  await useSessionListStore.getState().load()
  useSessionStore.getState().addHighlightedSession(sessionId)
  await useUIStore.getState().switchToSession(sessionId)
  useUIStore.getState().requestComposerFocus()

  void import('@/lib/teamclaw/ensure-agent-runtime').then(({ ensureAgentRuntimesForSession }) => {
    void ensureAgentRuntimesForSession({
      sessionId,
      teamId,
      agentActorIds: [agent.id],
      reason: 'quick_daemon_session',
    })
  })

  return { sessionId, agentDisplayName: displayName }
}
