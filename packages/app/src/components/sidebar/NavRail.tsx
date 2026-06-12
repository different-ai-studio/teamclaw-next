import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox, Lightbulb, Keyboard, Pin } from 'lucide-react'
import { useUIStore } from '@/stores/ui'
import { useSessionListStore } from '@/stores/session-list-store'
import { useCronStore } from '@/stores/cron'
import { createQuickDaemonSession } from '@/lib/quick-daemon-session'
import { useQuickChatReadiness } from '@/hooks/use-quick-chat-readiness'
import { ActorsSection } from '@/components/sidebar/ActorsSection'
import { TeamShareNavSection } from '@/components/sidebar/TeamShareNavSection'
import { NewChatSplitButton } from '@/components/sidebar/NewChatSplitButton'
import { buildConfig } from '@/lib/build-config'
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
  const openDaemonAgentSettings = useUIStore((s) => s.openDaemonAgentSettings)
  const listRows = useSessionListStore((s) => s.rows)
  const pinnedSessionIds = useSessionListStore((s) => s.pinnedSessionIds)
  const cronSessionIds = useCronStore((s) => s.cronSessionIds)
  const quickChatState = useQuickChatReadiness()
  const [creating, setCreating] = React.useState(false)

  const sessionsCount = React.useMemo(
    () => listRows.filter((r) => !cronSessionIds.has(r.id)).length,
    [listRows, cronSessionIds],
  )

  const pinnedCount = React.useMemo(() => {
    const visibleIds = new Set(
      listRows.filter((r) => !cronSessionIds.has(r.id)).map((r) => r.id),
    )
    return pinnedSessionIds.filter((id) => visibleIds.has(id)).length
  }, [listRows, pinnedSessionIds, cronSessionIds])

  const handleQuickNewChat = React.useCallback(() => {
    if (quickChatState.kind === 'agent_not_bound') {
      openDaemonAgentSettings('quick_chat')
      return
    }
    if (quickChatState.kind !== 'ready' || creating) return

    setCreating(true)
    void createQuickDaemonSession()
      .then((result) => {
        if (!result) {
          return import('sonner').then(({ toast }) => {
            toast.error(t('chat.quickSessionCreateError', 'Could not start a session with your local agent'))
          })
        }
      })
      .catch((e) => {
        console.error('[NavRail] quick create failed', e)
        void import('sonner').then(({ toast }) => {
          toast.error(t('chat.quickSessionCreateError', 'Could not start a session with your local agent'))
        })
      })
      .finally(() => setCreating(false))
  }, [quickChatState, creating, openDaemonAgentSettings, t])

  // ⌘N — quick path with local amuxd agent (same as primary split button).
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        handleQuickNewChat()
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [handleQuickNewChat])

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-2 overflow-y-auto px-3 pt-0 pb-3">
      <NewChatSplitButton
        quickChatState={quickChatState}
        creating={creating}
        onPrimaryClick={handleQuickNewChat}
      />

      <div className="flex flex-col">
        <TopEntry
          label={t('sidebar.sessions', 'Sessions')}
          icon={Inbox}
          active={filter.kind === 'all'}
          badge={sessionsCount}
          onClick={() => setFilter({ kind: 'all' })}
        />
        <TopEntry
          label={t('sidebar.pinned', 'Pinned')}
          icon={Pin}
          active={filter.kind === 'pinned'}
          badge={pinnedCount}
          onClick={() => setFilter({ kind: 'pinned' })}
        />
        <TopEntry
          label={t('sidebar.ideas', 'Ideas')}
          icon={Lightbulb}
          active={filter.kind === 'ideas'}
          onClick={() => setFilter({ kind: 'ideas' })}
        />
        <TopEntry
          label={t('common.shortcuts', 'Shortcuts')}
          icon={Keyboard}
          active={filter.kind === 'shortcuts'}
          onClick={() => setFilter({ kind: 'shortcuts' })}
        />
      </div>

      {buildConfig.features.teamShareBrowser && <TeamShareNavSection />}

      <ActorsSection />
    </div>
  )
}
