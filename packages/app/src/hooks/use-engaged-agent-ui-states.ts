import * as React from 'react'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import { resolveAgentAvailableModels } from '@/lib/agent-available-models'
import {
  probeAgentReachability,
  type AgentReachability,
} from '@/lib/agent-reachability-probe'
import { resolveRuntimeStateEntryForAgent } from '@/lib/runtime-state-resolve'
import {
  SESSION_AGENT_CONNECTING_TIMEOUT_MS,
  isDriftedLocalGhostBinding,
  resolveSessionAgentUiState,
  type SessionAgentUiState,
} from '@/lib/session-agent-ui-state'
import {
  getKnownLocalDaemonActorId,
  isSupersededLocalAgent,
  noteLocalDaemonActorId,
} from '@/lib/local-daemon-identity'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { useRuntimeStateStore, type RuntimeStateEntry } from '@/stores/runtime-state-store'
import { getLocalDaemonActorId } from '@/lib/daemon-agent-admin'

export type EngagedAgentUiEntry = {
  agent: AttachedAgent
  uiState: SessionAgentUiState
}

const PROBE_RETRY_MS = 30_000

function resolveStaleBinding(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
): boolean {
  if (isSupersededLocalAgent(agent.id)) return true
  const localId = getKnownLocalDaemonActorId()
  const dbRuntimeId = agentToRuntimeId.get(agent.id)
  const agentEntry = resolveRuntimeStateEntryForAgent(agent.id, byRuntimeId, dbRuntimeId)
  const localEntry = localId
    ? resolveRuntimeStateEntryForAgent(localId, byRuntimeId)
    : undefined
  return isDriftedLocalGhostBinding({
    agentId: agent.id,
    localDaemonActorId: localId,
    presenceOnline: presenceByActor[agent.id]?.online,
    agentRuntimeInfo: agentEntry?.info,
    agentAvailableModelCount: resolveAgentAvailableModels(agentEntry?.info).length,
    localRuntimeInfo: localEntry?.info,
    localAvailableModelCount: resolveAgentAvailableModels(localEntry?.info).length,
  })
}

function computeProvisionalState(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
  connectingSinceByAgent: Record<string, number>,
  reachabilityByAgent: Record<string, AgentReachability>,
  now: number,
): SessionAgentUiState {
  const dbRuntimeId = agentToRuntimeId.get(agent.id)
  const entry = resolveRuntimeStateEntryForAgent(agent.id, byRuntimeId, dbRuntimeId)
  const runtimeInfo = entry?.info
  const availableModelCount = resolveAgentAvailableModels(runtimeInfo).length
  const presenceOnline = presenceByActor[agent.id]?.online
  const since = connectingSinceByAgent[agent.id]
  const connectingTimedOut =
    since !== undefined && now - since >= SESSION_AGENT_CONNECTING_TIMEOUT_MS
  const reachability = reachabilityByAgent[agent.id]
  const reachabilityFailed = reachability === 'unreachable'

  return resolveSessionAgentUiState({
    presenceOnline,
    runtimeInfo,
    availableModelCount,
    isStaleBinding: resolveStaleBinding(agent, agentToRuntimeId, byRuntimeId, presenceByActor),
    connectingTimedOut,
    reachabilityFailed,
  })
}

function shouldProbeAgent(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
  connectingSinceByAgent: Record<string, number>,
  reachabilityByAgent: Record<string, AgentReachability>,
  lastProbeAtByAgent: Record<string, number>,
  now: number,
): boolean {
  if (isSupersededLocalAgent(agent.id)) return false

  const state = computeProvisionalState(
    agent,
    agentToRuntimeId,
    byRuntimeId,
    presenceByActor,
    connectingSinceByAgent,
    reachabilityByAgent,
    now,
  )
  if (state === 'ready' || state === 'stale') return false

  const reachability = reachabilityByAgent[agent.id]
  if (reachability === 'pending') return false
  if (reachability === 'reachable') return false
  if (reachability === 'unreachable') {
    const lastProbeAt = lastProbeAtByAgent[agent.id] ?? 0
    return now - lastProbeAt >= PROBE_RETRY_MS
  }

  if (state === 'connecting') return true
  if (state === 'offline' && presenceByActor[agent.id]?.online === true) return true
  return false
}

