import * as React from 'react'
import { ensureAgentRuntimesForSession } from '@/lib/teamclaw/ensure-agent-runtime'
import type { EngagedAgentUiEntry } from '@/hooks/use-engaged-agent-ui-states'

/** Agents whose pill is not ready — runtimeStart can help (not stale rebind). */
export function agentIdsNeedingRuntimeWake(
  entries: ReadonlyArray<EngagedAgentUiEntry>,
): string[] {
  return entries
    .filter((e) => e.uiState === 'connecting' || e.uiState === 'offline')
    .map((e) => e.agent.id)
}

const FOCUS_ENSURE_MIN_INTERVAL_MS = 3_000

export function useEnsureEngagedRuntimesOnSessionFocus(args: {
  sessionId: string | null
  teamId: string | null
  engagedUiEntries: ReadonlyArray<EngagedAgentUiEntry>
}): void {
  const prevSessionIdRef = React.useRef<string | null>(null)
  const lastEnsureRef = React.useRef<{ key: string; at: number } | null>(null)

  const engagedSignature = React.useMemo(
    () =>
      args.engagedUiEntries
        .map((e) => `${e.agent.id}:${e.uiState}`)
        .sort()
        .join('|'),
    [args.engagedUiEntries],
  )

  React.useEffect(() => {
    const sessionId = args.sessionId?.trim() || null
    const teamId = args.teamId?.trim() || null
    const focusChanged = prevSessionIdRef.current !== sessionId
    prevSessionIdRef.current = sessionId

    if (!focusChanged || !sessionId || !teamId) return

    const agentActorIds = agentIdsNeedingRuntimeWake(args.engagedUiEntries)
    if (agentActorIds.length === 0) return

    const key = `${sessionId}::${agentActorIds.slice().sort().join(',')}`
    const now = Date.now()
    const last = lastEnsureRef.current
    if (last && last.key === key && now - last.at < FOCUS_ENSURE_MIN_INTERVAL_MS) {
      return
    }
    lastEnsureRef.current = { key, at: now }

    void ensureAgentRuntimesForSession({
      sessionId,
      teamId,
      agentActorIds,
      reason: 'session_focus',
    })
  }, [args.sessionId, args.teamId, engagedSignature, args.engagedUiEntries])
}
