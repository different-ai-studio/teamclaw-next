import { invoke } from '@tauri-apps/api/core'
import { supabase } from '@/lib/supabase-client'

export type AgentPermissionLevel = 'view' | 'prompt' | 'admin'
export type AgentVisibility = 'personal' | 'team'

export interface CurrentDaemonAgent {
  id: string
  displayName: string
  deviceId: string | null
  visibility: AgentVisibility
  permissionLevel: AgentPermissionLevel | null
  isOwner: boolean
  status: string | null
  agentTypes: string[]
  defaultAgentType: string | null
  defaultWorkspaceId: string | null
  lastActiveAt: string | null
}

export interface AgentAccessRow {
  id: string
  agentId: string
  memberId: string
  memberName: string
  permissionLevel: AgentPermissionLevel
  grantedByMemberId: string | null
  createdAt: string
  updatedAt: string
}

export interface TeamMemberOption {
  id: string
  displayName: string
  role: string | null
}

function normalizeAgentTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export async function getLocalDaemonDeviceId(): Promise<string | null> {
  try {
    const info = await invoke<{ nodeId: string }>('get_device_info')
    return info.nodeId || null
  } catch {
    return null
  }
}

export async function getCurrentDaemonAgent(teamId: string): Promise<CurrentDaemonAgent | null> {
  const deviceId = await getLocalDaemonDeviceId()
  const { data, error } = await supabase.rpc('list_connected_agents', { p_team_id: teamId })
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as Array<{
    agent_id: string
    display_name: string | null
    agent_types: unknown
    default_agent_type: string | null
    permission_level: AgentPermissionLevel | null
    visibility: AgentVisibility
    is_owner: boolean
    device_id: string | null
    last_active_at: string | null
  }>

  const row =
    rows.find((item) => deviceId && item.device_id === deviceId) ??
    rows.find((item) => deviceId && item.agent_id === deviceId) ??
    rows.find((item) => item.is_owner) ??
    rows[0]

  if (!row) return null

  const { data: actorRows, error: actorError } = await supabase
    .from('actor_directory')
    .select('id, default_workspace_id')
    .eq('team_id', teamId)
    .eq('id', row.agent_id)
    .limit(1)

  if (actorError) throw new Error(actorError.message)

  return {
    id: row.agent_id,
    displayName: row.display_name || row.agent_id,
    deviceId: row.device_id ?? null,
    visibility: row.visibility,
    permissionLevel: row.permission_level,
    isOwner: row.is_owner,
    status: null,
    agentTypes: normalizeAgentTypes(row.agent_types),
    defaultAgentType: row.default_agent_type ?? null,
    defaultWorkspaceId: (actorRows?.[0] as { default_workspace_id?: string | null } | undefined)?.default_workspace_id ?? null,
    lastActiveAt: row.last_active_at ?? null,
  }
}

export async function updateCurrentDaemonAgent(input: {
  agentId: string
  displayName: string
  visibility: AgentVisibility
}): Promise<void> {
  const { error } = await supabase.rpc('update_owned_agent_profile', {
    p_agent_id: input.agentId,
    p_display_name: input.displayName,
    p_visibility: input.visibility,
  })
  if (error) throw new Error(error.message)
}

export async function listAgentAccess(agentId: string): Promise<AgentAccessRow[]> {
  const { data, error } = await supabase
    .from('agent_member_access')
    .select('id, agent_id, member_id, permission_level, granted_by_member_id, created_at, updated_at')
    .eq('agent_id', agentId)
    .order('permission_level', { ascending: true })

  if (error) throw new Error(error.message)

  const rows = (data ?? []) as Array<{
    id: string
    agent_id: string
    member_id: string
    permission_level: AgentPermissionLevel
    granted_by_member_id: string | null
    created_at: string
    updated_at: string
  }>

  const memberIds = [...new Set(rows.map((row) => row.member_id))]
  const memberNames = new Map<string, string>()
  if (memberIds.length > 0) {
    const { data: actors, error: actorError } = await supabase
      .from('actor_directory')
      .select('id, display_name')
      .in('id', memberIds)
    if (actorError) throw new Error(actorError.message)
    ;(actors ?? []).forEach((actor: any) => memberNames.set(actor.id, actor.display_name || actor.id))
  }

  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    memberId: row.member_id,
    memberName: memberNames.get(row.member_id) ?? row.member_id,
    permissionLevel: row.permission_level,
    grantedByMemberId: row.granted_by_member_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export async function listTeamMembersForAccess(teamId: string): Promise<TeamMemberOption[]> {
  const { data, error } = await supabase
    .from('actor_directory')
    .select('id, display_name, team_role')
    .eq('team_id', teamId)
    .eq('actor_type', 'member')
    .order('display_name', { ascending: true })

  if (error) throw new Error(error.message)
  return (data ?? []).map((row: any) => ({
    id: row.id,
    displayName: row.display_name || row.id,
    role: row.team_role ?? null,
  }))
}

export async function upsertAgentAccess(input: {
  agentId: string
  memberId: string
  permissionLevel: AgentPermissionLevel
  grantedByMemberId: string | null
}): Promise<void> {
  const { error } = await supabase
    .from('agent_member_access')
    .upsert({
      agent_id: input.agentId,
      member_id: input.memberId,
      permission_level: input.permissionLevel,
      granted_by_member_id: input.grantedByMemberId,
    }, { onConflict: 'agent_id,member_id' })
  if (error) throw new Error(error.message)
}

export async function removeAgentAccess(accessId: string): Promise<void> {
  const { error } = await supabase
    .from('agent_member_access')
    .delete()
    .eq('id', accessId)
  if (error) throw new Error(error.message)
}
