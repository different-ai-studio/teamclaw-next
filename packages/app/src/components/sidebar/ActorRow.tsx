import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Sparkles, User as UserIcon, UserMinus } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import type { ActorRow as ActorRowData } from '@/components/panel/ActorsView'
import { isActorOnline } from '@/components/panel/ActorsView'
import { actorAvatarColor } from '@/lib/actor-color'
import { cn } from '@/lib/utils'

interface Props {
  actor: ActorRowData
  active: boolean
  onSelect: (actor: ActorRowData) => void
  onViewDetail: (actor: ActorRowData) => void
  onCopyName: (actor: ActorRowData) => void
  onCopyId: (actor: ActorRowData) => void
  onRequestRemove: (actor: ActorRowData) => void
}

export function ActorRow({
  actor,
  active,
  onSelect,
  onViewDetail,
  onCopyName,
  onCopyId,
  onRequestRemove,
}: Props) {
  const { t } = useTranslation()
  const isAgent = actor.actor_type === 'agent'
  const online = isActorOnline(actor.last_active_at)
  const c = actorAvatarColor(actor.id)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(actor)}
          className={cn(
            'flex w-full items-center gap-[9px] rounded-md px-[9px] py-[5px] text-left text-[12.5px] transition-colors',
            active ? 'bg-selected font-semibold text-foreground' : 'text-ink-2 hover:bg-selected/60',
          )}
        >
          <div
            className={cn(
              'relative flex h-5 w-5 shrink-0 items-center justify-center text-[10px] font-semibold',
              isAgent ? 'rounded' : 'rounded-full',
            )}
            style={{ background: c.bg, color: c.fg }}
          >
            {actor.display_name?.slice(0, 1).toUpperCase()
              || (isAgent ? <Sparkles className="h-3 w-3" /> : <UserIcon className="h-3 w-3" />)}
            {online && (
              <span className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-paper" />
            )}
          </div>
          <span className="min-w-0 flex-1 truncate">{actor.display_name}</span>
          {isAgent && (
            <span className="shrink-0 font-mono text-[9px] font-semibold tracking-wider text-coral">Agent</span>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => onViewDetail(actor)}>
          <UserIcon className="h-4 w-4" />
          {t('actors.contextMenu.viewProfile', 'View profile')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCopyName(actor)}>
          <Copy className="h-4 w-4" />
          {t('actors.contextMenu.copyName', 'Copy name')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCopyId(actor)}>
          <Copy className="h-4 w-4" />
          {t('actors.contextMenu.copyId', 'Copy ID')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onRequestRemove(actor)}>
          <UserMinus className="h-4 w-4" />
          {t('actors.contextMenu.remove', 'Remove from team')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
