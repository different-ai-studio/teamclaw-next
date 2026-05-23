import { supabase } from '@/lib/supabase-client'

export type IdeaStatus = 'open' | 'in_progress' | 'done'

interface IdeaForUpdate {
  workspace_id: string | null
  title: string
  description: string | null
  status: IdeaStatus | null
}

interface IdeaUpdateInput {
  workspaceId: string | null
  title: string
  description: string | null
  status: IdeaStatus
}

interface IdeaActivityInput {
  activityType: 'progress' | 'status_change' | 'reorder'
  content: string
  metadata?: Record<string, string>
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
  await updateIdea(ideaId, {
    workspaceId: cur.workspace_id,
    title: cur.title,
    description: cur.description,
    status,
  })
}

export async function renameIdea(ideaId: string, title: string): Promise<void> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error('title is required')
  const cur = await fetchIdeaForUpdate(ideaId)
  await updateIdea(ideaId, {
    workspaceId: cur.workspace_id,
    title: trimmed,
    description: cur.description,
    status: cur.status ?? 'open',
  })
}

export async function updateIdea(ideaId: string, input: IdeaUpdateInput): Promise<void> {
  const trimmed = input.title.trim()
  if (!trimmed) throw new Error('title is required')
  const { error } = await supabase.rpc('update_idea', {
    p_idea_id: ideaId,
    p_workspace_id: input.workspaceId,
    p_title: trimmed,
    p_description: input.description,
    p_status: input.status,
  })
  if (error) throw error
}

export async function createIdeaActivity(ideaId: string, input: IdeaActivityInput): Promise<void> {
  const { error } = await supabase.rpc('create_idea_activity', {
    p_idea_id: ideaId,
    p_activity_type: input.activityType,
    p_content: input.content,
    p_metadata: input.metadata ?? {},
  })
  if (error) throw error
}
