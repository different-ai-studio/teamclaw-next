import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fromBinary } from '@bufbuild/protobuf'
import {
  LiveEventEnvelopeSchema,
  SessionMessageEnvelopeSchema,
} from '@/lib/proto/teamclaw_pb'

const mocks = vi.hoisted(() => ({
  mqttPublish: vi.fn(),
  supabaseInsert: vi.fn(),
  upsertOutbox: vi.fn(),
  deleteOutbox: vi.fn(),
  listAllOutbox: vi.fn(),
}))

vi.mock('@/lib/mqtt-bridge', () => ({
  mqttPublish: mocks.mqttPublish,
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'messages') throw new Error(`Unexpected table: ${table}`)
      return { insert: mocks.supabaseInsert }
    },
  },
}))

vi.mock('@/lib/local-cache', () => ({
  upsertOutbox: mocks.upsertOutbox,
  deleteOutbox: mocks.deleteOutbox,
  listAllOutbox: mocks.listAllOutbox,
}))

describe('outbox sender', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.mqttPublish.mockResolvedValue(undefined)
    mocks.supabaseInsert.mockResolvedValue({ error: null })
    mocks.upsertOutbox.mockResolvedValue(undefined)
    mocks.deleteOutbox.mockResolvedValue(undefined)
    mocks.listAllOutbox.mockResolvedValue([])
  })

  afterEach(async () => {
    const { stopOutboxSender } = await import('../outbox-sender')
    stopOutboxSender()
  })

  it('publishes and persists the selected message model', async () => {
    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    useOutboxStore.setState({
      byId: {
        'msg-1': {
          messageId: 'msg-1',
          teamId: 'team-1',
          sessionId: 'sess-1',
          senderActorId: 'member-1',
          content: 'hello daemon',
          model: 'opencode/qwen3.6-plus-free',
          mentionActorIds: ['agent-1'],
          displayMentionActorIds: ['agent-1'],
          attachmentUrls: [],
          state: 'pending',
          attemptCount: 0,
          lastAttemptAt: null,
          nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
          lastError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    })

    startOutboxSender()

    await vi.waitFor(() => {
      expect(mocks.mqttPublish).toHaveBeenCalled()
    })

    expect(mocks.supabaseInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'hello daemon',
        model: 'opencode/qwen3.6-plus-free',
        metadata: expect.objectContaining({
          mention_actor_ids: ['agent-1'],
          display_mention_actor_ids: ['agent-1'],
        }),
      }),
    )

    const publishBytes = mocks.mqttPublish.mock.calls[0][1] as Uint8Array
    const live = fromBinary(LiveEventEnvelopeSchema, publishBytes)
    const sessionMessage = fromBinary(SessionMessageEnvelopeSchema, live.body)
    expect(sessionMessage.message?.model).toBe('opencode/qwen3.6-plus-free')
    expect(sessionMessage.message?.content).toBe('hello daemon')
    expect(JSON.parse(sessionMessage.message?.metadataJson ?? '{}')).toMatchObject({
      mention_actor_ids: ['agent-1'],
      display_mention_actor_ids: ['agent-1'],
    })
  })

  it('retries agent-mentioned messages when MQTT publish fails', async () => {
    mocks.mqttPublish.mockRejectedValue(new Error('mqtt not connected'))

    const { useOutboxStore } = await import('@/stores/outbox-store')
    const { startOutboxSender } = await import('../outbox-sender')

    await useOutboxStore.getState().enqueue({
      messageId: 'msg-1',
      teamId: 'team-1',
      sessionId: 'session-1',
      senderActorId: 'member-1',
      content: '@Agent hello',
      model: null,
      mentionActorIds: ['agent-1'],
      attachmentUrls: [],
    })

    startOutboxSender()

    await vi.waitFor(() => {
      const entry = useOutboxStore.getState().byId['msg-1']
      expect(entry.state).toBe('pending')
      expect(entry.attemptCount).toBe(1)
      expect(entry.lastError).toMatch(/mqtt not connected/)
    })
  })
})
