import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox, AtSign, Hourglass, Pin } from 'lucide-react'
import { useUIStore } from '@/stores/ui'
import { useSessionStore } from '@/stores/session'
import { useCronStore } from '@/stores/cron'
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
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50',
        active && 'bg-muted/40 font-medium before:absolute before:left-0 before:top-1/2 before:h-[72%] before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-primary',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && (
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{badge}</span>
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

  const sessionsCount = React.useMemo(
    () => sessions.filter((s) => !s.parentID && !cronSessionIds.has(s.id)).length,
    [sessions, cronSessionIds],
  )

  const handleComingSoon = () => {
    void import('sonner').then((m) => m.toast(t('common.comingSoon', 'Coming soon')))
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-2 overflow-y-auto px-1.5 py-2">
      <div className="flex flex-col gap-0.5">
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
          label={t('sidebar.waitingOnMe', 'Waiting on me')}
          icon={Hourglass}
          onClick={handleComingSoon}
        />
        <TopEntry
          label={t('sidebar.pinned', 'Pinned')}
          icon={Pin}
          active={filter.kind === 'pinned'}
          onClick={() => setFilter({ kind: 'pinned' })}
        />
      </div>

      <IdeasSection />
      <ActorsSection />
    </div>
  )
}
