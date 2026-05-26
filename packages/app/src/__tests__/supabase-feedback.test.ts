import { describe, it, expect, vi, beforeEach } from 'vitest'

const telemetryMock = vi.hoisted(() => ({
  insertFeedback: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ telemetry: telemetryMock }),
}))

import { insertFeedback } from '@/lib/telemetry/supabase-feedback'

describe('insertFeedback', () => {
  beforeEach(() => {
    telemetryMock.insertFeedback.mockReset()
    telemetryMock.insertFeedback.mockResolvedValue(undefined)
  })

  it('writes one row to actor_message_feedback with kind=positive', async () => {
    await insertFeedback({
      actorId: 'a-1', teamId: 't-1', sessionId: 's-1',
      messageId: 'm-1', kind: 'positive', skill: 'editor',
    })
    expect(telemetryMock.insertFeedback).toHaveBeenCalledWith({
      actor_id: 'a-1', team_id: 't-1', session_id: 's-1',
      message_id: 'm-1', kind: 'positive', star_rating: null, skill: 'editor',
    })
  })
})
