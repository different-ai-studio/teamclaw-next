import type { ActorRow } from '@/components/panel/ActorsView'
import type { IdeaRow } from '@/components/panel/IdeasView'

export function getTopIdeas(ideas: IdeaRow[]): IdeaRow[] {
  return [...ideas]
    .sort((a, b) => {
      const bySortOrder = (a.sort_order ?? 0) - (b.sort_order ?? 0)
      if (bySortOrder !== 0) return bySortOrder
      const byUpdatedAt = b.updated_at.localeCompare(a.updated_at)
      if (byUpdatedAt !== 0) return byUpdatedAt
      return a.id.localeCompare(b.id)
    })
    .slice(0, 10)
}

export function getRecentContactActors(actors: ActorRow[], defaultAgentId?: string | null): ActorRow[] {
  const recents = [...actors]
    .filter((actor) => !!actor.last_active_at)
    .sort((a, b) => {
      const byLastActive = (b.last_active_at ?? '').localeCompare(a.last_active_at ?? '')
      if (byLastActive !== 0) return byLastActive
      return a.display_name.localeCompare(b.display_name)
    })
    .slice(0, 20)

  if (!defaultAgentId) return recents

  // Pin the default agent to the top of Recents, even if it has no recent
  // activity (it would otherwise be filtered out for lacking last_active_at).
  const defaultAgent = actors.find(
    (actor) => actor.id === defaultAgentId && actor.actor_type === 'agent',
  )
  if (!defaultAgent) return recents
  return [defaultAgent, ...recents.filter((actor) => actor.id !== defaultAgentId)].slice(0, 20)
}
