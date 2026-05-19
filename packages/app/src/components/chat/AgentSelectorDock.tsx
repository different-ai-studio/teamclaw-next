import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { supabase } from '@/lib/supabase-client'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionStore } from '@/stores/session'
import { setModel } from '@/lib/teamclaw-rpc'
import { RuntimeLifecycle, AgentStatus, type RuntimeInfo } from '@/lib/proto/amux_pb'
import { cn } from '@/lib/utils'
import type { AttachedAgent } from '@/packages/ai/prompt-input-insert-hooks'

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface AgentSelectorDockProps {
  engagedAgent: AttachedAgent | null
  onEngageAgent: (agent: AttachedAgent) => void
}

type SessionAgent = { id: string; display_name: string }

type FallbackModel = { id: string; displayName: string }

// Mirrors iOS RuntimeResolver.encodedDefaultModels / SessionMemberSheetLoader.fallbackModelIDs.
// Called when the live runtime hasn't reported availableModels yet so the model
// picker is usable immediately rather than stuck on "Loading…".
function fallbackModels(backendType: string | undefined): FallbackModel[] {
  switch (backendType) {
    case 'claude':
    case 'claude_code':
    case 'opencode':
      return [
        { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
        { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
        { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7' },
      ]
    default:
      return []
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Status dot helper
// ────────────────────────────────────────────────────────────────────────────

/** Gray = waiting for init / unknown. Green = idle. Red = actively
 * streaming output or errored. */
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

export function AgentSelectorDock({ engagedAgent, onEngageAgent }: AgentSelectorDockProps) {
  const { t } = useTranslation()
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessionRow = useSessionListStore((s) => s.rows.find((r) => r.id === activeSessionId))
  const fallbackTeamId = useSessionListStore((s) => s.rows[0]?.team_id ?? null)
  const _teamId = sessionRow?.team_id ?? fallbackTeamId

  const [sessionAgents, setSessionAgents] = React.useState<SessionAgent[]>([])
  const [agentToRuntimeId, setAgentToRuntimeId] = React.useState<Map<string, string>>(new Map())
  const [agentToBackendType, setAgentToBackendType] = React.useState<Map<string, string>>(new Map())
  const runtimeStates = useRuntimeStateStore((s) => s.byRuntimeId)

  // Load session participants + agent_runtimes mapping when session changes.
  React.useEffect(() => {
    if (!activeSessionId) {
      setSessionAgents([])
      setAgentToRuntimeId(new Map())
      return
    }
    let cancelled = false
    void (async () => {
      // Fetch session participants
      const { data: parts } = await supabase
        .from('session_participants')
        .select('actor_id')
        .eq('session_id', activeSessionId)
      if (cancelled) return
      const actorIds = (parts ?? []).map((r: { actor_id: string }) => r.actor_id)
      if (actorIds.length === 0) {
        setSessionAgents([])
        setAgentToRuntimeId(new Map())
        return
      }
      const { data: actors } = await supabase
        .from('actors')
        .select('id, display_name, actor_type')
        .in('id', actorIds)
        .eq('actor_type', 'agent')
      if (cancelled) return
      setSessionAgents((actors ?? []) as SessionAgent[])

      // Fetch agent_runtimes for live RuntimeInfo + backend_type lookup
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

  // Refetch agent_runtimes when a runtime retain arrives for an agent
  // we don't yet have mapped — the initial supabase fetch can race the
  // daemon's INSERT into agent_runtimes, leaving the dock stuck on
  // Loading even though the runtime is live.
  const retainSignature = React.useMemo(() => {
    if (!engagedAgent) return ''
    return Object.entries(runtimeStates)
      .filter(([, e]) => e.daemonDeviceId === engagedAgent.id)
      .map(([rid]) => rid)
      .sort()
      .join(',')
  }, [runtimeStates, engagedAgent])

  React.useEffect(() => {
    if (!engagedAgent || !activeSessionId) return
    if (agentToRuntimeId.has(engagedAgent.id)) return
    if (!retainSignature) return // no retain for this agent yet — nothing to refetch
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
      setAgentToBackendType(prev => {
        const next = new Map(prev)
        btMap.forEach((bt, id) => next.set(id, bt))
        return next
      })
    })()
    return () => { cancelled = true }
  }, [engagedAgent, activeSessionId, agentToRuntimeId, retainSignature])

  // When engagedAgent is set but we have no backend_type yet (brand-new session
  // with no agent_runtimes row), pull backend_type from the agent's most recent
  // historical runtime — mirrors iOS CachedAgentRuntime lookup in RuntimeResolver.
  React.useEffect(() => {
    if (!engagedAgent) return
    if (agentToBackendType.has(engagedAgent.id)) return
    let cancelled = false
    void (async () => {
      const { data: rows } = await supabase
        .from('agent_runtimes')
        .select('backend_type')
        .eq('agent_id', engagedAgent.id)
        .not('backend_type', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(1)
      if (cancelled) return
      const bt = (rows as Array<{ backend_type: string | null }>)?.[0]?.backend_type
      if (bt) {
        setAgentToBackendType(prev => new Map(prev).set(engagedAgent.id, bt))
      }
    })()
    return () => { cancelled = true }
  }, [engagedAgent, agentToBackendType])

  const engagedRuntimeId = engagedAgent ? agentToRuntimeId.get(engagedAgent.id) : undefined
  const engagedRuntimeInfo = engagedRuntimeId ? runtimeStates[engagedRuntimeId]?.info : undefined
  const { color: dotColor, pulse } = dotClasses(engagedRuntimeInfo)
  const engagedBackendType = engagedAgent ? agentToBackendType.get(engagedAgent.id) : undefined

  const liveModels = engagedRuntimeInfo?.availableModels ?? []
  const availableModels = liveModels.length > 0 ? liveModels : fallbackModels(engagedBackendType)
  const currentModel = engagedRuntimeInfo?.currentModel ?? ''

  const handlePickModel = React.useCallback(async (modelId: string) => {
    if (!engagedAgent || !engagedRuntimeId) return
    try {
      await setModel({
        targetDeviceId: engagedAgent.id,  // daemon device_id == agent actor_id convention
        runtimeId: engagedRuntimeId,
        modelId,
      })
    } catch (e) {
      const { toast } = await import('sonner')
      toast.error(t('chat.agentSelector.modelChangeFailed', 'Failed to change model'))
      console.error('[AgentSelectorDock] setModel failed', e)
    }
  }, [engagedAgent, engagedRuntimeId, t])

  // No agents in this session → hide the dock entirely. The parent
  // composer falls back to its empty state until at least one agent
  // joins (via picker / Add agent button / @-mention).
  if (sessionAgents.length === 0 && !engagedAgent) return null

  // Only show spinner when we have neither live runtime info nor a backend_type
  // to derive fallback models from — i.e., a genuinely unknown agent state.
  const runtimeInfoLoading = !!engagedAgent && !engagedRuntimeInfo && !engagedBackendType

  return (
    <div className="flex items-center gap-1">
      {/* Agent dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 rounded-full bg-muted/40 px-2 text-xs font-medium"
          >
            <span className={cn(
              'h-2 w-2 rounded-full',
              dotColor,
              pulse && 'animate-pulse',
            )} />
            <span className="truncate max-w-[10rem]">
              {engagedAgent?.displayName ?? t('chat.agentSelector.noAgent', 'No agent')}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[12rem]">
          {sessionAgents.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t('chat.agentSelector.pickAgent', 'Add an agent to this session first')}
            </div>
          ) : (
            sessionAgents.map((a) => (
              <DropdownMenuItem
                key={a.id}
                onClick={() => onEngageAgent({ id: a.id, displayName: a.display_name })}
                className={cn(
                  'text-xs py-1.5',
                  engagedAgent?.id === a.id && 'bg-muted',
                )}
              >
                <span className="truncate">{a.display_name}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Model dropdown — only when an agent is engaged */}
      {engagedAgent && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-full bg-muted/40 px-2 text-xs text-muted-foreground"
            >
              {runtimeInfoLoading ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span className="truncate">{t('chat.agentSelector.loading', 'Loading…')}</span>
                </>
              ) : (
                <>
                  <span className="truncate max-w-[8rem]">
                    {currentModel || availableModels[0]?.id || t('chat.agentSelector.noModels', '—')}
                  </span>
                  <ChevronDown className="h-3 w-3" />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[10rem]">
            {runtimeInfoLoading ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {t('chat.agentSelector.loading', 'Loading…')}
              </div>
            ) : availableModels.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {t('chat.agentSelector.noModels', 'No models advertised')}
              </div>
            ) : (
              availableModels.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => void handlePickModel(m.id)}
                  className={cn(
                    'text-xs py-1.5',
                    m.id === currentModel && 'bg-muted',
                  )}
                >
                  <span className="truncate">{m.displayName || m.id}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
