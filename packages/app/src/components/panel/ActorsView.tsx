import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Filter, Loader2, Plus, Search, Sparkles, User as UserIcon, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { InviteActorDialog } from '@/components/sidebar/InviteActorDialog'
import { supabase } from '@/lib/supabase-client'
import { actorAvatarColor } from '@/lib/actor-color'
import { formatRelativeTime } from '@/lib/date-format'
import { useSessionListStore } from '@/stores/session-list-store'
import { useUIStore } from '@/stores/ui'
import { cn, isTauri } from '@/lib/utils'
import { loadActorsForTeam, upsertActorsBatch, type ActorRow as CachedActorRow } from '@/lib/local-cache'
import { useDevicePresenceStore } from '@/stores/device-presence-store'

export type ActorRow = {
  id: string
  actor_type: 'member' | 'agent'
  display_name: string
  member_status: string | null
  agent_status: string | null
  last_active_at: string | null
}

export interface UseActorsForTeamResult {
  actors: ActorRow[]
  loading: boolean
  error: boolean
  teamId: string | null
  refetch: () => void
}

export function useActorsForTeam(): UseActorsForTeamResult {
  const sessionRows = useSessionListStore((s) => s.rows)
  const [teamId, setTeamId] = React.useState<string | null>(null)
  const [actors, setActors] = React.useState<ActorRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [refreshTick, setRefreshTick] = React.useState(0)

  React.useEffect(() => {
    if (teamId) return
    const fromSession = sessionRows[0]?.team_id
    if (fromSession) {
      setTeamId(fromSession)
      return
    }
    let cancelled = false
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return
      const { data: actorRow } = await supabase
        .from('actors')
        .select('id, team_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle()
      if (!cancelled) setTeamId(actorRow?.team_id ?? null)
    })()
    return () => { cancelled = true }
  }, [sessionRows, teamId])

  React.useEffect(() => {
    if (!teamId) return
    let cancelled = false
    setError(false)

    void (async () => {
      let hadLocal = false
      if (isTauri()) {
        const local = await loadActorsForTeam(teamId)
        if (cancelled) return
        if (local.length > 0) {
          const sorted = [...local].sort((a, b) => a.displayName.localeCompare(b.displayName))
          setActors(sorted.map((r): ActorRow => ({
            id: r.id,
            actor_type: r.actorType === 'agent' ? 'agent' : 'member',
            display_name: r.displayName,
            member_status: r.memberStatus ?? null,
            agent_status: r.agentStatus ?? null,
            last_active_at: r.lastActiveAt ?? null,
          })))
          hadLocal = true
          setLoading(false)
        }
      }
      if (!hadLocal) setLoading(true)

      const { data, error: fetchError } = await supabase
        .from('actor_directory')
        .select('id, actor_type, display_name, member_status, agent_status, last_active_at')
        .eq('team_id', teamId)
        .order('last_active_at', { ascending: false, nullsFirst: false })
        .order('display_name', { ascending: true })
      if (cancelled) return
      if (fetchError) {
        console.error('[useActorsForTeam] fetch failed', fetchError)
        if (!hadLocal) setError(true)
        setLoading(false)
        return
      }
      const rows = (data ?? []) as ActorRow[]
      setActors(rows)
      setLoading(false)

      if (isTauri() && rows.length > 0) {
        const now = new Date().toISOString()
        const cached: CachedActorRow[] = rows.map((r) => ({
          id: r.id,
          teamId,
          actorType: r.actor_type,
          displayName: r.display_name,
          memberStatus: r.member_status,
          agentStatus: r.agent_status,
          lastActiveAt: r.last_active_at,
          createdAt: now,
          updatedAt: now,
          syncedAt: now,
        }))
        await upsertActorsBatch(cached).catch((e) => {
          console.warn('[useActorsForTeam] upsertActorsBatch failed', e)
        })
      }
    })()

    return () => { cancelled = true }
  }, [teamId, refreshTick])

  const refetch = React.useCallback(() => {
    setRefreshTick((n) => n + 1)
  }, [])

  return { actors, loading, error, teamId, refetch }
}

export function isActorOnline(lastActiveAt: string | null): boolean {
  if (!lastActiveAt) return false
  const t = Date.parse(lastActiveAt)
  if (Number.isNaN(t)) return false
  return Date.now() - t < 5 * 60 * 1000
}

type ActorTypeFilter = 'all' | 'agent' | 'member'

