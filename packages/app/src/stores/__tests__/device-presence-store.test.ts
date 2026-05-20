import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create, toBinary } from '@bufbuild/protobuf'
import { DeviceStateSchema } from '@/lib/proto/amux_pb'

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
  const mod = await import('../device-presence-store')
  mod.disposeDevicePresenceStore()
})

describe('device-presence-store', () => {
  it('subscribes to the device/state wildcard for the team', async () => {
    const { initDevicePresenceStore } = await import('../device-presence-store')
    await initDevicePresenceStore('team-1')
    expect(mockSubscribe).toHaveBeenCalledWith('amux/team-1/device/+/state')
  })

  it('decodes DeviceState retains and upserts presence by deviceId', async () => {
    const { initDevicePresenceStore, useDevicePresenceStore } = await import('../device-presence-store')
    await initDevicePresenceStore('team-1')

    const onlineState = create(DeviceStateSchema, {
      online: true,
      deviceName: 'Macmini',
      timestamp: 1700000000n,
    })
    envelopeHandler!({
      topic: 'amux/team-1/device/dev-mac/state',
      bytes: Array.from(toBinary(DeviceStateSchema, onlineState)),
    })

    const entry = useDevicePresenceStore.getState().byDeviceId['dev-mac']
    expect(entry).toBeTruthy()
    expect(entry.online).toBe(true)
    expect(entry.deviceName).toBe('Macmini')
  })

  it('reflects LWT offline transition', async () => {
    const { initDevicePresenceStore, useDevicePresenceStore } = await import('../device-presence-store')
    await initDevicePresenceStore('team-1')

    const online = create(DeviceStateSchema, { online: true, deviceName: 'Macmini', timestamp: 1n })
    envelopeHandler!({
      topic: 'amux/team-1/device/dev-mac/state',
      bytes: Array.from(toBinary(DeviceStateSchema, online)),
    })
    expect(useDevicePresenceStore.getState().byDeviceId['dev-mac'].online).toBe(true)

    // LWT publish replaces retain with online:false.
    const offline = create(DeviceStateSchema, { online: false, deviceName: 'Macmini', timestamp: 2n })
    envelopeHandler!({
      topic: 'amux/team-1/device/dev-mac/state',
      bytes: Array.from(toBinary(DeviceStateSchema, offline)),
    })
    expect(useDevicePresenceStore.getState().byDeviceId['dev-mac'].online).toBe(false)
  })

  it('ignores envelopes for other teams and malformed topics', async () => {
    const { initDevicePresenceStore, useDevicePresenceStore } = await import('../device-presence-store')
    await initDevicePresenceStore('team-1')

    const state = create(DeviceStateSchema, { online: true })
    envelopeHandler!({
      topic: 'amux/team-2/device/d2/state',
      bytes: Array.from(toBinary(DeviceStateSchema, state)),
    })
    envelopeHandler!({ topic: 'amux/team-1/session/x/live', bytes: [1, 2, 3] })

    expect(Object.keys(useDevicePresenceStore.getState().byDeviceId)).toHaveLength(0)
  })
})
