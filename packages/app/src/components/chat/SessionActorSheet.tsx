import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, Users, User as UserIcon, Sparkles, X } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase-client'
import { loadActorsForTeam, loadActorsByIds, loadSessionParticipants } from '@/lib/local-cache'
import { syncActorsForTeam } from '@/lib/sync/actor-sync'
import { syncParticipantsForSession } from '@/lib/sync/session-participant-sync'
import { cn } from '@/lib/utils'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { useDevicePresenceStore } from '@/stores/device-presence-store'
import { RuntimeLifecycle, AgentStatus, type RuntimeInfo } from '@/lib/proto/amux_pb'
import { resolveAmuxAgentType } from '@/lib/amux-agent-type'
import { useSessionParticipantStore } from '@/stores/session-participant-store'

// ── Types ──────────────────────────────────────────────────────────────────

type Row = {
  id: string
  actor_type: 'member' | 'agent'
  display_name: string
  member_status: string | null
  agent_status: string | null
  agent_types: string[]
  default_agent_type: string | null
  last_active_at: string | null
}

type CandidateAgent = {
  id: string
  display_name: string
  agent_types: string[]
  default_agent_type: string | null
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isOnline(lastActiveAt: string | null): boolean {
  if (!lastActiveAt) return false
  const t = Date.parse(lastActiveAt)
  if (Number.isNaN(t)) return false
  return Date.now() - t < 5 * 60 * 1000
}

function normalizeAgentTypes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : []
}

function pickAgentBackend(
  defaultAgentType: string | null | undefined,
  agentTypes: string[],
  priorBackendType: string | null | undefined,
): string | null {
  const normalizedDefault = defaultAgentType === 'claude_code' || defaultAgentType === 'claude-code'
    ? 'claude'
    : defaultAgentType ?? null
  if (normalizedDefault && (agentTypes.length === 0 || agentTypes.includes(normalizedDefault))) {
    return normalizedDefault
  }
  return agentTypes[0] ?? priorBackendType ?? null
}

function computeDotStateAndAnimation(
  actor: Row,
  runtimeInfo: RuntimeInfo | undefined,
  agentDeviceOnline: boolean | undefined,
): { color: string; breathing: boolean } {
  if (actor.actor_type === 'member') {
    return {
      color: isOnline(actor.last_active_at) ? 'bg-emerald-500' : 'bg-muted-foreground/40',
      breathing: false,
    }
  }
  // Agent. Offline-wins: MQTT DeviceState (LWT-backed) is authoritative for
  // "is the daemon reachable?". An ACTIVE runtime retain can linger on the
  // broker after the daemon dies, so suppress green when device is offline.
  if (agentDeviceOnline === false) {
    return { color: 'bg-muted-foreground/40', breathing: false }
  }
  if (!runtimeInfo) {
    return { color: 'bg-muted-foreground/40', breathing: false }
  }
  switch (runtimeInfo.state) {
    case RuntimeLifecycle.FAILED:
      return { color: 'bg-red-500', breathing: false }
    case RuntimeLifecycle.STARTING:
    case RuntimeLifecycle.STOPPED:
    case RuntimeLifecycle.UNKNOWN:
      return { color: 'bg-muted-foreground/40', breathing: false }
    case RuntimeLifecycle.ACTIVE:
      switch (runtimeInfo.status) {
        case AgentStatus.ACTIVE:
          return { color: 'bg-emerald-500', breathing: true }
        case AgentStatus.IDLE:
          return { color: 'bg-emerald-500', breathing: false }
        case AgentStatus.ERROR:
          return { color: 'bg-red-500', breathing: false }
        default:
          return { color: 'bg-muted-foreground/40', breathing: false }
      }
    default:
      return { color: 'bg-muted-foreground/40', breathing: false }
  }
}

function mapCachedActor(a: {
  id: string
  actorType: string
  displayName: string
  memberStatus?: string | null
  agentStatus?: string | null
}): Row {
  return {
    id: a.id,
    actor_type: (a.actorType as 'member' | 'agent'),
    display_name: a.displayName,
    member_status: a.memberStatus ?? null,
    agent_status: a.agentStatus ?? null,
    agent_types: [],
    default_agent_type: null,
    last_active_at: null,
  }
}