function ActorRowView({ actor }: { actor: ActorRow }) {
  const isAgent = actor.actor_type === 'agent'
  // Members: heartbeat-based — last_active_at within 5min.
  // Agents: authoritative MQTT presence from device-presence-store
  // (daemon LWT flips this to offline within seconds of disconnect).
  // For an agent with no presence entry at all (daemon never connected
  // since the app launched), fall back to last_active_at so freshly-loaded
  // sessions don't show every agent as gray during the first second.
  const agentPresence = useDevicePresenceStore((s) => isAgent ? s.byDeviceId[actor.id] : undefined)
  const online = isAgent
    ? (agentPresence ? agentPresence.online : isActorOnline(actor.last_active_at))
    : isActorOnline(actor.last_active_at)
  const status = actor.actor_type === 'member' ? actor.member_status : actor.agent_status
  const initial = actor.display_name?.trim().slice(0, 1).toUpperCase() || ''
  const enterActorDraft = useUIStore((s) => s.enterActorDraft)
  const colors = actorAvatarColor(actor.id)
  const lastActive = actor.last_active_at ? formatRelativeTime(new Date(actor.last_active_at)) : ''
  return (
    <button
      type="button"
      onClick={() => enterActorDraft({ id: actor.id, displayName: actor.display_name, kind: actor.actor_type })}
      className="flex w-full items-center gap-2.5 border-b border-border-soft px-4 py-2.5 text-left hover:bg-selected focus:outline-none focus-visible:bg-selected"
    >
      <div className={cn(
        'relative flex h-10 w-10 shrink-0 items-center justify-center text-[16px] font-semibold text-white',
        isAgent ? 'rounded-[11px] ring-[1.5px] ring-coral' : 'rounded-full',
      )} style={{ backgroundColor: colors.bg, color: colors.fg }}>
        {initial || (isAgent ? <Sparkles className="h-4 w-4" /> : <UserIcon className="h-4 w-4" />)}
        <span className={cn(
          'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-background',
          isAgent ? 'bg-coral' : online ? 'bg-emerald-500' : 'bg-faint',
        )} aria-label={status ?? (online ? 'online' : 'offline')} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold leading-[19px] text-foreground">{actor.display_name}</span>
          {isAgent && (
            <span className="shrink-0 rounded-[5px] border border-coral px-1.5 py-0 font-mono text-[9.5px] font-semibold leading-[15px] text-coral">
              Agent
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11.5px] leading-[18px] text-muted-foreground">
          <span className="truncate">{isAgent ? 'Agent' : 'Team'}</span>
          {status && (
            <>
              <span className="text-faint">·</span>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-faint" aria-label={status} />
            </>
          )}
        </div>
      </div>
      {lastActive && <span className="ml-2 shrink-0 font-mono text-[11.5px] text-faint">{lastActive}</span>}
    </button>
  )
}

function FilterRow({
  active,
  count,
  dotClassName,
  label,
  onSelect,
}: {
  active: boolean
  count: number
  dotClassName?: string
  label: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[8px] px-3 py-1.5 text-left text-[12.5px] font-semibold text-foreground',
        active && 'bg-coral-soft/35',
      )}
    >
      {dotClassName ? <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClassName)} /> : <span className="w-2" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-mono text-[11.5px] font-normal text-faint">{count}</span>
      {active && <Check className="h-3.5 w-3.5 text-coral" />}
    </button>
  )
}

export function ActorsView() {
  const { t } = useTranslation()
  const { actors, loading, error, teamId } = useActorsForTeam()
  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [filter, setFilter] = React.useState<ActorTypeFilter>('all')
  const [inviteOpen, setInviteOpen] = React.useState(false)

  const counts = React.useMemo(() => ({
    all: actors.length,
    agent: actors.filter((actor) => actor.actor_type === 'agent').length,
    member: actors.filter((actor) => actor.actor_type === 'member').length,
  }), [actors])

  const visibleActors = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return actors.filter((actor) => {
      if (filter !== 'all' && actor.actor_type !== filter) return false
      if (!normalizedQuery) return true
      return actor.display_name.toLowerCase().includes(normalizedQuery)
    })
  }, [actors, filter, query])

  const renderBody = () => {
    if (loading) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="mb-2 h-5 w-5 animate-spin" />
          <span>{t('actors.loading', 'Loading actors...')}</span>
        </div>
      )
    }

    if (error) {
      return (
        <div className="px-4 py-3 text-sm text-destructive">{t('actors.error', 'Failed to load actors')}</div>
      )
    }

    if (actors.length === 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
          <Users className="mb-2 h-8 w-8 text-muted-foreground" />
          <span>{t('actors.empty', 'No actors in this team yet')}</span>
        </div>
      )
    }

    if (visibleActors.length === 0) {
      return (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('actors.noMatches', 'No matching actors')}
        </div>
      )
    }

    return (
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {visibleActors.map((a) => <ActorRowView key={a.id} actor={a} />)}
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold leading-7 text-foreground">
            {t('actors.allTitle', 'All actors')}
            <span className="ml-2 font-mono text-[12.5px] font-normal text-faint">· {visibleActors.length}</span>
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn('h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground', searchOpen && 'bg-selected text-foreground')}
            aria-label={t('common.search', 'Search')}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search className="h-4 w-4" />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
                aria-label={t('actors.filterType', 'Filter by type')}
              >
                <Filter className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[260px] rounded-[14px] border-border bg-paper p-2 shadow-[0_18px_45px_-28px_rgba(26,26,20,0.45)]">
              <div className="px-3 pb-1 pt-1 text-[11.5px] font-semibold text-faint">{t('actors.typeFilterLabel', 'Type')}</div>
              <FilterRow active={filter === 'all'} count={counts.all} label={t('common.all', 'All')} onSelect={() => setFilter('all')} />
              <FilterRow active={filter === 'agent'} count={counts.agent} dotClassName="bg-coral" label={t('actors.type.agent', 'Agent')} onSelect={() => setFilter('agent')} />
              <FilterRow active={filter === 'member'} count={counts.member} dotClassName="bg-emerald-500" label={t('actors.type.member', 'Team')} onSelect={() => setFilter('member')} />
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
            aria-label={t('actors.invite', 'Invite actor')}
            onClick={() => setInviteOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {searchOpen && (
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('actors.searchPlaceholder', 'Search actors')}
            className="mt-2 h-8 w-full rounded-[8px] border border-border bg-paper px-3 text-[12.5px] outline-none placeholder:text-faint focus:border-border"
          />
        )}
      </div>
      {renderBody()}
      <InviteActorDialog open={inviteOpen} onOpenChange={setInviteOpen} teamId={teamId} />
    </div>
  )
}
