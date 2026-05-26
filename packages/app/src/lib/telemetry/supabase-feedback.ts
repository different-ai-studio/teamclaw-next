import { getBackend } from '@/lib/backend'

export type FeedbackKind = 'positive' | 'negative'

export interface FeedbackInsert {
  actorId: string
  teamId: string
  sessionId?: string | null
  messageId?: string | null
  kind: FeedbackKind
  starRating?: number | null
  skill?: string | null
}

export async function insertFeedback(input: FeedbackInsert): Promise<void> {
  await getBackend().telemetry.insertFeedback({
    actor_id: input.actorId,
    team_id: input.teamId,
    session_id: input.sessionId ?? null,
    message_id: input.messageId ?? null,
    kind: input.kind,
    star_rating: input.starRating ?? null,
    skill: input.skill ?? null,
  })
}

export interface FeedbackSummaryRow {
  actor_id: string
  display_name: string | null
  positive_feedback_30d: number
  negative_feedback_30d: number
}

export async function getTeamFeedbackSummary(teamId: string): Promise<FeedbackSummaryRow[]> {
  const data = await getBackend().telemetry.listFeedbackSummary(teamId)
  return data as unknown as FeedbackSummaryRow[]
}
