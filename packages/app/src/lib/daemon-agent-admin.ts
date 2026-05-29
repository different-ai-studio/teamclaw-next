import { invoke } from '@tauri-apps/api/core'
import { getBackend } from '@/lib/backend'

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
  const backend = getBackend()
  const rows = await backend.actors.listConnectedAgents(teamId) as Array<{
    id?: string
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

  const directoryRow = await backend.actors.getDaemonAgentDirectoryEntry(teamId, row.agent_id)

  return {
    id: row.agent_id,
    displayName: directoryRow?.display_name || row.display_name || row.agent_id,
    deviceId: row.device_id ?? null,
    visibility: row.visibility,
    permissionLevel: row.permission_level,
    isOwner: row.is_owner,
    status: directoryRow?.agent_status ?? null,
    agentTypes: normalizeAgentTypes(directoryRow?.agent_types ?? row.agent_types),
    defaultAgentType: directoryRow?.default_agent_type ?? row.default_agent_type ?? null,
    defaultWorkspaceId: directoryRow?.default_workspace_id ?? null,
    lastActiveAt: directoryRow?.last_active_at ?? row.last_active_at ?? null,
  }
}

export async function updateCurrentDaemonAgent(input: {
  agentId: string
  displayName: string
  visibility: AgentVisibility
}): Promise<void> {
  await getBackend().actors.updateOwnedAgentProfile({
    agentId: input.agentId,
    displayName: input.displayName,
    visibility: input.visibility,
  })
}

export async function setAgentDefaultType(agentId: string, defaultAgentType: string): Promise<void> {
  await getBackend().actors.updateAgentDefaults({
    agentId,
    defaultAgentType,
  })
}

export async function listAgentAccess(agentId: string): Promise<AgentAccessRow[]> {
  const rows = await getBackend().actors.listAgentAccess(agentId)
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    memberId: row.memberId,
    memberName: row.memberName,
    permissionLevel: row.permissionLevel,
    grantedByMemberId: row.grantedByMemberId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

export async function listTeamMembersForAccess(teamId: string): Promise<TeamMemberOption[]> {
  return getBackend().actors.listTeamMembersForAccess(teamId)
}

export async function upsertAgentAccess(input: {
  agentId: string
  memberId: string
  permissionLevel: AgentPermissionLevel
  grantedByMemberId: string | null
}): Promise<void> {
  await getBackend().actors.upsertAgentAccess(input)
}

export async function removeAgentAccess(accessId: string): Promise<void> {
  await getBackend().actors.removeAgentAccess(accessId)
}
