import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, Copy, Eye, Pencil, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
} from '@/components/ui/context-menu'
import type { IdeaRow as IdeaRowData } from '@/components/panel/IdeasView'
import type { IdeaStatus } from '@/lib/idea-mutations'
import { cn } from '@/lib/utils'

interface Props {
  idea: IdeaRowData
  active: boolean
  onSelect: (idea: IdeaRowData) => void
  onChangeStatus: (idea: IdeaRowData, status: IdeaStatus) => void
  onRequestRename: (idea: IdeaRowData) => void
  onCopyId: (idea: IdeaRowData) => void
  onRequestDelete: (idea: IdeaRowData) => void
}

function statusBadge(status: IdeaRowData['status']): { label: string; tone: string } {
  if (status === 'in_progress') return { label: 'active', tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' }
  if (status === 'done') return { label: 'done', tone: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' }
  return { label: 'open', tone: 'bg-muted text-muted-foreground' }
}

export function IdeaRow({
  idea,
  active,
  onSelect,
  onChangeStatus,
  onRequestRename,
  onCopyId,
  onRequestDelete,
}: Props) {
  const { t } = useTranslation()
  const { label, tone } = statusBadge(idea.status)
  const radioValue: IdeaStatus = (idea.status as IdeaStatus | null) ?? 'open'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(idea)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-[9px] py-[5px] text-left text-[12.5px] transition-colors',
            active ? 'bg-selected font-semibold text-foreground' : 'text-ink-2 hover:bg-selected/60',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{idea.title}</span>
          <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium', tone)}>{label}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onSelect(idea)}>
          <Eye className="h-4 w-4" />
          {t('ideas.contextMenu.view', 'View')}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Circle className="h-4 w-4" />
            {t('ideas.contextMenu.status', 'Status')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup
              value={radioValue}
              onValueChange={(v) => onChangeStatus(idea, v as IdeaStatus)}
            >
              <ContextMenuRadioItem value="open">
                {t('ideas.contextMenu.statusOpen', 'Open')}
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="in_progress">
                {t('ideas.contextMenu.statusInProgress', 'In progress')}
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="done">
                {t('ideas.contextMenu.statusDone', 'Done')}
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={() => onRequestRename(idea)}>
          <Pencil className="h-4 w-4" />
          {t('ideas.contextMenu.rename', 'Rename')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCopyId(idea)}>
          <Copy className="h-4 w-4" />
          {t('ideas.contextMenu.copyId', 'Copy ID')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onRequestDelete(idea)}>
          <Trash2 className="h-4 w-4" />
          {t('ideas.contextMenu.delete', 'Delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
