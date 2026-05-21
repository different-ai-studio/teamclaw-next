import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { supabase } from '@/lib/supabase-client'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { useSessionStore } from '@/stores/session'
import { useProviderStore, type ModelOption } from '@/stores/provider'
import { setModel } from '@/lib/teamclaw-rpc'
import { RuntimeLifecycle, AgentStatus, type RuntimeInfo } from '@/lib/proto/amux_pb'
import { cn } from '@/lib/utils'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface AgentSelectorDockProps {
  /** All agents currently @-mentioned for the active session — one pill each. */
  engagedAgents: AttachedAgent[]
  /** Remove a single agent (clicked the X on the chip / "Remove" in dropdown). */
  onRemoveAgent: (agentId: string) => void
}

type FallbackModel = { id: string; displayName: string }

const STATIC_RUNTIME_PROVIDER_IDS = new Set(['claude-code'])

// Mirrors iOS RuntimeResolver.encodedDefaultModels / SessionMemberSheetLoader.fallbackModelIDs.
// Called when the live runtime hasn't reported availableModels yet so the model
// picker is usable immediately rather than stuck on "Loading…".
function fallbackModels(
  backendType: string | undefined,
  providerModels: ModelOption[],
  currentModel?: string,
): FallbackModel[] {
  const configuredOpencodeModels = providerModels
    .filter((model) => !STATIC_RUNTIME_PROVIDER_IDS.has(model.provider))
    .map((model) => ({
      id: `${model.provider}/${model.id}`,
      displayName: model.name || model.id,
    }))

  switch (backendType) {
    case 'opencode':
      return configuredOpencodeModels
    case 'claude':
    case 'claude_code':
      return [
        { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
        { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
        { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7' },
      ]
    default:
      if (currentModel && configuredOpencodeModels.some((model) => model.id === currentModel)) {
        return configuredOpencodeModels
      }
      return []
  }
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

export function AgentSelectorDock({ engagedAgents, onRemoveAgent }: AgentSelectorDockProps) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  const [agentToRuntimeId, setAgentToRuntimeId] = React.useState<Map<string, string>>(new Map())
  const [agentToBackendType, setAgentToBackendType] = React.useState<Map<string, string>>(new Map())
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId)

  // Load agent → runtime mapping for the active session. Refetched whenever
  // a daemon retain arrives for an engaged agent we don't yet know about
  // (covers the race where the daemon's INSERT into agent_runtimes hasn't
  // landed when this component mounts).
  React.useEffect(() => {
    if (!activeSessionId) {
      setAgentToRuntimeId(new Map())
      setAgentToBackendType(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      const { data: rtRows } = await supabase
        .from('agent_runtimes')
        .select('agent_id, runtime_id, backend_type')
        .eq('session_id', activeSessionId)
      if (cancelled) return
      const map = new Map<string, string>()
      const btMap = new Map<string, string>()
      for (const r of (rtRows ?? []) as { agent_id: string; runtime_id: string; backend_type: string | null }[]) {
        if (r.agent_id && r.runtime_id) map.set(r.agent_id, r.runtime_id)
        if (r.agent_id && r.backend_type) btMap.set(r.agent_id, r.backend_type)
      }
      setAgentToRuntimeId(map)
      setAgentToBackendType(btMap)
    })()
    return () => { cancelled = true }
  }, [activeSessionId])

  // Retain-driven refetch: if any engaged agent has a retain but we haven't
  // mapped its runtime_id yet, re-pull agent_runtimes.
  const retainSignature = React.useMemo(() => {
    const ids = engagedAgents.map((a) => a.id)
    return Object.entries(runtimeStates)
      .filter(([, e]) => ids.includes(e.daemonDeviceId))
      .map(([rid]) => rid)
      .sort()
      .join(',')
  }, [runtimeStates, engagedAgents])

  React.useEffect(() => {
    if (!activeSessionId || engagedAgents.length === 0) return
    const missing = engagedAgents.some((a) => !agentToRuntimeId.has(a.id))
    if (!missing) return
    if (!retainSignature) return
    let cancelled = false
    void (async () => {
      const { data: rtRows } = await supabase
        .from('agent_runtimes')
        .select('agent_id, runtime_id, backend_type')
        .eq('session_id', activeSessionId)
      if (cancelled) return
      const map = new Map<string, string>()
      const btMap = new Map<string, string>()
      for (const r of (rtRows ?? []) as { agent_id: string; runtime_id: string; backend_type: string | null }[]) {
        if (r.agent_id && r.runtime_id) map.set(r.agent_id, r.runtime_id)
        if (r.agent_id && r.backend_type) btMap.set(r.agent_id, r.backend_type)
      }
      setAgentToRuntimeId(map)
      setAgentToBackendType((prev) => {
        const next = new Map(prev)
        btMap.forEach((bt, id) => next.set(id, bt))
        return next
      })
    })()
    return () => { cancelled = true }
  }, [engagedAgents, activeSessionId, agentToRuntimeId, retainSignature])

  // Backfill backend_type from the agent's most recent historical runtime
  // when we have no live entry yet — mirrors iOS CachedAgentRuntime fallback.
  React.useEffect(() => {
    const missing = engagedAgents.filter((a) => !agentToBackendType.has(a.id))
    if (missing.length === 0) return
    let cancelled = false
    void (async () => {
      const { data: rows } = await supabase
        .from('agent_runtimes')
        .select('agent_id, backend_type, updated_at')
        .in('agent_id', missing.map((a) => a.id))
        .not('backend_type', 'is', null)
        .order('updated_at', { ascending: false })
      if (cancelled) return
      const latestByAgent = new Map<string, string>()
      for (const r of (rows ?? []) as { agent_id: string; backend_type: string | null }[]) {
        if (r.agent_id && r.backend_type && !latestByAgent.has(r.agent_id)) {
          latestByAgent.set(r.agent_id, r.backend_type)
        }
      }
      if (latestByAgent.size > 0) {
        setAgentToBackendType((prev) => {
          const next = new Map(prev)
          latestByAgent.forEach((bt, id) => next.set(id, bt))
          return next
        })
      }
    })()
    return () => { cancelled = true }
  }, [engagedAgents, agentToBackendType])

  if (engagedAgents.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1">
      {engagedAgents.map((agent) => (
        <AgentPill
          key={agent.id}
          agent={agent}
          runtimeId={agentToRuntimeId.get(agent.id)}
          backendType={agentToBackendType.get(agent.id)}
          runtimeInfo={(() => {
            const rid = agentToRuntimeId.get(agent.id)
            return rid ? runtimeStates[rid]?.info : undefined
          })()}
          onRemove={() => onRemoveAgent(agent.id)}
        />
      ))}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Per-agent pill
// ────────────────────────────────────────────────────────────────────────────

function AgentPill({
  agent,
  runtimeId,
  backendType,
  runtimeInfo,
  onRemove,
}: {
  agent: AttachedAgent
  runtimeId: string | undefined
  backendType: string | undefined
  runtimeInfo: RuntimeInfo | undefined
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { color: dotColor, pulse } = dotClasses(runtimeInfo)
  const providerModels = useProviderStore((s) => s.models)

  const liveModels = runtimeInfo?.availableModels ?? []
  const currentModel = runtimeInfo?.currentModel ?? ''
  const availableModels = liveModels.length > 0
    ? liveModels
    : fallbackModels(backendType, providerModels, currentModel)
  const displayedModel = currentModel || availableModels[0]?.id || ''
  // Only `currentModel` reflects what the live runtime is actually using.
  // When we fall back to availableModels[0] it's just a "what the dropdown
  // would default to" placeholder, not the agent's real model — render it
  // de-emphasized so the user can tell.
  const isPlaceholderModel = !currentModel && !!displayedModel

  // Only show spinner when we have neither live runtime info nor a backend_type
  // to derive fallback models from.
  const runtimeInfoLoading = !runtimeInfo && !backendType

  const handlePickModel = React.useCallback(async (modelId: string) => {
    if (!runtimeId) return
    try {
      await setModel({
        targetDeviceId: agent.id, // daemon device_id == agent actor_id convention
        runtimeId,
        modelId,
      })
    } catch (e) {
      const { toast } = await import('sonner')
      toast.error(t('chat.agentSelector.modelChangeFailed', 'Failed to change model'))
      console.error('[AgentSelectorDock] setModel failed', e)
    }
  }, [agent.id, runtimeId, t])

  const [open, setOpen] = React.useState(false)

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
          {runtimeInfoLoading ? (
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
        <Command>
          {availableModels.length > 6 ? (
            <CommandInput
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
            ) : (
              <>
                <CommandEmpty className="py-3 text-xs">
                  {t('chat.agentSelector.noMatchingModels', 'No matching models')}
                </CommandEmpty>
                <CommandGroup
                  heading={t('chat.agentSelector.modelHeading', 'Model')}
                >
                  {availableModels.map((m) => {
                    const label = m.displayName || m.id
                    const selected = m.id === currentModel
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
