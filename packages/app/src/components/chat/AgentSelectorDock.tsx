import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { getBackend } from '@/lib/backend'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionListStore } from '@/stores/session-list-store'
import { setModel } from '@/lib/teamclaw-rpc'
import { sessionFlowError, sessionFlowLog } from '@/lib/session-flow-log'
import { RuntimeLifecycle, AgentStatus, type RuntimeInfo } from '@/lib/proto/amux_pb'
import {
  backendTypeFromRuntimeEntry,
  agentModelDisplayLabel,
  isAgentModelRowSelected,
  resolveRuntimeIdForAgent,
  resolveRuntimeStateEntryForAgent,
  resolveSetModelId,
  selectAgentModel,
} from '@/lib/runtime-state-resolve'
import { useAgentModelPickStore } from '@/stores/agent-model-pick-store'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { cn } from '@/lib/utils'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface AgentSelectorDockProps {
  /** The session currently displayed by ChatPanel. */
  activeSessionId: string | null
  /** All agents currently @-mentioned for the active session — one pill each. */
  engagedAgents: AttachedAgent[]
  /** Remove a single agent (clicked the X on the chip / "Remove" in dropdown). */
  onRemoveAgent: (agentId: string) => void
}

type AgentModelOption = { id: string; displayName: string }

