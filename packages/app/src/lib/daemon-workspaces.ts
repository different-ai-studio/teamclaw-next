import { supabase } from '@/lib/supabase-client'
import { getBackend } from '@/lib/backend'
import { getCurrentDaemonAgent } from '@/lib/daemon-agent-admin'

export interface DaemonWorkspace {
  id: string
  teamId: string
  agentId: string | null
  createdByMemberId: string | null
  name: string
  path: string | null
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface DaemonAgent {
  id: string
  displayName: string
  agentTypes: string[]
  defaultAgentType: string | null
  defaultWorkspaceId: string | null
  status: string | null
  lastActiveAt: string | null
}

function normalizeAgentTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function mapWorkspace(row: any): DaemonWorkspace {
  return {
    id: row.id,
    teamId: row.team_id,
    agentId: row.agent_id ?? null,
    createdByMemberId: row.created_by_member_id ?? null,
    name: row.name,
    path: row.path ?? null,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listDaemonAgents(teamId: string): Promise<DaemonAgent[]> {
  const connectedRows = await getBackend().actors.listConnectedAgents(teamId)

  const connectedIds = connectedRows
    .map((row) => row.agent_id ?? row.id)
    .filter((id: unknown): id is string => typeof id === 'string')

  if (connectedIds.length === 0) return []

  const { data, error } = await supabase
    .from('actor_directory')
    .select('id, display_name, agent_types, default_agent_type, default_workspace_id, agent_status, last_active_at')
    .eq('team_id', teamId)
    .eq('actor_type', 'agent')
    .in('id', connectedIds)
    .order('display_name', { ascending: true })

  if (error) throw new Error(error.message)

  return (data ?? []).map((row: any) => ({
    id: row.id,
    displayName: row.display_name || row.id,
    agentTypes: normalizeAgentTypes(row.agent_types),
    defaultAgentType: row.default_agent_type ?? null,
    defaultWorkspaceId: row.default_workspace_id ?? null,
    status: row.agent_status ?? null,
    lastActiveAt: row.last_active_at ?? null,
  }))
}

export async function getCurrentDaemonWorkspaceAgent(teamId: string): Promise<DaemonAgent | null> {
  const agent = await getCurrentDaemonAgent(teamId)
  if (!agent) return null
  return {
    id: agent.id,
    displayName: agent.displayName,
    agentTypes: agent.agentTypes,
    defaultAgentType: agent.defaultAgentType,
    defaultWorkspaceId: agent.defaultWorkspaceId,
    status: agent.status ?? null,
    lastActiveAt: agent.lastActiveAt,
  }
}

export async function listDaemonWorkspaces(teamId: string, agentId?: string | null): Promise<DaemonWorkspace[]> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('id, team_id, agent_id, created_by_member_id, name, path, archived, created_at, updated_at')
    .eq('team_id', teamId)
    .eq('agent_id', agentId ?? '')
    .order('archived', { ascending: true })
    .order('updated_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []).map(mapWorkspace)
}

export async function createDaemonWorkspace(input: {
  teamId: string
  agentId: string
  createdByMemberId: string | null
  name: string
  path: string
}): Promise<DaemonWorkspace> {
  const { data, error } = await supabase
    .from('workspaces')
    .insert({
      team_id: input.teamId,
      agent_id: input.agentId,
      created_by_member_id: input.createdByMemberId,
      name: input.name,
      path: input.path,
      archived: false,
    })
    .select('id, team_id, agent_id, created_by_member_id, name, path, archived, created_at, updated_at')
    .single()

  if (error) throw new Error(error.message)
  return mapWorkspace(data)
}

export async function updateDaemonWorkspace(input: {
  workspaceId: string
  name: string
  path: string
  archived: boolean
}): Promise<DaemonWorkspace> {
  const { data, error } = await supabase
    .from('workspaces')
    .update({
      name: input.name,
      path: input.path,
      archived: input.archived,
    })
    .eq('id', input.workspaceId)
    .select('id, team_id, agent_id, created_by_member_id, name, path, archived, created_at, updated_at')
    .single()

  if (error) throw new Error(error.message)
  return mapWorkspace(data)
}

export async function setAgentDefaultWorkspace(agentId: string, workspaceId: string): Promise<void> {
  await getBackend().actors.updateAgentDefaults({
    agentId,
    defaultWorkspaceId: workspaceId,
    agentKind: null,
  })
}
