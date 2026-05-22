import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, Sparkles, User as UserIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { actorAvatarColor } from '@/lib/actor-color'
import { formatRelativeTime } from '@/lib/date-format'
import { useDevicePresenceStore } from '@/stores/device-presence-store'
import { isActorOnline, type ActorRow } from '@/components/panel/ActorsView'
import { cn } from '@/lib/utils'

interface Props {
  actor: ActorRow | null
  onOpenChange: (open: boolean) => void
}

export function ActorDetailDialog({ actor, onOpenChange }: Props) {
  const { t } = useTranslation()
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

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(displayActor.id)
      toast.success(t('actors.copiedId', 'Copied actor ID'))
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  return (
    <Dialog open={!!actor} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('actors.detail.title', 'Actor details')}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-3 py-2">
          <div
            className={cn(
              'flex h-12 w-12 shrink-0 items-center justify-center text-sm font-semibold',
              isAgent ? 'rounded-md' : 'rounded-full',
            )}
            style={{ background: c.bg, color: c.fg }}
          >
            {displayActor.display_name?.slice(0, 1).toUpperCase()
              || (isAgent ? <Sparkles className="h-5 w-5" /> : <UserIcon className="h-5 w-5" />)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold">{displayActor.display_name}</div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{isAgent
                ? t('actors.detail.agent', 'Agent')
                : t('actors.detail.member', 'Member')}</span>
              <span>·</span>
              <span className={cn('inline-flex items-center gap-1', online && 'text-emerald-600 dark:text-emerald-400')}>
                <span className={cn('h-1.5 w-1.5 rounded-full', online ? 'bg-emerald-500' : 'bg-muted-foreground/50')} />
                {online
                  ? t('actors.detail.online', 'Online')
                  : (lastActive
                    ? t('actors.detail.lastActive', 'Last active {{when}}', { when: lastActive })
                    : t('actors.detail.offline', 'Offline'))}
              </span>
            </div>
            {status && <div className="mt-1 truncate text-xs text-muted-foreground">{status}</div>}
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" size="sm" onClick={copyId}>
            <Copy className="h-3.5 w-3.5" />
            {t('actors.detail.copyId', 'Copy ID')}
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t('common.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