/** Daemon ACP `RuntimeInfo.available_models` only — no provider store or static fallback. */
export function resolveAgentAvailableModels(
  runtimeInfo: RuntimeInfo | undefined,
): AgentModelOption[] {
  if (!runtimeInfo?.availableModels.length) return []

  const seen = new Set<string>()
  return runtimeInfo.availableModels.filter((model) => {
    const id = model.id?.trim()
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** Gray = waiting for init / unknown. Green = idle. Red = active or errored. */
function dotClasses(info: RuntimeInfo | undefined): { color: string; pulse: boolean } {
  if (!info) return { color: 'bg-muted-foreground/40', pulse: false }
  switch (info.state) {
    case RuntimeLifecycle.FAILED:
      return { color: 'bg-red-500', pulse: false }
    case RuntimeLifecycle.STARTING:
    case RuntimeLifecycle.STOPPED:
    case RuntimeLifecycle.UNKNOWN:
      return { color: 'bg-muted-foreground/40', pulse: false }
    case RuntimeLifecycle.ACTIVE:
      switch (info.status) {
        case AgentStatus.ACTIVE: return { color: 'bg-red-500', pulse: true }
        case AgentStatus.IDLE:   return { color: 'bg-emerald-500', pulse: false }
        case AgentStatus.ERROR:  return { color: 'bg-red-500', pulse: false }
        default:                  return { color: 'bg-muted-foreground/40', pulse: false }
      }
    default:
      return { color: 'bg-muted-foreground/40', pulse: false }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export function AgentSelectorDock({
  activeSessionId,
  engagedAgents,
  onRemoveAgent,
}: AgentSelectorDockProps) {
  const [agentToRuntimeId, setAgentToRuntimeId] = React.useState<Map<string, string>>(new Map())
  const [agentToBackendType, setAgentToBackendType] = React.useState<Map<string, string>>(new Map())
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId)
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const sessionTeamId = useSessionListStore((s) =>
    activeSessionId ? s.rows.find((row) => row.id === activeSessionId)?.team_id ?? null : null,
  )
  const teamId = sessionTeamId ?? currentTeamId
  const engagedAgentIds = React.useMemo(() => engagedAgents.map((agent) => agent.id), [engagedAgents])
  const engagedAgentIdSignature = React.useMemo(() => engagedAgentIds.join(','), [engagedAgentIds])

  // Load agent → runtime mapping for the active session. Refetched whenever
  // a daemon retain arrives for an engaged agent we don't yet know about
  // (covers the race where the daemon's INSERT into agent_runtimes hasn't
  // landed when this component mounts).
  React.useEffect(() => {
    if (!activeSessionId || !teamId || engagedAgentIds.length === 0) {
      setAgentToRuntimeId(new Map())
      setAgentToBackendType(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      let rtRows: Awaited<ReturnType<ReturnType<typeof getBackend>['runtime']['listLatestAgentRuntimeHints']>>
      try {
        rtRows = await getBackend().runtime.listLatestAgentRuntimeHints(teamId, engagedAgentIds)
      } catch (error) {
        sessionFlowError('agent_selector.runtime_map.load_failed', error, {
          sessionId: activeSessionId,
        })
        rtRows = []
      }
      if (cancelled) return
      const map = new Map<string, string>()
      const btMap = new Map<string, string>()
      for (const r of rtRows.filter((row) => row.session_id === activeSessionId)) {
        if (r.agent_id && r.runtime_id && !map.has(r.agent_id)) map.set(r.agent_id, r.runtime_id)
        if (r.agent_id && r.backend_type && !btMap.has(r.agent_id)) btMap.set(r.agent_id, r.backend_type)
      }
      sessionFlowLog('agent_selector.runtime_map.loaded', {
        sessionId: activeSessionId,
        rowCount: rtRows.length,
        runtimeAgentIds: Array.from(map.keys()),
        backendAgentIds: Array.from(btMap.keys()),
      })
      setAgentToRuntimeId(map)
      setAgentToBackendType(btMap)
    })()
    return () => { cancelled = true }
  }, [activeSessionId, teamId, engagedAgentIdSignature])

  // Retain-driven refetch: if any engaged agent has a retain but we haven't
  // mapped its runtime_id yet, re-pull agent_runtimes. Guarded so we only try
  // once per (missing agents, retain snapshot) — agentToRuntimeId must not be
  // in the effect deps or setState retriggers an infinite refetch loop.
  const missingAgentIdSignature = React.useMemo(() => {
    return engagedAgents
      .filter((a) => !agentToRuntimeId.has(a.id))
      .map((a) => a.id)
      .sort()
      .join(',')
  }, [engagedAgents, agentToRuntimeId])

  const retainSignature = React.useMemo(() => {
    const ids = engagedAgents.map((a) => a.id)
    return Object.entries(runtimeStates)
      .filter(([, e]) => ids.includes(e.daemonActorId))
      .map(([rid]) => rid)
      .sort()
      .join(',')
  }, [runtimeStates, engagedAgents])

  const runtimeMapRefetchKeyRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    runtimeMapRefetchKeyRef.current = null
  }, [activeSessionId, engagedAgentIdSignature])

  React.useEffect(() => {
    if (!activeSessionId || !teamId || !missingAgentIdSignature) return
    if (!retainSignature) return

    const refetchKey = `${missingAgentIdSignature}|${retainSignature}`
    if (runtimeMapRefetchKeyRef.current === refetchKey) return
    runtimeMapRefetchKeyRef.current = refetchKey

    let cancelled = false
    void (async () => {
      let rtRows: Awaited<ReturnType<ReturnType<typeof getBackend>['runtime']['listLatestAgentRuntimeHints']>>
      try {
        rtRows = await getBackend().runtime.listLatestAgentRuntimeHints(teamId, engagedAgentIds)
      } catch (error) {
        sessionFlowError('agent_selector.runtime_map.refetch_failed', error, {
          sessionId: activeSessionId,
          retainSignature,
        })
        rtRows = []
      }
      if (cancelled) return

      const sessionRows = rtRows.filter((row) => row.session_id === activeSessionId)
      const mappedAgentIds: string[] = []
      setAgentToRuntimeId((prev) => {
        const next = new Map(prev)
        for (const r of sessionRows) {
          if (r.agent_id && r.runtime_id && !next.has(r.agent_id)) {
            next.set(r.agent_id, r.runtime_id)
            mappedAgentIds.push(r.agent_id)
          }
        }
        return mappedAgentIds.length > 0 ? next : prev
      })
      setAgentToBackendType((prev) => {
        const next = new Map(prev)
        let changed = false
        for (const r of sessionRows) {
          if (r.agent_id && r.backend_type && !next.has(r.agent_id)) {
            next.set(r.agent_id, r.backend_type)
            changed = true
          }
        }
        return changed ? next : prev
      })
      if (mappedAgentIds.length > 0) {
        sessionFlowLog('agent_selector.runtime_map.refetched', {
          sessionId: activeSessionId,
          rowCount: rtRows.length,
          mappedAgentIds,
          missingAgentIds: missingAgentIdSignature.split(','),
          retainSignature,
        })
      }
    })()
    return () => { cancelled = true }
  }, [
    activeSessionId,
    teamId,
    missingAgentIdSignature,
    retainSignature,
    engagedAgentIds,
  ])

  // Backfill backend_type from the agent's most recent historical runtime
  // when we have no live entry yet — mirrors iOS CachedAgentRuntime fallback.
  React.useEffect(() => {
    const missing = engagedAgents.filter((a) => !agentToBackendType.has(a.id))
    if (missing.length === 0 || !teamId) return
    let cancelled = false
    void (async () => {
      let rows: Awaited<ReturnType<ReturnType<typeof getBackend>['runtime']['listLatestAgentRuntimeHints']>>
      try {
        rows = await getBackend().runtime.listLatestAgentRuntimeHints(teamId, missing.map((a) => a.id))
      } catch (error) {
        sessionFlowError('agent_selector.backend_type.backfill_failed', error, {
          sessionId: activeSessionId,
          missingAgentIds: missing.map((a) => a.id),
        })
        rows = []
      }
      if (cancelled) return
      const latestByAgent = new Map<string, string>()
      for (const r of rows) {
        if (r.agent_id && r.backend_type && !latestByAgent.has(r.agent_id)) {
          latestByAgent.set(r.agent_id, r.backend_type)
        }
      }
      if (latestByAgent.size > 0) {
        sessionFlowLog('agent_selector.backend_type.backfilled', {
          sessionId: activeSessionId,
          backendTypesByAgent: Object.fromEntries(latestByAgent),
        })
        setAgentToBackendType((prev) => {
          const next = new Map(prev)
          latestByAgent.forEach((bt, id) => next.set(id, bt))
          return next
        })
      }
    })()
    return () => { cancelled = true }
  }, [engagedAgents, agentToBackendType, teamId, activeSessionId])

  if (engagedAgents.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1">
      {engagedAgents.map((agent) => {
        const dbRuntimeId = agentToRuntimeId.get(agent.id)
        const runtimeEntry = resolveRuntimeStateEntryForAgent(
          agent.id,
          runtimeStates,
          dbRuntimeId,
        )
        const backendType = backendTypeFromRuntimeEntry(
          runtimeEntry,
          agentToBackendType.get(agent.id),
        )
        return (
          <AgentPill
            key={agent.id}
            sessionIdProp={activeSessionId}
            agent={agent}
            dbRuntimeId={dbRuntimeId}
            backendType={backendType}
            runtimeInfo={runtimeEntry?.info}
            onRemove={() => {
              if (activeSessionId) {
                useAgentModelPickStore.getState().clearPick(activeSessionId, agent.id)
              }
              onRemoveAgent(agent.id)
            }}
          />
        )
      })}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Per-agent pill
// ────────────────────────────────────────────────────────────────────────────

function AgentPill({
  sessionIdProp,
  agent,
  dbRuntimeId,
  backendType,
  runtimeInfo,
  onRemove,
}: {
  sessionIdProp: string | null
  agent: AttachedAgent
  dbRuntimeId: string | undefined
  backendType: string | undefined
  runtimeInfo: RuntimeInfo | undefined
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId)
  const sessionId =
    sessionIdProp?.trim() ||
    useSessionSelectionStore.getState().activeSessionId?.trim() ||
    ''

  const liveRuntimeEntry = React.useMemo(
    () => resolveRuntimeStateEntryForAgent(agent.id, byRuntimeId, dbRuntimeId),
    [agent.id, byRuntimeId, dbRuntimeId],
  )
  const liveRuntimeInfo = liveRuntimeEntry?.info ?? runtimeInfo
  const { color: dotColor, pulse } = dotClasses(liveRuntimeInfo)

  const availableModels = React.useMemo(
    () => resolveAgentAvailableModels(liveRuntimeInfo),
    [liveRuntimeInfo],
  )
  const runtimeInfoLoading = availableModels.length === 0
  // Subscribe to the pick entry so explicit user picks immediately drive the
  // pill — selectAgentModel reads the same store but via getState() and would
  // otherwise miss a re-render trigger.
  const pickEntry = useAgentModelPickStore((s) =>
    sessionId ? s.bySessionAgent[`${sessionId}::${agent.id}`] : undefined,
  )
  const selected = React.useMemo(
    () =>
      selectAgentModel({
        sessionId,
        agentId: agent.id,
        available: availableModels,
        byRuntimeId,
      }),
    [
      sessionId,
      agent.id,
      availableModels,
      byRuntimeId,
      // Force recompute when the pick changes — pickEntry is referenced for
      // the dependency hint; selectAgentModel reads from store.getState().
      pickEntry?.modelId,
    ],
  )
  const effectiveModelId = selected.modelId
  const displayedModel =
    availableModels.find((m) => m.id === effectiveModelId)?.displayName ||
    (effectiveModelId
      ? agentModelDisplayLabel(effectiveModelId, availableModels)
      : '') ||
    (runtimeInfoLoading ? '' : availableModels[0]?.displayName || availableModels[0]?.id || '')
  // Pill shows user pick or live retain; list[0] is only a loading placeholder.
  const isPlaceholderModel = selected.source === 'none' && !!displayedModel

  const displayRuntimeId = liveRuntimeInfo?.runtimeId?.trim() || dbRuntimeId
  const [modelSearch, setModelSearch] = React.useState('')
  const filteredModels = React.useMemo(() => {
    const q = modelSearch.trim().toLowerCase()
    if (!q) return availableModels
    return availableModels.filter((m) => {
      const label = (m.displayName || m.id).toLowerCase()
      return label.includes(q) || m.id.toLowerCase().includes(q)
    })
  }, [availableModels, modelSearch])

  React.useEffect(() => {
    if (!open) setModelSearch('')
  }, [open])

  React.useEffect(() => {
    sessionFlowLog('agent_selector.model_options.resolved', {
      agentId: agent.id,
      agentName: agent.displayName,
      runtimeId: displayRuntimeId,
      backendType,
      runtimeCurrentModel: liveRuntimeInfo?.currentModel ?? null,
      runtimeAvailableModelIds: liveRuntimeInfo?.availableModels.map((m) => m.id) ?? [],
      resolvedModelIds: availableModels.map((m) => m.id),
      runtimeInfoLoading,
    })
  }, [
    agent.id,
    agent.displayName,
    displayRuntimeId,
    backendType,
    liveRuntimeInfo?.currentModel,
    liveRuntimeInfo?.availableModels,
    availableModels,
    runtimeInfoLoading,
  ])

  const handlePickModel = React.useCallback(async (modelId: string) => {
    const freshByRuntimeId = useRuntimeStateStore.getState().byRuntimeId
    const rpcModelId = resolveSetModelId(agent.id, modelId, freshByRuntimeId)
    const liveRuntimeId = resolveRuntimeIdForAgent(agent.id, freshByRuntimeId, dbRuntimeId)

    sessionFlowLog('agent_selector.model_pick.begin', {
      agentId: agent.id,
      agentName: agent.displayName,
      runtimeId: liveRuntimeId,
      dbRuntimeId,
      effectiveModelId,
      modelId,
      rpcModelId,
      availableModelIds: availableModels.map((m) => m.id),
    })

    // ── Step 1: store the pick FIRST. The pick is the source of truth from
    // this point on. Persisted to localStorage; survives reload. Subsequent
    // MQTT retains for this agent cannot override it (selectAgentModel
    // prefers pick over retain).
    if (sessionId) {
      useAgentModelPickStore.getState().setPick(sessionId, agent.id, rpcModelId)
    }

    if (!liveRuntimeId) {
      sessionFlowLog('agent_selector.model_pick.deferred_until_runtime', {
        agentId: agent.id,
        modelId,
        sessionId,
      })
      const { toast } = await import('sonner')
      toast.success(t('chat.agentSelector.modelPickSaved', '模型已选择'), {
        description: t(
          'chat.agentSelector.modelPickSavedHint',
          '将在发送消息或 runtime 就绪后应用到 Agent',
        ),
      })
      return
    }

    // ── Step 2: best-effort apply on the daemon. If this fails, the pick
    // stays — the next runtimeStart / send flow re-applies it via
    // startAgentRuntimesAsync → setModel.
    try {
      const result = await setModel({
        targetActorId: agent.id, // route by the agent's actor_id
        runtimeId: liveRuntimeId,
        modelId: rpcModelId,
      })
      sessionFlowLog('agent_selector.model_pick.ok', {
        agentId: agent.id,
        runtimeId: liveRuntimeId,
        modelId: rpcModelId,
        sessionId,
        result,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // "agent not found" usually means the daemon spawn id rotated. One
      // 400ms re-resolve usually catches the new spawn id from a fresh
      // retain.
      const retried =
        /agent\s+.+\s+not found/i.test(message) &&
        (await (async () => {
          await new Promise((r) => setTimeout(r, 400))
          const fresh = useRuntimeStateStore.getState().byRuntimeId
          const retryRuntimeId = resolveRuntimeIdForAgent(agent.id, fresh, dbRuntimeId)
          if (!retryRuntimeId || retryRuntimeId === liveRuntimeId) return false
          try {
            await setModel({
              targetActorId: agent.id,
              runtimeId: retryRuntimeId,
              modelId: rpcModelId,
            })
            sessionFlowLog('agent_selector.model_pick.ok_after_retry', {
              agentId: agent.id,
              runtimeId: retryRuntimeId,
              modelId: rpcModelId,
            })
            return true
          } catch {
            return false
          }
        })())
      if (retried) return

      sessionFlowError('agent_selector.model_pick.failed', e, {
        agentId: agent.id,
        runtimeId: liveRuntimeId,
        modelId: rpcModelId,
      })
      const { toast } = await import('sonner')
      toast.error(t('chat.agentSelector.modelChangeFailed', 'Failed to change model'), {
        description: t(
          'chat.agentSelector.modelChangeWillRetry',
          '选择已保存，将在下次发送消息时重新应用。详情: {{message}}',
          { message },
        ),
      })
      console.error('[AgentSelectorDock] setModel failed (pick preserved)', e)
    }
  }, [agent.id, agent.displayName, dbRuntimeId, sessionId, t, effectiveModelId, availableModels])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 rounded-full bg-muted/40 px-2 text-xs font-medium"
        >
          <span
            className={cn('h-2 w-2 rounded-full', dotColor, pulse && 'animate-pulse')}
          />
          <span className="truncate max-w-[8rem]">{agent.displayName}</span>
          {runtimeInfoLoading && !displayedModel ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : displayedModel ? (
            <>
              <span className="text-muted-foreground/70">·</span>
              <span
                className={cn(
                  'truncate max-w-[10rem] font-mono text-[11px]',
                  isPlaceholderModel
                    ? 'italic text-muted-foreground/50'
                    : 'text-muted-foreground',
                )}
                title={isPlaceholderModel
                  ? t('chat.agentSelector.placeholderModelHint', 'No live runtime — dropdown will default to this model')
                  : undefined}
              >
                {displayedModel}
              </span>
            </>
          ) : null}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[18rem] p-0"
      >
        <Command shouldFilter={false}>
          {availableModels.length > 0 ? (
            <CommandInput
              value={modelSearch}
              onValueChange={setModelSearch}
              placeholder={t('chat.agentSelector.searchModelPlaceholder', 'Search models…')}
              className="text-xs"
            />
          ) : null}
          <CommandList className="max-h-[18rem]">
            {runtimeInfoLoading ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t('chat.agentSelector.loading', 'Loading…')}
              </div>
            ) : availableModels.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t('chat.agentSelector.noModels', 'No models advertised')}
              </div>
            ) : filteredModels.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t('chat.agentSelector.noMatchingModels', 'No matching models')}
              </div>
            ) : (
              <>
                <CommandGroup
                  heading={t('chat.agentSelector.modelHeading', 'Model')}
                >
                  {filteredModels.map((m) => {
                    const label = m.displayName || m.id
                    const selected = isAgentModelRowSelected(
                      m.id,
                      effectiveModelId,
                    )
                    return (
                      <CommandItem
                        key={m.id}
                        value={`${label} ${m.id}`}
                        onSelect={() => {
                          setOpen(false)
                          void handlePickModel(m.id)
                        }}
                        className="text-xs py-1.5"
                      >
                        <Check
                          className={cn(
                            'h-3.5 w-3.5 mr-1.5 shrink-0',
                            selected ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                        <span className="truncate">{label}</span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
          <CommandSeparator />
          <div className="p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onRemove()
              }}
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none"
            >
              <X className="h-3.5 w-3.5 mr-1.5" />
              {t('chat.agentSelector.removeMention', 'Remove mention')}
            </button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
