import { supabase } from '@/lib/supabase-client'

export interface DaemonRuntime {
  id: string
  runtimeId: string | null
  teamId: string
  agentId: string
  agentName: string
  sessionId: string | null
  sessionTitle: string | null
  workspaceId: string | null
  workspaceName: string | null
  workspacePath: string | null
  backendType: string
  backendSessionId: string | null
  status: string
  currentModel: string | null
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

type RuntimeRow = {
  id: string
  runtime_id: string | null
  team_id: string
  agent_id: string
  session_id: string | null
  workspace_id: string | null
  backend_type: string
  backend_session_id: string | null
  status: string
  current_model: string | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export async function listDaemonRuntimes(teamId: string): Promise<DaemonRuntime[]> {
  const { data: runtimeRows, error } = await supabase
    .from('agent_runtimes')
    .select('id, runtime_id, team_id, agent_id, session_id, workspace_id, backend_type, backend_session_id, status, current_model, last_seen_at, created_at, updated_at')
    .eq('team_id', teamId)
    .order('updated_at', { ascending: false })

  if (error) throw new Error(error.message)

  const rows = (runtimeRows ?? []) as RuntimeRow[]
  if (rows.length === 0) return []

  const agentIds = [...new Set(rows.map((row) => row.agent_id))]
  const sessionIds = [...new Set(rows.map((row) => row.session_id).filter((id): id is string => Boolean(id)))]
  const workspaceIds = [...new Set(rows.map((row) => row.workspace_id).filter((id): id is string => Boolean(id)))]

  const [agentsResult, sessionsResult, workspacesResult] = await Promise.all([
    supabase
      .from('actor_directory')
      .select('id, display_name')
      .eq('team_id', teamId)
      .in('id', agentIds),
    sessionIds.length > 0
      ? supabase.from('sessions').select('id, title').eq('team_id', teamId).in('id', sessionIds)
      : Promise.resolve({ data: [], error: null }),
    workspaceIds.length > 0
      ? supabase.from('workspaces').select('id, name, path').eq('team_id', teamId).in('id', workspaceIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (agentsResult.error) throw new Error(agentsResult.error.message)
  if (sessionsResult.error) throw new Error(sessionsResult.error.message)
  if (workspacesResult.error) throw new Error(workspacesResult.error.message)

  const agents = new Map((agentsResult.data ?? []).map((row: any) => [row.id, row.display_name || row.id]))
  const sessions = new Map((sessionsResult.data ?? []).map((row: any) => [row.id, row.title || row.id]))
  const workspaces = new Map((workspacesResult.data ?? []).map((row: any) => [row.id, {
    name: row.name || row.id,
    path: row.path ?? null,
  }]))

  return rows.map((row) => {
    const workspace = row.workspace_id ? workspaces.get(row.workspace_id) : null
    return {
      id: row.id,
      runtimeId: row.runtime_id ?? null,
      teamId: row.team_id,
      agentId: row.agent_id,
      agentName: agents.get(row.agent_id) ?? row.agent_id,
      sessionId: row.session_id ?? null,
      sessionTitle: row.session_id ? sessions.get(row.session_id) ?? row.session_id : null,
      workspaceId: row.workspace_id ?? null,
      workspaceName: workspace?.name ?? null,
      workspacePath: workspace?.path ?? null,
      backendType: row.backend_type,
      backendSessionId: row.backend_session_id ?? null,
      status: row.status,
      currentModel: row.current_model ?? null,
      lastSeenAt: row.last_seen_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  })
}
