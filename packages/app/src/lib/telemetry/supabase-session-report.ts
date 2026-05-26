import { getBackend } from '@/lib/backend'

export interface SessionReportInsert {
  actorId: string
  teamId: string
  sessionId?: string | null
  tokensUsed: number
  costUsd: number
  model?: string | null
  agentKind?: string | null
  endedAt?: string | null
}

export async function insertSessionReport(input: SessionReportInsert): Promise<void> {
  await getBackend().telemetry.insertSessionReport({
    actor_id:    input.actorId,
    team_id:     input.teamId,
    session_id:  input.sessionId ?? null,
    tokens_used: input.tokensUsed,
    cost_usd:    input.costUsd,
    model:       input.model ?? null,
    agent_kind:  input.agentKind ?? null,
    ended_at:    input.endedAt ?? null,
  })
}

export interface LeaderboardRow {
  actor_id: string
  display_name: string | null
  tokens_used_30d: number
  cost_usd_30d: number
  positive_feedback_30d: number
  negative_feedback_30d: number
}

export async function getLeaderboard(teamId: string): Promise<LeaderboardRow[]> {
  const data = await getBackend().telemetry.listLeaderboard(teamId)
  return data as unknown as LeaderboardRow[]
}
