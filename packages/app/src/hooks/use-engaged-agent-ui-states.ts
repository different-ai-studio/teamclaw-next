import * as React from 'react'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'
import { resolveAgentAvailableModels } from '@/lib/agent-available-models'
import { resolveRuntimeStateEntryForAgent } from '@/lib/runtime-state-resolve'
import {
  SESSION_AGENT_CONNECTING_TIMEOUT_MS,
  resolveSessionAgentUiState,
  type SessionAgentUiState,
} from '@/lib/session-agent-ui-state'
import { isSupersededLocalAgent, noteLocalDaemonActorId } from '@/lib/local-daemon-identity'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { useRuntimeStateStore, type RuntimeStateEntry } from '@/stores/runtime-state-store'
import { getLocalDaemonActorId } from '@/lib/daemon-agent-admin'

export type EngagedAgentUiEntry = {
  agent: AttachedAgent
  uiState: SessionAgentUiState
}

function resolveStaleBinding(agentId: string): boolean {
  return isSupersededLocalAgent(agentId)
}

function computeProvisionalState(
  agent: AttachedAgent,
  agentToRuntimeId: Map<string, string>,
  byRuntimeId: Record<string, RuntimeStateEntry>,
  presenceByActor: Record<string, { online: boolean } | undefined>,
  connectingSinceByAgent: Record<string, number>,
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

  let state = resolveSessionAgentUiState({
    presenceOnline,
    runtimeInfo,
    availableModelCount,
    isStaleBinding: resolveStaleBinding(agent.id),
    connectingTimedOut: false,
  })

  if (state === 'connecting' && connectingTimedOut) {
    state = resolveSessionAgentUiState({
      presenceOnline,
      runtimeInfo,
      availableModelCount,
      isStaleBinding: resolveStaleBinding(agent.id),
      connectingTimedOut: true,
    })
  }
  return state
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
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    byRuntimeId,
    agentToRuntimeId,
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
        now,
      ),
    }))
  }, [
    engagedAgents,
    engagedSignature,
    runtimeMapSignature,
    presenceSignature,
    connectingSinceByAgent,
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