export function useEngagedAgentUiStates(
  engagedAgents: AttachedAgent[],
  agentToRuntimeId: Map<string, string>,
): EngagedAgentUiEntry[] {
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId)
  const presenceByActor = useActorPresenceStore((s) => s.byActorId)
  const [connectingSinceByAgent, setConnectingSinceByAgent] = React.useState<
    Record<string, number>
  >({})
  const [reachabilityByAgent, setReachabilityByAgent] = React.useState<
    Record<string, AgentReachability>
  >({})
  const lastProbeAtByAgentRef = React.useRef<Record<string, number>>({})
  const [, tick] = React.useReducer((x: number) => x + 1, 0)

  React.useEffect(() => {
    let cancelled = false
    const load = async () => {
      const id = await getLocalDaemonActorId()
      if (cancelled) return
      noteLocalDaemonActorId(id)
    }
    void load()
    const interval = setInterval(() => void load(), 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  React.useEffect(() => {
    const interval = setInterval(() => tick(), 1_000)
    return () => clearInterval(interval)
  }, [])

  const engagedSignature = React.useMemo(
    () =>
      engagedAgents
        .map((a) => a.id)
        .sort()
        .join(','),
    [engagedAgents],
  )
  const runtimeMapSignature = React.useMemo(
    () =>
      [...agentToRuntimeId.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([agentId, runtimeId]) => `${agentId}:${runtimeId}`)
        .join('|'),
    [agentToRuntimeId],
  )

  const presenceSignature = React.useMemo(
    () =>
      engagedAgents
        .map((a) => `${a.id}:${presenceByActor[a.id]?.online ?? 'u'}`)
        .sort()
        .join('|'),
    [engagedAgents, presenceByActor],
  )

  React.useEffect(() => {
    const now = Date.now()
    const activeIds = new Set(engagedAgents.map((a) => a.id))
    setConnectingSinceByAgent((prev) => {
      const next: Record<string, number> = {}
      let changed = false

      for (const agent of engagedAgents) {
        const provisional = computeProvisionalState(
          agent,
          agentToRuntimeId,
          byRuntimeId,
          presenceByActor,
          prev,
          reachabilityByAgent,
          now,
        )
        if (provisional === 'connecting') {
          next[agent.id] = prev[agent.id] ?? now
          if (prev[agent.id] !== next[agent.id]) changed = true
        }
      }

      for (const id of Object.keys(prev)) {
        if (!activeIds.has(id)) changed = true
      }

      if (!changed && Object.keys(prev).length === Object.keys(next).length) {
        let same = true
        for (const [id, since] of Object.entries(next)) {
          if (prev[id] !== since) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })

    setReachabilityByAgent((prev) => {
      const next: Record<string, AgentReachability> = {}
      let changed = false
      for (const agent of engagedAgents) {
        const state = computeProvisionalState(
          agent,
          agentToRuntimeId,
          byRuntimeId,
          presenceByActor,
          connectingSinceByAgent,
          prev,
          now,
        )
        if (state === 'ready') {
          next[agent.id] = 'reachable'
          if (prev[agent.id] !== 'reachable') changed = true
          continue
        }
        if (prev[agent.id]) {
          next[agent.id] = prev[agent.id]
        }
      }
      for (const id of Object.keys(prev)) {
        if (!activeIds.has(id)) changed = true
      }
      if (!changed && Object.keys(prev).length === Object.keys(next).length) {
        let same = true
        for (const [id, value] of Object.entries(next)) {
          if (prev[id] !== value) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    byRuntimeId,
    agentToRuntimeId,
    reachabilityByAgent,
    connectingSinceByAgent,
  ])

  React.useEffect(() => {
    let cancelled = false
    const now = Date.now()
    const localDaemonActorId = getKnownLocalDaemonActorId()

    for (const agent of engagedAgents) {
      if (
        !shouldProbeAgent(
          agent,
          agentToRuntimeId,
          byRuntimeId,
          presenceByActor,
          connectingSinceByAgent,
          reachabilityByAgent,
          lastProbeAtByAgentRef.current,
          now,
        )
      ) {
        continue
      }

      setReachabilityByAgent((prev) => {
        if (prev[agent.id] === 'pending') return prev
        return { ...prev, [agent.id]: 'pending' }
      })
      lastProbeAtByAgentRef.current[agent.id] = now

      void probeAgentReachability({
        agentActorId: agent.id,
        localDaemonActorId,
      }).then((result) => {
        if (cancelled) return
        setReachabilityByAgent((prev) => ({
          ...prev,
          [agent.id]: result,
        }))
      })
    }

    return () => {
      cancelled = true
    }
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    byRuntimeId,
    agentToRuntimeId,
    connectingSinceByAgent,
    reachabilityByAgent,
    tick,
  ])

  return React.useMemo(() => {
    const now = Date.now()
    return engagedAgents.map((agent) => ({
      agent,
      uiState: computeProvisionalState(
        agent,
        agentToRuntimeId,
        byRuntimeId,
        presenceByActor,
        connectingSinceByAgent,
        reachabilityByAgent,
        now,
      ),
    }))
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    connectingSinceByAgent,
    reachabilityByAgent,
    byRuntimeId,
    agentToRuntimeId,
    tick,
  ])
}

export function countNonReadyEngaged(entries: EngagedAgentUiEntry[]): number {
  return entries.filter((e) => e.uiState !== 'ready').length
}

export function allEngagedNonReady(entries: EngagedAgentUiEntry[]): boolean {
  return entries.length > 0 && entries.every((e) => e.uiState !== 'ready')
}
