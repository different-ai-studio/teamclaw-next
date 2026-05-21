import { supabase } from '@/lib/supabase-client'

export type IdeaStatus = 'open' | 'in_progress' | 'done'

interface IdeaForUpdate {
  workspace_id: string | null
  title: string
  description: string | null
  status: IdeaStatus | null
}

async function fetchIdeaForUpdate(ideaId: string): Promise<IdeaForUpdate> {
  const { data, error } = await supabase
    .from('ideas')
    .select('workspace_id, title, description, status')
    .eq('id', ideaId)
    .single()
  if (error) throw error
  if (!data) throw new Error('idea not found')
  return data as IdeaForUpdate
}

export async function updateIdeaStatus(ideaId: string, status: IdeaStatus): Promise<void> {
  const cur = await fetchIdeaForUpdate(ideaId)
  const { error } = await supabase.rpc('update_idea', {
    p_idea_id: ideaId,
    p_workspace_id: cur.workspace_id,
    p_title: cur.title,
    p_description: cur.description,
    p_status: status,
  })
  if (error) throw error
}

export async function renameIdea(ideaId: string, title: string): Promise<void> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error('title is required')
  const cur = await fetchIdeaForUpdate(ideaId)
  const { error } = await supabase.rpc('update_idea', {
    p_idea_id: ideaId,
    p_workspace_id: cur.workspace_id,
    p_title: trimmed,
    p_description: cur.description,
    p_status: cur.status ?? 'open',
  })
  if (error) throw error
}
