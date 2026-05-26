import { getBackend } from '@/lib/backend'

export interface TeamWorkspaceConfig {
  teamId: string
  gitUrl: string | null
  gitBranch: string | null
  gitToken: string | null
  aiGatewayEndpoint: string | null
  enabled: boolean
  updatedAt: string
}

interface Row {
  team_id: string
  git_url: string | null
  git_branch: string | null
  git_token: string | null
  ai_gateway_endpoint: string | null
  enabled: boolean
  updated_at: string
}

function fromRow(r: Row): TeamWorkspaceConfig {
  return {
    teamId: r.team_id,
    gitUrl: r.git_url,
    gitBranch: r.git_branch,
    gitToken: r.git_token,
    aiGatewayEndpoint: r.ai_gateway_endpoint,
    enabled: r.enabled,
    updatedAt: r.updated_at,
  }
}

export async function getTeamWorkspaceConfig(teamId: string): Promise<TeamWorkspaceConfig | null> {
  const data = await getBackend().teamWorkspaceConfig.load(teamId)
  return data ? fromRow(data as Row) : null
}

export async function upsertTeamWorkspaceConfig(input: TeamWorkspaceConfig): Promise<void> {
  await getBackend().teamWorkspaceConfig.save({
    team_id:             input.teamId,
    git_url:             input.gitUrl,
    git_branch:          input.gitBranch,
    git_token:           input.gitToken,
    ai_gateway_endpoint: input.aiGatewayEndpoint,
    enabled:             input.enabled,
  })
}
