import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox, AtSign, Keyboard, Pin, SquarePen } from 'lucide-react'
import { useUIStore } from '@/stores/ui'
import { useSessionStore } from '@/stores/session'
import { useCronStore } from '@/stores/cron'
import { useWorkspaceStore } from '@/stores/workspace'
import { IdeasSection } from '@/components/sidebar/IdeasSection'
import { ActorsSection } from '@/components/sidebar/ActorsSection'
import { cn } from '@/lib/utils'

interface TopEntryProps {
  label: string
  icon: React.ComponentType<{ className?: string }>
  active?: boolean
  badge?: number | null
  onClick: () => void
}

function TopEntry({ label, icon: Icon, active, badge, onClick }: TopEntryProps) {
  // Direction B quick-link row: tight 7×9 padding, selected (#e7e2d6) fill on
  // active, no left bar. The coral left bar is reserved for session cards in
  // the middle column. See AGENTS.md §2 "Sidebar".
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-[9px] py-[7px] text-left text-[13px] transition-colors',
        active
          ? 'bg-selected font-semibold text-foreground'
          : 'text-ink-2 hover:bg-selected/60',
      )}
    >
      <Icon
        className={cn('h-[15px] w-[15px] shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
          {badge}
        </span>
      )}
    </button>
  )
}

export function NavRail() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const sessions = useSessionStore((s) => s.sessions)
  const cronSessionIds = useCronStore((s) => s.cronSessionIds)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const hasWorkspace = !!workspacePath

  const sessionsCount = React.useMemo(
    () => sessions.filter((s) => !s.parentID && !cronSessionIds.has(s.id)).length,
    [sessions, cronSessionIds],
  )

  const handleComingSoon = () => {
    void import('sonner').then((m) => m.toast(t('common.comingSoon', 'Coming soon')))
  }

  const handleNewChat = React.useCallback(() => {
    if (!hasWorkspace) return
    useUIStore.getState().openNewSessionDialog()
  }, [hasWorkspace])

  // ⌘N opens the new-session dialog (mirrors the hint shown on the button).
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        handleNewChat()
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [handleNewChat])

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-2 overflow-y-auto px-3 pt-0 pb-3">
      <button
        type="button"
        onClick={handleNewChat}
        disabled={!hasWorkspace}
        className={cn(
          'flex w-full items-center gap-2 rounded-xl bg-coral px-3 py-2.5 text-left text-[14px] font-semibold text-white shadow-sm transition-colors',
          'hover:bg-coral/90 disabled:opacity-40 disabled:cursor-not-allowed',
        )}
      >
        <SquarePen className="h-[16px] w-[16px] shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t('chat.newChat', 'New Chat')}</span>
        <span className="shrink-0 rounded-md bg-black/15 px-1.5 py-0.5 font-mono text-[11px] font-medium tracking-tight text-white/95">
          ⌘N
        </span>
      </button>

      <div className="flex flex-col">
        <TopEntry
          label={t('sidebar.sessions', 'Sessions')}
          icon={Inbox}
          active={filter.kind === 'all'}
          badge={sessionsCount}
          onClick={() => setFilter({ kind: 'all' })}
        />
        <TopEntry
          label={t('sidebar.mentions', '@Mentions')}
          icon={AtSign}
          onClick={handleComingSoon}
        />
        <TopEntry
          label={t('sidebar.pinned', 'Pinned')}
          icon={Pin}
          active={filter.kind === 'pinned'}
          onClick={() => setFilter({ kind: 'pinned' })}
        />
        <TopEntry
          label={t('common.shortcuts', 'Shortcuts')}
          icon={Keyboard}
          active={filter.kind === 'shortcuts'}
          onClick={() => setFilter({ kind: 'shortcuts' })}
        />
      </div>

      <IdeasSection />
      <ActorsSection />
    </div>
  )
}
