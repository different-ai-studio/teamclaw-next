import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('@/lib/local-cache', () => ({
  upsertOutbox: mocks.upsertOutbox,
  deleteOutbox: mocks.deleteOutbox,
  listAllOutbox: mocks.listAllOutbox,
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: () => ({
      insert: mocks.supabaseInsert,
    }),
  },
}))

describe('outbox sender', () => {
  beforeEach(async () => {
    vi.resetModules()
    mocks.mqttPublish.mockReset()
    mocks.supabaseInsert.mockReset()
    mocks.upsertOutbox.mockReset()
    mocks.deleteOutbox.mockReset()
    mocks.listAllOutbox.mockReset()
    mocks.listAllOutbox.mockResolvedValue([])
    mocks.upsertOutbox.mockResolvedValue(undefined)
    mocks.deleteOutbox.mockResolvedValue(undefined)
    mocks.supabaseInsert.mockResolvedValue({ error: null })
  })

  afterEach(async () => {
    const { stopOutboxSender } = await import('../outbox-sender')
    stopOutboxSender()
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