async function fetchParticipantsFromSupabase(sessionId: string): Promise<{ ids: string[]; rows: Row[] }> {
  const { data: parts, error: partsError } = await supabase
    .from('session_participants')
    .select('actor_id')
    .eq('session_id', sessionId)
  if (partsError) throw partsError

  const ids = ((parts ?? []) as Array<{ actor_id: string }>).map((p) => p.actor_id).filter(Boolean)
  if (ids.length === 0) return { ids, rows: [] }

  const { data: actors, error: actorsError } = await supabase
    .from('actor_directory')
    .select('id, actor_type, display_name, member_status, agent_status, agent_types, default_agent_type, last_active_at')
    .in('id', ids)
  if (actorsError) throw actorsError

  const byId = new Map(((actors ?? []) as Row[]).map((a) => [a.id, a] as const))
  return {
    ids,
    rows: ids
      .map((id) => byId.get(id))
      .filter((a): a is Row => !!a)
      .map((a) => ({
        id: a.id,
        actor_type: a.actor_type,
        display_name: a.display_name,
        member_status: a.member_status ?? null,
        agent_status: a.agent_status ?? null,
        agent_types: normalizeAgentTypes(a.agent_types),
        default_agent_type: a.default_agent_type ?? null,
        last_active_at: a.last_active_at ?? null,
      })),
  }
}

// Rows built from the local libsql cache only mirror columns on public.actors,
// so agent_types / default_agent_type (which live on public.agents) come back
// null. Patch them in via a single actor_directory lookup so the subline can
// render "<backend> · <model>" for cached agent rows too.
async function enrichAgentMetadata<T extends { id: string; agent_types: string[]; default_agent_type: string | null }>(
  rows: T[],
  isAgent: (row: T) => boolean,
): Promise<T[]> {
  const missingIds = rows
    .filter((r) => isAgent(r) && (r.agent_types.length === 0 || r.default_agent_type == null))
    .map((r) => r.id)
  if (missingIds.length === 0) return rows
  const { data, error } = await supabase
    .from('actor_directory')
    .select('id, agent_types, default_agent_type')
    .in('id', missingIds)
  if (error || !data) return rows
  const byId = new Map(
    (data as Array<{ id: string; agent_types: unknown; default_agent_type: string | null }>)
      .map((d) => [d.id, d] as const),
  )
  return rows.map((r) => {
    const extra = byId.get(r.id)
    if (!extra) return r
    return {
      ...r,
      agent_types: r.agent_types.length > 0 ? r.agent_types : normalizeAgentTypes(extra.agent_types),
      default_agent_type: r.default_agent_type ?? extra.default_agent_type ?? null,
    }
  })
}

async function fetchCandidateAgentsFromSupabase(teamId: string, presentIds: Set<string>): Promise<CandidateAgent[]> {
  // agent_types / default_agent_type live on public.agents; actor_directory
  // joins them through and applies the visibility=team filter for us.
  const { data, error } = await supabase
    .from('actor_directory')
    .select('id, display_name, actor_type, agent_types, default_agent_type')
    .eq('team_id', teamId)
    .eq('actor_type', 'agent')
  if (error) throw error
  return ((data ?? []) as Array<{
    id: string
    display_name: string
    actor_type: string
    agent_types: unknown
    default_agent_type: string | null
  }>)
    .filter((a) => a.actor_type === 'agent' && !presentIds.has(a.id))
    .map((a) => ({
      id: a.id,
      display_name: a.display_name,
      agent_types: normalizeAgentTypes(a.agent_types),
      default_agent_type: a.default_agent_type ?? null,
    }))
}

// ── ActorRowView ───────────────────────────────────────────────────────────

