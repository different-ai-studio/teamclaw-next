import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, MessageCircle, Sparkles, User as UserIcon, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { actorAvatarColor } from '@/lib/actor-color'
import { formatRelativeTime } from '@/lib/date-format'
import { useDevicePresenceStore } from '@/stores/device-presence-store'
import { useUIStore } from '@/stores/ui'
import { isActorOnline, type ActorRow } from '@/components/panel/ActorsView'
import { cn } from '@/lib/utils'

interface Props {
  actor: ActorRow | null
  onOpenChange: (open: boolean) => void
}

export function ActorDetailDialog({ actor, onOpenChange }: Props) {
  const { t } = useTranslation()
  const enterActorDraft = useUIStore((s) => s.enterActorDraft)
  const lastActorRef = React.useRef<ActorRow | null>(null)
  if (actor) lastActorRef.current = actor
  const displayActor = actor ?? lastActorRef.current

  const isAgent = displayActor?.actor_type === 'agent'
  const agentPresence = useDevicePresenceStore((s) =>
    displayActor && isAgent ? s.byDeviceId[displayActor.id] : undefined,
  )

  if (!displayActor) return null

  const online = isAgent
    ? (agentPresence ? agentPresence.online : isActorOnline(displayActor.last_active_at))
    : isActorOnline(displayActor.last_active_at)
  const status = isAgent ? displayActor.agent_status : displayActor.member_status
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
              <span className={cn(
                'absolute bottom-2 right-0 h-4 w-4 rounded-full ring-[3px] ring-background',
                isAgent ? 'bg-coral' : online ? 'bg-emerald-500' : 'bg-faint',
              )} />
            </div>

            <div className="mt-5 max-w-full truncate text-[24px] font-bold leading-tight text-foreground">
              {displayActor.display_name}
            </div>
            <div className="mt-2 text-[14px] leading-5 text-muted-foreground">
              {status || actorTypeLabel}
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
              <dt className="text-muted-foreground">{t('actors.detail.role', 'Role')}</dt>
              <dd className="min-w-0 truncate text-foreground">{status || actorTypeLabel}</dd>
              <dt className="text-muted-foreground">{t('actors.detail.type', 'Type')}</dt>
              <dd className="min-w-0 truncate text-foreground">{actorTypeLabel}</dd>
              <dt className="text-muted-foreground">{t('actors.detail.lastActiveLabel', 'Last active')}</dt>
              <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">
                {lastActive ?? t('actors.detail.never', 'Never')}
              </dd>
              <dt className="text-muted-foreground">{t('actors.detail.actorId', 'Actor ID')}</dt>
              <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">{displayActor.id}</dd>
            </dl>
          </div>
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
