import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, Link2, Loader2, MessageCircle, Sparkles, User as UserIcon, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getBackend } from '@/lib/backend'
import { actorAvatarColor } from '@/lib/actor-color'
import { formatDate, formatRelativeTime } from '@/lib/date-format'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { useUIStore } from '@/stores/ui'
import { isActorOnline, type ActorRow } from '@/components/panel/ActorsView'
import { cn } from '@/lib/utils'

interface Props {
  actor: ActorRow | null
  teamId?: string | null
  onOpenChange: (open: boolean) => void
}

export function ActorDetailDialog({ actor, teamId, onOpenChange }: Props) {
  const { t } = useTranslation()
  const enterActorDraft = useUIStore((s) => s.enterActorDraft)
  const lastActorRef = React.useRef<ActorRow | null>(null)
  if (actor) lastActorRef.current = actor
  const displayActor = actor ?? lastActorRef.current

  const isAgent = displayActor?.actor_type === 'agent'
  const agentPresence = useActorPresenceStore((s) =>
    displayActor && isAgent ? s.byActorId[displayActor.id] : undefined,
  )

  const [reinviting, setReinviting] = React.useState(false)
  const [reinvite, setReinvite] = React.useState<{ deeplink: string; expiresAt: string } | null>(null)

  // Reset the re-invite result whenever the dialog targets a different actor
  // (or is reopened) so a stale link from a previous actor never leaks through.
  React.useEffect(() => {
    setReinvite(null)
    setReinviting(false)
  }, [actor?.id])

  if (!displayActor) return null

  const online = isAgent
    ? (agentPresence ? agentPresence.online : isActorOnline(displayActor.last_active_at))
    : isActorOnline(displayActor.last_active_at)
  const c = actorAvatarColor(displayActor.id)
  const lastActive = displayActor.last_active_at
    ? formatRelativeTime(new Date(displayActor.last_active_at))
    : null
  const actorTypeLabel = isAgent
    ? t('actors.detail.agent', 'Agent')
    : t('actors.detail.member', 'Member')
  const onlineLabel = online
    ? t('actors.detail.online', 'Online')
    : (lastActive
      ? t('actors.detail.lastActive', 'Last active {{when}}', { when: lastActive })
      : t('actors.detail.offline', 'Offline'))
  // Members carry a team role; agents carry a Team/Personal visibility. They are
  // mutually exclusive — never show a member's status string in the "role" slot.
  const roleLabel = !isAgent && displayActor.team_role
    ? t(`actors.role.${displayActor.team_role}`, displayActor.team_role)
    : null
  const visibilityLabel = isAgent && displayActor.visibility
    ? (displayActor.visibility === 'personal'
      ? t('actors.visibility.personal', 'Personal')
      : t('actors.visibility.team', 'Team'))
    : null
  const subtitleText = isAgent
    ? (visibilityLabel ? `${actorTypeLabel} · ${visibilityLabel}` : actorTypeLabel)
    : (roleLabel ?? actorTypeLabel)
  // An agent's supported-types row is noise when it just repeats the default type.
  const extraAgentTypes = isAgent && displayActor.agent_types
    ? displayActor.agent_types.filter((tp) => tp !== displayActor.default_agent_type)
    : []

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(displayActor.id)
      toast.success(t('actors.copiedId', 'Copied actor ID'))
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const startSession = () => {
    enterActorDraft({
      id: displayActor.id,
      displayName: displayActor.display_name,
      kind: displayActor.actor_type,
    })
    onOpenChange(false)
  }

  const regenerateInvite = async () => {
    if (!teamId || reinviting) return
    setReinviting(true)
    try {
      // targetActorId rotates credentials on this existing actor (re-invite)
      // instead of minting a new one — mirrors the iOS "Re-invite" flow.
      const row = isAgent
        ? await getBackend().teams.createTeamInvite({
            teamId,
            kind: 'agent',
            displayName: displayActor.display_name,
            agentKind: 'daemon',
            ttlSeconds: null,
            targetActorId: displayActor.id,
          })
        : await getBackend().teams.createTeamInvite({
            teamId,
            kind: 'member',
            displayName: displayActor.display_name,
            teamRole:
              displayActor.team_role === 'admin' || displayActor.team_role === 'owner'
                ? displayActor.team_role
                : 'member',
            ttlSeconds: null,
            targetActorId: displayActor.id,
          })
      const deeplink = row.deeplink ?? row.inviteUrl
      if (!deeplink) {
        toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg: 'empty response' }))
        return
      }
      setReinvite({
        deeplink,
        expiresAt: row.expiresAt ?? new Date(Date.now() + 604800 * 1000).toISOString(),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg }))
    } finally {
      setReinviting(false)
    }
  }

  const copyReinvite = async () => {
    if (!reinvite) return
    try {
      await navigator.clipboard.writeText(reinvite.deeplink)
      toast.success(t('invite.copied', 'Invite link copied'))
    } catch {
      toast.error(t('invite.copyFailed', 'Failed to copy invite link'))
    }
  }

  return (
    <Dialog open={!!actor} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] w-[min(760px,calc(100vw-3rem))] max-w-none flex-col overflow-hidden border-border bg-background p-0 shadow-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>
            {isAgent
              ? t('actors.detail.agentTitle', 'Agent details')
              : t('actors.detail.memberTitle', 'Member details')}
          </DialogTitle>
          <DialogDescription>
            {t('actors.detail.description', 'View actor profile and presence.')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-12">
          <div className="flex flex-col items-center text-center">
            <div className="relative">
              <div
                className={cn(
                  'flex h-24 w-24 shrink-0 items-center justify-center text-[38px] font-semibold text-white shadow-[0_8px_22px_-18px_rgba(26,26,20,0.45)]',
                  isAgent ? 'rounded-[24px] ring-[2px] ring-coral' : 'rounded-full',
                )}
                style={{ background: c.bg, color: c.fg }}
              >
                {displayActor.display_name?.slice(0, 1).toUpperCase()
                  || (isAgent ? <Sparkles className="h-9 w-9" /> : <UserIcon className="h-9 w-9" />)}
              </div>
              <span
                className={cn(
                  'absolute bottom-1 right-1 h-4 w-4 rounded-full ring-[3px] ring-background',
                  online ? 'bg-emerald-500' : 'bg-faint',
                )}
                aria-label={online ? t('actors.detail.online', 'Online') : t('actors.detail.offline', 'Offline')}
              />
            </div>

            <div className="mt-5 max-w-full truncate text-[24px] font-bold leading-tight text-foreground">
              {displayActor.display_name}
            </div>
            <div className="mt-2 text-[14px] leading-5 text-muted-foreground">
              {subtitleText}
            </div>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-border-soft bg-paper px-3 py-1.5 text-[12.5px] text-ink-2">
              <span className={cn('h-2 w-2 rounded-full', online ? 'bg-emerald-500' : 'bg-faint')} />
              <span>{onlineLabel}</span>
              {lastActive && (
                <>
                  <span className="text-faint">·</span>
                  <span className="font-mono text-[11.5px] text-faint">{lastActive}</span>
                </>
              )}
            </div>
          </div>

          <div className="mt-8 border-t border-border-soft pt-5">
            <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
              {t('actors.detail.details', 'Details')}
            </div>
            <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-5 gap-y-4 text-[13px] leading-5">
              {!isAgent && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.role', 'Role')}</dt>
                  <dd className="min-w-0 truncate text-foreground">{roleLabel ?? '—'}</dd>
                </>
              )}
              {!isAgent && displayActor.email && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.email', 'Email')}</dt>
                  <dd className="min-w-0 truncate text-foreground">
                    <a href={`mailto:${displayActor.email}`} className="hover:underline">{displayActor.email}</a>
                  </dd>
                </>
              )}
              {!isAgent && displayActor.phone && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.phone', 'Phone')}</dt>
                  <dd className="min-w-0 truncate text-foreground">
                    <a href={`tel:${displayActor.phone}`} className="hover:underline">{displayActor.phone}</a>
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('actors.detail.type', 'Type')}</dt>
              <dd className="min-w-0 truncate text-foreground">{actorTypeLabel}</dd>
              {isAgent && visibilityLabel && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.visibility', 'Visibility')}</dt>
                  <dd className="min-w-0 truncate text-foreground">{visibilityLabel}</dd>
                </>
              )}
              {isAgent && displayActor.default_agent_type && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.agentType', 'Agent type')}</dt>
                  <dd className="min-w-0 truncate text-foreground">{displayActor.default_agent_type}</dd>
                </>
              )}
              {isAgent && extraAgentTypes.length > 0 && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.supportedAgentTypes', 'Supported types')}</dt>
                  <dd className="min-w-0 text-foreground">
                    <div className="flex flex-wrap gap-1.5">
                      {extraAgentTypes.map((tp) => (
                        <span
                          key={tp}
                          className="rounded-md border border-border-soft bg-paper px-2 py-0.5 font-mono text-[11.5px] text-ink-2"
                        >
                          {tp}
                        </span>
                      ))}
                    </div>
                  </dd>
                </>
              )}
              {isAgent && displayActor.default_workspace_id && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.defaultWorkspace', 'Default workspace')}</dt>
                  <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">{displayActor.default_workspace_id}</dd>
                </>
              )}
              {displayActor.created_at && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.joined', 'Joined')}</dt>
                  <dd className="min-w-0 truncate text-foreground">{formatDate(displayActor.created_at)}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('actors.detail.lastActiveLabel', 'Last active')}</dt>
              <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">
                {lastActive ?? t('actors.detail.never', 'Never')}
              </dd>
              {teamId && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.teamId', 'Team ID')}</dt>
                  <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">{teamId}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('actors.detail.actorId', 'Actor ID')}</dt>
              <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">{displayActor.id}</dd>
            </dl>
          </div>

          {teamId && (
            <div className="mt-8 border-t border-border-soft pt-5">
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                {t('actors.reinvite.title', 'Re-invite')}
              </div>
              <p className="mb-4 text-[12px] leading-5 text-muted-foreground">
                {isAgent
                  ? t('actors.reinvite.agentHint', 'Use this if the daemon was wiped and needs to re-pair.')
                  : t(
                      'actors.reinvite.memberHint',
                      'Use this if the user signed out and lost access. Only available for anonymous accounts.',
                    )}
              </p>
              {reinvite ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Input value={reinvite.deeplink} readOnly className="font-mono text-xs" />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => void copyReinvite()}
                      title={t('invite.copy', 'Copy')}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t('invite.expiresAt', 'Expires {{date}}', {
                      date: new Date(reinvite.expiresAt).toLocaleString(),
                    })}
                  </p>
                </div>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => void regenerateInvite()}
                  disabled={reinviting}
                  className="h-9 rounded-[9px] border-border-soft bg-background text-[13px]"
                >
                  {reinviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                  {isAgent
                    ? t('actors.reinvite.agentButton', 'Regenerate invite link')
                    : t('actors.reinvite.memberButton', 'Generate re-invite link')}
                </Button>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex-row items-center gap-3 border-t border-border-soft bg-paper px-6 py-4 sm:justify-between">
          <Button
            onClick={startSession}
            className="h-10 flex-1 rounded-[9px] bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
          >
            <MessageCircle className="h-4 w-4" />
            {t('actors.detail.startSession', 'Start session')}
          </Button>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="icon"
              onClick={copyId}
              className="h-10 w-10 rounded-[9px] border-border-soft bg-background"
              aria-label={t('actors.detail.copyId', 'Copy ID')}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => onOpenChange(false)}
              className="h-10 w-10 rounded-[9px] border-border-soft bg-background"
              aria-label={t('common.close', 'Close')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
