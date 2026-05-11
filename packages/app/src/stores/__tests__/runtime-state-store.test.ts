import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import {
  RuntimeInfoSchema,
  AgentStatus,
  AgentType,
  RuntimeLifecycle,
} from '@/lib/proto/amux_pb'

const mockSubscribe = vi.fn().mockResolvedValue(undefined)
let envelopeHandler: ((env: { topic: string; bytes: number[] }) => void) | null = null
const mockListen = vi.fn().mockImplementation(async (handler: (env: { topic: string; bytes: number[] }) => void) => {
  envelopeHandler = handler
  return () => { envelopeHandler = null }
})

vi.mock('@/lib/mqtt-bridge', () => ({
  mqttSubscribe: mockSubscribe,
  listenForEnvelopes: mockListen,
  mqttPublish: vi.fn(),
}))

beforeEach(() => {
  mockSubscribe.mockClear()
  envelopeHandler = null
})

afterEach(async () => {
  const mod = await import('../runtime-state-store')
  mod.disposeRuntimeStateStore()
})

describe('runtime-state-store', () => {
  it('subscribes to the device/runtime/state wildcard for the team', async () => {
    const { initRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')
    expect(mockSubscribe).toHaveBeenCalledWith('amux/team-1/device/+/runtime/+/state')
  })

  it('decodes RuntimeInfo retained messages and upserts into store', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    const info = create(RuntimeInfoSchema, {
      runtimeId: 'rt-1',
      agentType: AgentType.CLAUDE_CODE,
      worktree: '/tmp/x',
      status: AgentStatus.IDLE,
      state: RuntimeLifecycle.ACTIVE,
      currentModel: 'claude-opus-4-7',
    })
    envelopeHandler!({
      topic: 'amux/team-1/device/dev-a/runtime/rt-1/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, info)),
    })

    const entry = useRuntimeStateStore.getState().byRuntimeId['rt-1']
    expect(entry).toBeTruthy()
    expect(entry.daemonDeviceId).toBe('dev-a')
    expect(entry.info.runtimeId).toBe('rt-1')
    expect(entry.info.currentModel).toBe('claude-opus-4-7')
  })

  it('ignores envelopes with malformed topics', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    envelopeHandler!({ topic: 'amux/team-1/session/x/live', bytes: [1, 2, 3] })
    envelopeHandler!({ topic: 'unrelated', bytes: [1] })

    expect(Object.keys(useRuntimeStateStore.getState().byRuntimeId)).toHaveLength(0)
  })

  it('ignores envelopes for other teams', async () => {
    const { initRuntimeStateStore, useRuntimeStateStore } = await import('../runtime-state-store')
    await initRuntimeStateStore('team-1')

    const info = create(RuntimeInfoSchema, { runtimeId: 'rt-other' })
    envelopeHandler!({
      topic: 'amux/team-2/device/dev-x/runtime/rt-other/state',
      bytes: Array.from(toBinary(RuntimeInfoSchema, info)),
    })

    expect(useRuntimeStateStore.getState().byRuntimeId['rt-other']).toBeUndefined()
  })
})
