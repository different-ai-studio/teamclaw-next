import { supabase } from '@/lib/supabase-client'

export interface TeamWorkspaceConfig {
  teamId: string
  gitUrl: string | null
  gitBranch: string | null
  gitToken: string | null
  aiGatewayEndpoint: string | null
  sharedDirName: string
  envSecret: string | null
  lastSyncAt: string | null
  lastSyncError: string | null
  enabled: boolean
  updatedAt: string
}

export type UpsertTeamWorkspaceConfigInput =
  Omit<TeamWorkspaceConfig, 'envSecret' | 'lastSyncAt' | 'lastSyncError' | 'updatedAt' | 'sharedDirName'> &
  Partial<Pick<TeamWorkspaceConfig, 'sharedDirName' | 'updatedAt'>>

interface Row {
  team_id: string
  git_url: string | null
  git_branch: string | null
  git_token: string | null
  ai_gateway_endpoint: string | null
  shared_dir_name?: string | null
  env_secret?: string | null
  last_sync_at?: string | null
  last_sync_error?: string | null
  enabled: boolean
  updated_at: string
}

const CONFIG_COLUMNS =
  'team_id, git_url, git_branch, git_token, ai_gateway_endpoint, shared_dir_name, env_secret, last_sync_at, last_sync_error, enabled, updated_at'

function fromRow(r: Row): TeamWorkspaceConfig {
  return {
    teamId: r.team_id,
    gitUrl: r.git_url,
    gitBranch: r.git_branch,
    gitToken: r.git_token,
    aiGatewayEndpoint: r.ai_gateway_endpoint,
    sharedDirName: r.shared_dir_name ?? 'teamclaw',
    envSecret: r.env_secret ?? null,
    lastSyncAt: r.last_sync_at ?? null,
    lastSyncError: r.last_sync_error ?? null,
    enabled: r.enabled,
    updatedAt: r.updated_at,
  }
}

export async function getTeamWorkspaceConfig(teamId: string): Promise<TeamWorkspaceConfig | null> {
  const { data, error } = await supabase
    .from('team_workspace_config')
    .select(CONFIG_COLUMNS)
    .eq('team_id', teamId)
    .maybeSingle()
  if (error) throw new Error(`getTeamWorkspaceConfig failed: ${error.message}`)
  return data ? fromRow(data as Row) : null
}

export async function upsertTeamWorkspaceConfig(input: UpsertTeamWorkspaceConfigInput): Promise<TeamWorkspaceConfig> {
  const { data, error } = await supabase.from('team_workspace_config').upsert({
    team_id:             input.teamId,
    git_url:             input.gitUrl,
    git_branch:          input.gitBranch,
    git_token:           input.gitToken,
    ai_gateway_endpoint: input.aiGatewayEndpoint,
    shared_dir_name:     input.sharedDirName ?? 'teamclaw',
    enabled:             input.enabled,
  }).select(CONFIG_COLUMNS).single()
  if (error) throw new Error(`upsertTeamWorkspaceConfig failed: ${error.message}`)
  return fromRow(data as Row)
}
