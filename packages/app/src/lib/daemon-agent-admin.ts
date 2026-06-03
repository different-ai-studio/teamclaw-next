import { invoke } from '@tauri-apps/api/core'
import { getBackend } from '@/lib/backend'

export type AgentPermissionLevel = 'view' | 'prompt' | 'admin'
export type AgentVisibility = 'personal' | 'team'

export interface CurrentDaemonAgent {
  id: string
  displayName: string
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

/**
 * The local daemon's `actor_id`, read from its HTTP `GET /v1/info` endpoint
 * (`get_daemon_http_info` IPC → `{ base_url }`). This is the routing identity
 * the daemon persists in `~/.amuxd/backend.toml`. Returns `null` outside Tauri
 * or when the daemon is not running / not yet onboarded.
 *
 * NOTE: the legacy `get_device_info` Tauri command was deleted (device_id is
 * gone; the value was always actor_id), so this is the only frontend source
 * for the local routing identity.
 */
export async function getLocalDaemonActorId(): Promise<string | null> {
  const { isTauri } = await import('@/lib/utils')
  if (!isTauri()) return null
  try {
    const info = await invoke<{ base_url: string } | null>('get_daemon_http_info')
    if (!info?.base_url) return null
    const resp = await fetch(`${info.base_url}/v1/info`)
    if (!resp.ok) return null
    const body: { actor_id?: string } = await resp.json()
    const actorId = body.actor_id?.trim()
    return actorId || null
  } catch {
    return null
  }
}

export async function getCurrentDaemonAgent(teamId: string): Promise<CurrentDaemonAgent | null> {
  const localActorId = await getLocalDaemonActorId()
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
    last_active_at: string | null
  }>

  // Prefer the row that matches this machine's daemon actor_id. Fall back to
  // the owner row (the daemon owns its own agent), then the first connected
  // agent. device_id matching was removed — device_id == actor_id and FC no
  // longer returns it.
  const row =
    rows.find((item) => localActorId && item.agent_id === localActorId) ??
    rows.find((item) => item.is_owner) ??
    rows[0]

  if (!row) return null

  const directoryRow = await backend.actors.getDaemonAgentDirectoryEntry(teamId, row.agent_id)

  return {
    id: row.agent_id,
    displayName: directoryRow?.display_name || row.display_name || row.agent_id,
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