function ActorRowView({
  actor,
  runtimeInfo,
  canRemove,
  onRemove,
}: {
  actor: Row
  runtimeInfo?: RuntimeInfo
  canRemove: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const isAgent = actor.actor_type === 'agent'
  const initials = actor.display_name?.slice(0, 2).toUpperCase() || ''
  // For agents, the daemon's device_id == its actor_id, so look up presence
  // by actor id. `undefined` (no retain yet) ≠ `false` (LWT fired): only the
  // explicit `false` should suppress the green dot.
  const agentDeviceOnline = useDevicePresenceStore((s) =>
    isAgent ? s.byDeviceId[actor.id]?.online : undefined,
  )
  const { color: dotColor, breathing } = computeDotStateAndAnimation(actor, runtimeInfo, agentDeviceOnline)
  // For agents, show "<backend type> · <model>" — e.g. "claude · claude-opus-4-7".
  // backend type = default_agent_type (claude | opencode | codex).
  // model = runtimeInfo.currentModel when a runtime is live; otherwise omitted.
  const modelName = isAgent ? (runtimeInfo?.currentModel || null) : null
  let subline: string
  if (isAgent) {
    const parts: string[] = []
    const backend = pickAgentBackend(actor.default_agent_type, actor.agent_types, null)
    if (backend) parts.push(backend)
    if (modelName) parts.push(modelName)
    subline = parts.join(' · ')
  } else {
    subline = actor.member_status || ''
  }

  return (
    <div className="group relative flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40">
      <div
        className={cn(
          'relative flex h-8 w-8 shrink-0 items-center justify-center bg-muted text-xs font-medium text-muted-foreground',
          isAgent ? 'rounded-md' : 'rounded-full',
        )}
      >
        {initials || (isAgent ? <Sparkles className="h-4 w-4" /> : <UserIcon className="h-4 w-4" />)}
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-background',
            dotColor,
            breathing && 'animate-pulse',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{actor.display_name}</div>
        {subline && (
          <div className="truncate text-[11px] text-muted-foreground">{subline}</div>
        )}
      </div>
      {canRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-2 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          aria-label={t('chat.actorSheet.removeAria', 'Remove')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

// ── SessionActorPanel ──────────────────────────────────────────────────────
// Renders inline (e.g., inside the workspace RightPanel) — no Sheet wrapper.
// Visibility is controlled by the parent panel; this component just renders
// the list + handlers + confirm dialog.

export interface SessionActorPanelProps {
  sessionId: string | null
  teamId: string | null
}

export function SessionActorPanel({ sessionId, teamId }: SessionActorPanelProps) {
  // Effect-trigger gate: when the panel mounts we want the same "open"
  // semantics as the old Sheet had (clear stale rows, refetch on
  // session/team change). The component is always "open" while mounted,
  // so we read the same flag from a hardcoded true below.
  const open = true
  const { t } = useTranslation()
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [rows, setRows] = React.useState<Row[]>([])
  const [agentToRuntimeId, setAgentToRuntimeId] = React.useState<Map<string, string>>(new Map())
  const [myActorId, setMyActorId] = React.useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = React.useState<Row | null>(null)
  const [candidateAgents, setCandidateAgents] = React.useState<CandidateAgent[]>([])
  const [addingAgent, setAddingAgent] = React.useState(false)

  const runtimeStates = useRuntimeStateStore(s => s.byRuntimeId)

  React.useEffect(() => {
    // Clear stale data whenever the sheet closes or the session changes —
    // otherwise switching to a new session leaves the previous session's
    // rows visible until the new fetch lands (or forever, if the new
    // session is null/empty).
    setRows([])
    setAgentToRuntimeId(new Map())
    setMyActorId(null)
    setError(false)
    setCandidateAgents([])
    setAddingAgent(false)
    if (!open) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)

    // When there's no active session yet (brand-new chat) but we have a team
    // context, still query candidate agents so the + button can render. The
    // "+" handler itself guards against null sessionId.
    if (!sessionId) {
      if (teamId) {
        void (async () => {
          // Phase 1: load candidate agents from local cache instantly.
          const cached = await loadActorsForTeam(teamId)
          if (cancelled) return
          setCandidateAgents(
            cached
              .filter(a => a.actorType === 'agent')
              .map(a => ({
                id: a.id,
                display_name: a.displayName,
                agent_types: [],
                default_agent_type: null,
              })),
          )
          setLoading(false)
          // Phase 2: refresh in background.
          void syncActorsForTeam(teamId)
        })()
      } else {
        setLoading(false)
      }
      return () => { cancelled = true }
    }

    /** Apply a snapshot of (participants, actors, candidate agents) to UI. */
    function applySnapshot(
      actorIds: string[],
      actorRows: Row[],
      candidates: CandidateAgent[],
    ) {
      setRows(actorRows)
      setCandidateAgents(candidates)
      if (actorIds.length === 0) setAgentToRuntimeId(new Map())
    }

    void (async () => {
      // ────────────────────────────────────────────────────────────────
      // Phase 1: instant render from local libsql cache
      // ────────────────────────────────────────────────────────────────
      const [cachedParticipants, cachedTeamActors] = await Promise.all([
        loadSessionParticipants(sessionId),
        teamId ? loadActorsForTeam(teamId) : Promise.resolve([]),
      ])
      if (cancelled) return

      const cachedActorIds = cachedParticipants.map(p => p.actorId)
      const cachedPresentSet = new Set(cachedActorIds)
      const cachedById = new Map(cachedTeamActors.map(a => [a.id, a]))

      // If team cache misses any participant (rare), fall back to id-lookup.
      const missingIds = cachedActorIds.filter(id => !cachedById.has(id))
      if (missingIds.length > 0) {
        const extra = await loadActorsByIds(missingIds)
        if (cancelled) return
        for (const a of extra) cachedById.set(a.id, a)
      }

      let cachedRows: Row[] = cachedActorIds
        .map(id => cachedById.get(id))
        .filter((a): a is NonNullable<typeof a> => !!a)
        .map(mapCachedActor)

      let cachedCandidates: CandidateAgent[] = cachedTeamActors
        .filter(a => a.actorType === 'agent' && !cachedPresentSet.has(a.id))
        .map(a => ({
          id: a.id,
          display_name: a.displayName,
          // ActorRow cache lacks agent_types / default_agent_type today; the
          // supabase fallback (`fetchCandidateAgentsFromSupabase`) supplies
          // them when no cached row matches.
          agent_types: [],
          default_agent_type: null,
        }))

      let effectiveActorIds = cachedActorIds
      if (cachedRows.length === 0) {
        const live = await fetchParticipantsFromSupabase(sessionId)
        if (cancelled) return
        cachedRows = live.rows
        effectiveActorIds = live.ids
      } else {
        cachedRows = await enrichAgentMetadata(cachedRows, (r) => r.actor_type === 'agent')
        if (cancelled) return
      }
      if (teamId && cachedCandidates.length === 0) {
        cachedCandidates = await fetchCandidateAgentsFromSupabase(
          teamId,
          new Set(effectiveActorIds),
        )
        if (cancelled) return
      } else {
        cachedCandidates = await enrichAgentMetadata(cachedCandidates, () => true)
        if (cancelled) return
      }

      applySnapshot(effectiveActorIds, cachedRows, cachedCandidates)
      setLoading(false)

      // ────────────────────────────────────────────────────────────────
      // Phase 2: background sync (participants + team actors), re-hydrate
      // ────────────────────────────────────────────────────────────────
      if (teamId) {
        await Promise.all([
          syncParticipantsForSession(sessionId, teamId),
          syncActorsForTeam(teamId),
        ])
        if (cancelled) return

        const [freshParticipants, freshTeamActors] = await Promise.all([
          loadSessionParticipants(sessionId),
          loadActorsForTeam(teamId),
        ])
        if (cancelled) return

        const freshIds = freshParticipants.map(p => p.actorId)
        const freshPresent = new Set(freshIds)
        const freshById = new Map(freshTeamActors.map(a => [a.id, a]))
        const stillMissing = freshIds.filter(id => !freshById.has(id))
        if (stillMissing.length > 0) {
          const extra = await loadActorsByIds(stillMissing)
          if (cancelled) return
          for (const a of extra) freshById.set(a.id, a)
        }

        let freshRows: Row[] = freshIds
          .map(id => freshById.get(id))
          .filter((a): a is NonNullable<typeof a> => !!a)
          .map(mapCachedActor)

        let freshCandidates: CandidateAgent[] = freshTeamActors
          .filter(a => a.actorType === 'agent' && !freshPresent.has(a.id))
          .map(a => ({
          id: a.id,
          display_name: a.displayName,
          // ActorRow cache lacks agent_types / default_agent_type today; the
          // supabase fallback (`fetchCandidateAgentsFromSupabase`) supplies
          // them when no cached row matches.
          agent_types: [],
          default_agent_type: null,
        }))

        let effectiveFreshIds = freshIds
        if (freshRows.length === 0) {
          const live = await fetchParticipantsFromSupabase(sessionId)
          if (cancelled) return
          freshRows = live.rows
          effectiveFreshIds = live.ids
        } else {
          freshRows = await enrichAgentMetadata(freshRows, (r) => r.actor_type === 'agent')
          if (cancelled) return
        }
        if (freshCandidates.length === 0) {
          freshCandidates = await fetchCandidateAgentsFromSupabase(
            teamId,
            new Set(effectiveFreshIds),
          )
          if (cancelled) return
        } else {
          freshCandidates = await enrichAgentMetadata(freshCandidates, () => true)
          if (cancelled) return
        }

        applySnapshot(effectiveFreshIds, freshRows, freshCandidates)
      }

      // ────────────────────────────────────────────────────────────────
      // Live-state lookups that aren't cached: agent_runtimes + my-actor.
      // Small queries, kept on supabase. Fire in parallel; failures are
      // non-fatal (we already rendered from cache).
      // ────────────────────────────────────────────────────────────────
      let finalActorIds = (await loadSessionParticipants(sessionId)).map(p => p.actorId)
      if (finalActorIds.length === 0) {
        finalActorIds = (await fetchParticipantsFromSupabase(sessionId)).ids
      }
      if (cancelled) return

      const [runtimeRes, userRes] = await Promise.all([
        supabase
          .from('agent_runtimes')
          .select('agent_id, runtime_id')
          .eq('session_id', sessionId),
        supabase.auth.getUser(),
      ])
      if (cancelled) return

      const runtimeMap = new Map<string, string>()
      if (!runtimeRes.error) {
        for (const r of (runtimeRes.data ?? []) as Array<{ agent_id: string; runtime_id: string }>) {
          if (r.agent_id && r.runtime_id) runtimeMap.set(r.agent_id, r.runtime_id)
        }
      }
      setAgentToRuntimeId(runtimeMap)

      const user = userRes.data.user
      if (user && finalActorIds.length > 0) {
        const { data: myActorRows } = await supabase
          .from('actors')
          .select('id')
          .eq('user_id', user.id)
          .in('id', finalActorIds)
        if (cancelled) return
        setMyActorId(myActorRows?.[0]?.id ?? null)
      }
    })().catch(e => {
      if (cancelled) return
      console.error('[SessionActorSheet] load failed', e)
      setError(true)
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [open, sessionId, teamId])

  async function confirmRemove(actor: Row) {
    if (!sessionId) return
    const prevRows = rows
    // Optimistic: drop the row immediately
    setRows(prev => prev.filter(r => r.id !== actor.id))
    setPendingRemove(null)
    const { error: deleteErr } = await supabase
      .from('session_participants')
      .delete()
      .eq('session_id', sessionId)
      .eq('actor_id', actor.id)
    if (deleteErr) {
      console.error('[SessionActorSheet] remove failed:', deleteErr)
      // Rollback
      setRows(prevRows)
      // Toast
      const { toast } = await import('sonner')
      toast.error(t('chat.actorSheet.removeError', 'Failed to remove from session'))
    } else {
      useSessionParticipantStore.getState().invalidateSessions([sessionId])
    }
  }

  async function handleAddAgent() {
    if (!sessionId || !teamId) return
    if (candidateAgents.length === 0) return
    if (addingAgent) return

    const candidate = candidateAgents[0] // MVP: pick the first available
    setAddingAgent(true)

    // Snapshot for rollback
    const prevRows = rows
    const prevCandidates = candidateAgents

    // Optimistic: insert as a "starting"-state agent row
    const newRow: Row = {
      id: candidate.id,
      actor_type: 'agent',
      display_name: candidate.display_name,
      member_status: null,
      agent_status: 'starting',
      agent_types: candidate.agent_types,
      default_agent_type: null,
      last_active_at: null,
    }
    setRows(prev => [...prev, newRow])
    setCandidateAgents(prev => prev.filter(c => c.id !== candidate.id))

    try {
      // 1. Upsert into session_participants — idempotent: if the row already
      //    exists (candidate list was stale because phase 2 sync hadn't
      //    landed yet), treat it as a no-op rather than failing.
      const { error: insErr } = await supabase
        .from('session_participants')
        .upsert(
          { session_id: sessionId, actor_id: candidate.id },
          { onConflict: 'session_id,actor_id', ignoreDuplicates: true },
        )
      if (insErr) throw insErr

      // 2. Derive workspace from the agent's prior runtime history
      const { data: priorRows } = await supabase
        .from('agent_runtimes')
        .select('workspace_id, agent_id, current_model, status, backend_type, updated_at')
        .eq('agent_id', candidate.id)
        .eq('team_id', teamId)
        .order('updated_at', { ascending: false })
        .limit(1)

      const workspaceId = priorRows?.[0]?.workspace_id ?? ''
      // Prefer the agent's explicit default_agent_type (set via UI) over the
      // backend_type recorded from the agent's prior runtime — the prior value
      // can lag if the operator changed the default after the last spawn.
      const backendType = pickAgentBackend(
        candidate.default_agent_type,
        candidate.agent_types,
        priorRows?.[0]?.backend_type ?? null,
      )
      const agentType = resolveAmuxAgentType(backendType)

      // 3. Call runtimeStart RPC. Daemon may reject if it already has a
      //    runtime for this (session, agent) — treat that as success since
      //    the existing runtime will service the next prompt anyway.
      const { runtimeStart } = await import('@/lib/teamclaw-rpc')
      try {
        const result = await runtimeStart({
          targetDeviceId: candidate.id,
          workspaceId,
          worktree: '', // daemon falls back to '.' when empty
          sessionId,
          agentType,
          initialPrompt: '',
        })
        if (!result.accepted) {
          // Tolerate "already running"-style rejections — log and proceed.
          console.warn('[SessionActorSheet] runtimeStart rejected (non-fatal):', result.rejectedReason)
        }
      } catch (rpcErr) {
        console.warn('[SessionActorSheet] runtimeStart threw (non-fatal):', rpcErr)
      }
      // RuntimeInfo retain will arrive via store subscription and update the dot/model automatically
      useSessionParticipantStore.getState().invalidateSessions([sessionId])
    } catch (e) {
      console.error('[SessionActorSheet] add agent failed:', e)
      // Rollback
      setRows(prevRows)
      setCandidateAgents(prevCandidates)
      const { toast } = await import('sonner')
      toast.error(t('chat.actorSheet.addError', 'Failed to add agent'))
    } finally {
      setAddingAgent(false)
    }
  }

  const members = rows.filter((a) => a.actor_type === 'member')
  const agents = rows.filter((a) => a.actor_type === 'agent')

  return (
    <>
      <div className="h-full flex flex-col">
        <div className="px-4 py-3 border-b">
          <h2 className="text-sm font-semibold">{t('chat.actorSheet.title', 'Actors')}</h2>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && (
              <div className="flex flex-col items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="mb-2 h-5 w-5 animate-spin" />
                <span>{t('chat.actorSheet.loading', 'Loading actors...')}</span>
              </div>
            )}

            {!loading && error && (
              <div className="px-4 py-3 text-sm text-destructive">
                {t('chat.actorSheet.error', 'Failed to load actors')}
              </div>
            )}

            {!loading && !error && members.length === 0 && agents.length === 0 && candidateAgents.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
                <Users className="mb-2 h-8 w-8 text-muted-foreground" />
                <span>{t('chat.actorSheet.empty', 'No participants in this session')}</span>
              </div>
            )}

            {!loading && !error && (members.length > 0 || agents.length > 0 || candidateAgents.length > 0) && (
              <>
                {members.length > 0 && (
                  <>
                    <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      {t('chat.mentionGroupMembers', 'Members')}
                    </div>
                    {members.map((m) => (
                      <ActorRowView
                        key={m.id}
                        actor={m}
                        canRemove={!!myActorId && m.id !== myActorId}
                        onRemove={() => setPendingRemove(m)}
                      />
                    ))}
                  </>
                )}
                {(agents.length > 0 || candidateAgents.length > 0) && (
                  <>
                    <div className="flex items-center justify-between px-4 pb-1 pt-3">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                        {t('chat.mentionGroupAgents', 'Agents')}
                      </span>
                      {candidateAgents.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => void handleAddAgent()}
                          disabled={addingAgent || !sessionId}
                          aria-label={t('chat.actorSheet.addAgentAria', 'Add agent')}
                          title={!sessionId
                            ? t('chat.actorSheet.addNeedsSession', 'Send a message first to create the session')
                            : t('chat.actorSheet.addAgentAria', 'Add agent')}
                        >
                          {addingAgent
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Plus className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                    </div>
                    {agents.map((a) => {
                      const runtimeId = agentToRuntimeId.get(a.id)
                      const info = runtimeId ? runtimeStates[runtimeId]?.info : undefined
                      return (
                        <ActorRowView
                          key={a.id}
                          actor={a}
                          runtimeInfo={info}
                          canRemove={!!myActorId}
                          onRemove={() => setPendingRemove(a)}
                        />
                      )
                    })}
                  </>
                )}
              </>
            )}
        </div>
      </div>

      <AlertDialog open={!!pendingRemove} onOpenChange={(open) => { if (!open) setPendingRemove(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat.actorSheet.removeTitle', 'Remove from session?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove && t('chat.actorSheet.removeDesc', 'Remove {{name}} from this session?', { name: pendingRemove.display_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingRemove) void confirmRemove(pendingRemove) }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('chat.actorSheet.removeConfirm', 'Remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
