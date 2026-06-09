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
/** Retry while pill stays connecting/offline on the same session (idle runtime drop). */
const STALE_RUNTIME_RETRY_MS = 15_000

export function useEnsureEngagedRuntimesOnSessionFocus(args: {
  sessionId: string | null
  teamId: string | null
  engagedUiEntries: ReadonlyArray<EngagedAgentUiEntry>
}): void {
  const prevSessionIdRef = React.useRef<string | null>(null)
  const lastEnsureRef = React.useRef<{ key: string; at: number } | null>(null)
  const engagedUiEntriesRef = React.useRef(args.engagedUiEntries)
  engagedUiEntriesRef.current = args.engagedUiEntries

  const engagedSignature = React.useMemo(
    () =>
      args.engagedUiEntries
        .map((e) => `${e.agent.id}:${e.uiState}`)
        .sort()
        .join('|'),
    [args.engagedUiEntries],
  )

  const tryEnsure = React.useCallback(
    (reason: string, opts?: { bypassThrottle?: boolean }) => {
      const sessionId = args.sessionId?.trim() || null
      const teamId = args.teamId?.trim() || null
      if (!sessionId || !teamId) return

      const agentActorIds = agentIdsNeedingRuntimeWake(engagedUiEntriesRef.current)
      if (agentActorIds.length === 0) return

      const key = `${sessionId}::${agentActorIds.slice().sort().join(',')}`
      const now = Date.now()
      const last = lastEnsureRef.current
      if (
        !opts?.bypassThrottle &&
        last &&
        last.key === key &&
        now - last.at < FOCUS_ENSURE_MIN_INTERVAL_MS
      ) {
        return
      }
      lastEnsureRef.current = { key, at: now }

      void ensureAgentRuntimesForSession({
        sessionId,
        teamId,
        agentActorIds,
        reason,
      })
    },
    [args.sessionId, args.teamId],
  )

  React.useEffect(() => {
    const sessionId = args.sessionId?.trim() || null
    const focusChanged = prevSessionIdRef.current !== sessionId
    if (focusChanged) {
      lastEnsureRef.current = null
    }
    prevSessionIdRef.current = sessionId

    if (!sessionId || !args.teamId?.trim()) return

    tryEnsure(focusChanged ? 'session_focus' : 'session_runtime_wake')
  }, [args.sessionId, args.teamId, engagedSignature, tryEnsure])

  React.useEffect(() => {
    const sessionId = args.sessionId?.trim() || null
    const teamId = args.teamId?.trim() || null
    if (!sessionId || !teamId) return
    if (agentIdsNeedingRuntimeWake(args.engagedUiEntries).length === 0) return

    const timer = window.setInterval(() => {
      tryEnsure('session_runtime_retry')
    }, STALE_RUNTIME_RETRY_MS)

    return () => window.clearInterval(timer)
  }, [args.sessionId, args.teamId, engagedSignature, args.engagedUiEntries, tryEnsure])
}
