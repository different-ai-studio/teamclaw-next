import { useUIStore } from '@/stores/ui'
import { ActorsView, IdeasView } from '@/components/panel'
import { SessionListColumn } from './SessionListColumn'
import { ShortcutsListColumn } from './ShortcutsListColumn'
import { TeamShareListColumn } from './TeamShareListColumn'
import { buildConfig } from '@/lib/build-config'

export function SidebarSecondColumn() {
  const filter = useUIStore((s) => s.sidebarFilter)
  if (filter.kind === 'shortcuts') return <ShortcutsListColumn />
  if (filter.kind === 'ideas') return <IdeasView />
  if (filter.kind === 'actors') return <ActorsView />
  if (filter.kind === 'teamShare' && buildConfig.features.teamShareBrowser)
    return <TeamShareListColumn section={filter.section} />
  return <SessionListColumn />
}
