import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Pencil, Search, X } from 'lucide-react'
import {
  Dialog, DialogContent, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionStore } from '@/stores/session'
import { useProviderStore } from '@/stores/provider'
import { resolveCurrentMemberActorId } from '@/lib/current-actor'
import { loadActorsForTeam } from '@/lib/local-cache'
import { syncActorsForTeam } from '@/lib/sync/actor-sync'
import { supabase } from '@/lib/supabase-client'
import { actorAvatarColor } from '@/lib/actor-color'
import { createSessionWithFirstMessage } from '@/lib/session-create'
import { ensureSessionLiveSubscribed } from '@/App'
import { cn } from '@/lib/utils'
import { resolveAmuxAgentType } from '@/lib/amux-agent-type'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type Candidate = {
  id: string
  actor_type: 'member' | 'agent'
  display_name: string
}

const RUNTIME_BACKENDS = new Set(['claude-code', 'opencode', 'codex'])

export function NewSessionDialog() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.newSessionDialogOpen)
  const initialMessage = useUIStore((s) => s.newSessionDialogInitialMessage)
  const closeDialog = useUIStore((s) => s.closeNewSessionDialog)

  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const currentMemberId = useCurrentTeamStore((s) => s.currentMember?.id ?? null)

  const [candidates, setCandidates] = React.useState<Candidate[]>([])
  const [loading, setLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState(false)
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [selectedBackend, setSelectedBackend] = React.useState('')
  const [selectedModelKey, setSelectedModelKey] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  const models = useProviderStore((s) => s.models)
  const currentModelKey = useProviderStore((s) => s.currentModelKey)
  const selectModel = useProviderStore((s) => s.selectModel)

  React.useEffect(() => {
    if (open) setMessage(initialMessage ?? '')
  }, [open, initialMessage])

  React.useEffect(() => {
    if (!open || !teamId) {
      setCandidates([])
      setPicked(new Set())
      setQuery('')
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    setPicked(new Set())

    function applyRows(rows: { id: string; actorType: string; displayName: string }[]) {
      const mapped = rows
        .filter((r) => r.id !== currentMemberId)
        .filter((r) => r.actorType === 'member' || r.actorType === 'agent')
        .map<Candidate>((r) => ({
          id: r.id,
          actor_type: r.actorType as 'member' | 'agent',
          display_name: r.displayName,
        }))
      setCandidates(mapped)
      return mapped.length
    }

    void (async () => {
      try {
        const local = await loadActorsForTeam(teamId)
        if (cancelled) return
        const localCount = applyRows(local)
        setLoading(false)

        const synced = await syncActorsForTeam(teamId, { full: true })
        if (cancelled) return
        if (synced === 0 && localCount === 0) {
          const { data, error } = await supabase
            .from('actor_directory')
            .select('id, actor_type, display_name')
            .eq('team_id', teamId)
            .order('display_name', { ascending: true })
          if (cancelled) return
          if (error) throw error
          const remote = ((data ?? []) as Array<{ id: string; actor_type: string; display_name: string | null }>)
            .filter((r) => r.id !== currentMemberId)
            .filter((r) => r.actor_type === 'member' || r.actor_type === 'agent')
            .map<Candidate>((r) => ({
              id: r.id,
              actor_type: r.actor_type as 'member' | 'agent',
              display_name: r.display_name || '',
            }))
          setCandidates(remote)
          return
        }
        if (synced === 0) return
        const fresh = await loadActorsForTeam(teamId)
        if (cancelled) return
        applyRows(fresh)
      } catch (e) {
        if (cancelled) return
        console.error('[NewSessionDialog] load failed', e)
        setLoadError(true)
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, teamId, currentMemberId])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((c) => c.display_name.toLowerCase().includes(q))
  }, [candidates, query])

  const pickedActors = React.useMemo(
    () => candidates.filter((c) => picked.has(c.id)),
    [candidates, picked],
  )
  const pickedAgentCount = pickedActors.filter((p) => p.actor_type === 'agent').length
  const runtimeModels = React.useMemo(
    () => models.filter((m) => RUNTIME_BACKENDS.has(m.provider)),
    [models],
  )
  const backends = React.useMemo(
    () => Array.from(new Set(runtimeModels.map((m) => m.provider))),
    [runtimeModels],
  )
  const backendModels = React.useMemo(
    () => runtimeModels.filter((m) => m.provider === selectedBackend),
    [runtimeModels, selectedBackend],
  )

  React.useEffect(() => {
    if (!open) return
    if (selectedBackend && backends.includes(selectedBackend)) return
    const currentBackend = currentModelKey?.split('/')[0]
    if (currentBackend && backends.includes(currentBackend)) {
      setSelectedBackend(currentBackend)
      return
    }
    setSelectedBackend(backends[0] ?? '')
  }, [open, backends, currentModelKey, selectedBackend])

  React.useEffect(() => {
    if (!open) return
    if (selectedModelKey && backendModels.some((m) => `${m.provider}/${m.id}` === selectedModelKey)) return
    const currentInBackend =
      currentModelKey && backendModels.some((m) => `${m.provider}/${m.id}` === currentModelKey)
        ? currentModelKey
        : ''
    setSelectedModelKey(currentInBackend || (backendModels[0] ? `${backendModels[0].provider}/${backendModels[0].id}` : ''))
  }, [open, backendModels, currentModelKey, selectedModelKey])

  const selectedModel = React.useMemo(() => {
    if (!selectedModelKey) return null
    const idx = selectedModelKey.indexOf('/')
    if (idx < 0) return null
    const provider = selectedModelKey.slice(0, idx)
    const id = selectedModelKey.slice(idx + 1)
    return runtimeModels.find((m) => m.provider === provider && m.id === id) ?? null
  }, [runtimeModels, selectedModelKey])

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const clearPicks = () => setPicked(new Set())

  const canSubmit =
    message.trim().length > 0 &&
    !submitting &&
    (pickedAgentCount === 0 || !!selectedModel)

  const handleClose = () => {
    if (submitting) return
    closeDialog()
  }

  const handleCreate = async () => {
    if (!canSubmit || !teamId) return
    const authSession = useAuthStore.getState().session
    if (!authSession?.user?.id) return
    setSubmitting(true)
    try {
      const creatorActorId = await resolveCurrentMemberActorId(
        teamId,
        authSession.user.id,
        {
          currentTeamId: teamId,
          currentMemberId,
        },
      )
      if (!creatorActorId) {
        const { toast } = await import('sonner')
        toast.error(t('chat.newSessionDialog.noActorError', 'No member identity found for this team'))
        return
      }
      const additionalActorIds = Array.from(picked)
      const agentActorIds = pickedActors.filter((p) => p.actor_type === 'agent').map((p) => p.id)
      if (agentActorIds.length > 0 && !selectedModel) return
      if (selectedModel) {
        await selectModel(selectedModel.provider, selectedModel.id, selectedModel.name)
      }
      const { sessionId } = await createSessionWithFirstMessage({
        teamId,
        creatorActorId,
        additionalActorIds,
        agentActorIds,
        messageText: message,
        agentType: selectedModel ? resolveAmuxAgentType(selectedModel.provider) : undefined,
        modelId: selectedModel?.id,
      })
      await ensureSessionLiveSubscribed(teamId, sessionId)
      await useSessionListStore.getState().load()
      useSessionStore.getState().addHighlightedSession(sessionId)
      await useUIStore.getState().switchToSession(sessionId)
      closeDialog()
    } catch (e) {
      console.error('[NewSessionDialog] create failed:', e)
      const { toast } = await import('sonner')
      toast.error(t('chat.newSessionDialog.createError', 'Failed to create session'))
    } finally {
      setSubmitting(false)
    }
  }

  // ⌘↵ submits.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleCreate()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose() }}>
      <DialogContent
        className="sm:max-w-[560px] p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-coral-soft text-coral">
            <Pencil className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[16px] font-semibold leading-tight">
              {t('chat.newSessionDialog.title', '新会话')}
              <span className="ml-2 text-[13px] font-normal text-muted-foreground">
                {t('chat.newSessionDialog.subtitle', '从一条消息开始')}
              </span>
            </DialogTitle>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('common.close', 'Close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Participants chips */}
        <div className="px-5 pt-2 pb-3">
          <div className="flex items-center justify-between pb-2">
            <div className="text-[12px] text-muted-foreground">
              {t('chat.newSessionDialog.participants', '参与者')}
              <span className="mx-1.5 text-faint">·</span>
              <span className="font-mono tabular-nums">{pickedActors.length}</span>
            </div>
            {pickedActors.length > 0 && (
              <button
                type="button"
                onClick={clearPicks}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                {t('chat.newSessionDialog.clear', '清空')}
              </button>
            )}
          </div>
          {pickedActors.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-2">
              {pickedActors.map((p) => (
                <ParticipantChip key={p.id} actor={p} onRemove={() => togglePick(p.id)} />
              ))}
            </div>
          )}
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('chat.newSessionDialog.searchPlaceholder', '搜索成员或 Agent…')}
              className="h-9 w-full rounded-lg border border-border bg-muted/30 pl-9 pr-3 text-[13px] outline-none placeholder:text-muted-foreground focus:border-foreground/30"
            />
          </div>
        </div>

        {/* Backend + Model */}
        <div className="border-t border-border-soft px-5 py-3">
          {runtimeModels.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
              <div>
                <label className="block pb-1.5 text-[12px] text-muted-foreground">
                  {t('chat.newSessionDialog.backend', 'Backend')}
                </label>
                <Select value={selectedBackend} onValueChange={setSelectedBackend}>
                  <SelectTrigger className="h-9 rounded-lg border-border bg-muted/20 text-[13px]">
                    <SelectValue placeholder={t('chat.newSessionDialog.backendPlaceholder', '选择 backend')} />
                  </SelectTrigger>
                  <SelectContent>
                    {backends.map((backend) => (
                      <SelectItem key={backend} value={backend}>
                        <span className="font-mono text-[12px]">{backend}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="block pb-1.5 text-[12px] text-muted-foreground">
                  {t('chat.newSessionDialog.model', '模型')}
                </label>
                <Select
                  value={selectedModelKey}
                  onValueChange={setSelectedModelKey}
                  disabled={!selectedBackend || backendModels.length === 0}
                >
                  <SelectTrigger className="h-9 rounded-lg border-border bg-muted/20 text-[13px]">
                    <SelectValue placeholder={t('chat.newSessionDialog.modelPlaceholder', '选择模型')} />
                  </SelectTrigger>
                  <SelectContent>
                    {backendModels.map((model) => {
                      const key = `${model.provider}/${model.id}`
                      return (
                        <SelectItem key={key} value={key}>
                          {model.name}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
              {t('chat.newSessionDialog.noModels', '等待 daemon 上报可用模型…')}
            </div>
          )}
        </div>

        {/* Candidate list */}
        <div className="max-h-[260px] min-h-[120px] overflow-y-auto border-y border-border bg-paper">
          {loading && (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('chat.newSessionDialog.loading', '加载中…')}
            </div>
          )}
          {loadError && (
            <div className="px-5 py-4 text-sm text-destructive">
              {t('chat.newSessionDialog.loadError', '加载失败')}
            </div>
          )}
          {!loading && !loadError && filtered.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              {candidates.length === 0
                ? t('chat.newSessionDialog.empty', '暂无成员或 Agent')
                : t('chat.newSessionDialog.noMatch', '没有匹配的结果')}
            </div>
          )}
          {!loading && !loadError && filtered.map((c) => (
            <CandidateRow
              key={c.id}
              candidate={c}
              checked={picked.has(c.id)}
              onToggle={() => togglePick(c.id)}
            />
          ))}
        </div>

        {/* Opening message */}
        <div className="px-5 pt-4 pb-3">
          <label className="block pb-2 text-[12px] text-muted-foreground">
            {t('chat.newSessionDialog.openingMessage', '开场消息')}
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t(
              'chat.newSessionDialog.messagePlaceholder',
              '想聊点什么？',
            )}
            rows={4}
            className="w-full resize-none rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-[13px] leading-[1.5] outline-none placeholder:text-muted-foreground focus:border-foreground/30"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClose}
            disabled={submitting}
          >
            {t('common.cancel', '取消')}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={!canSubmit}
            className="gap-2"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('chat.newSessionDialog.create', '创建会话')}
            <span className="rounded-md bg-black/15 px-1.5 py-px font-mono text-[10.5px] tracking-tight text-white/90">
              ⌘↵
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ParticipantChip({
  actor,
  onRemove,
}: {
  actor: Candidate
  onRemove: () => void
}) {
  const isAgent = actor.actor_type === 'agent'
  const c = actorAvatarColor(actor.id)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-paper py-0.5 pl-0.5 pr-1.5 text-[12px]',
      )}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center text-[10px] font-semibold',
          isAgent ? 'rounded' : 'rounded-full',
        )}
        style={{ background: c.bg, color: c.fg }}
      >
        {actor.display_name.slice(0, 1).toUpperCase()}
      </span>
      <span className="truncate font-medium">{actor.display_name}</span>
      {isAgent && (
        <span className="font-mono text-[9px] font-semibold tracking-wider text-coral">
          AI
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Remove participant"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: Candidate
  checked: boolean
  onToggle: () => void
}) {
  const isAgent = candidate.actor_type === 'agent'
  const c = actorAvatarColor(candidate.id)
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors',
        checked ? 'bg-coral-soft/40' : 'hover:bg-muted/40',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center text-[12px] font-semibold',
          isAgent ? 'rounded-md' : 'rounded-full',
        )}
        style={{ background: c.bg, color: c.fg }}
      >
        {candidate.display_name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground">
            {candidate.display_name}
          </span>
          {isAgent && (
            <span className="shrink-0 rounded border border-coral/40 bg-coral/10 px-1 py-px font-mono text-[9px] font-semibold tracking-wider text-coral">
              AI
            </span>
          )}
        </div>
      </div>
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
          checked
            ? 'border-coral bg-coral text-white'
            : 'border-border bg-paper',
        )}
        aria-hidden
      >
        {checked && (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none">
            <path d="M2.5 6.5L4.8 8.8L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    </button>
  )
}
