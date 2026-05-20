import { create as createZustand } from 'zustand'
import { fromBinary } from '@bufbuild/protobuf'
import { DeviceStateSchema } from '@/lib/proto/amux_pb'
import { mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt-bridge'

// Per-daemon presence. Fed by retained `amux/{team}/device/{id}/state`
// publishes — including the LWT the daemon registers at connect-time, which
// the broker flips to `online: false` automatically when the daemon's
// connection drops. So this store is authoritative for "is the daemon
// actually reachable right now?" — unlike `runtime-state-store`, whose
// retains can linger after a daemon dies.
//
// Convention: daemon `device_id` == agent actor_id, so callers index this
// store by the agent's actor id when they want agent presence.

export type DevicePresenceEntry = {
  online: boolean
  deviceName: string
  lastUpdated: number // ms epoch
}

interface DevicePresenceState {
  byDeviceId: Record<string, DevicePresenceEntry>
  upsert: (deviceId: string, entry: DevicePresenceEntry) => void
  clear: () => void
}

export const useDevicePresenceStore = createZustand<DevicePresenceState>((set, get) => ({
  byDeviceId: {},
  upsert: (deviceId, entry) => {
    set({
      byDeviceId: {
        ...get().byDeviceId,
        [deviceId]: entry,
      },
    })
  },
  clear: () => set({ byDeviceId: {} }),
}))

export function parseDeviceStateTopic(
  topic: string,
): { teamId: string; deviceId: string } | null {
  const parts = topic.split('/')
  if (parts.length !== 5) return null
  if (parts[0] !== 'amux') return null
  if (parts[2] !== 'device') return null
  if (parts[4] !== 'state') return null
  return { teamId: parts[1], deviceId: parts[3] }
}

let unlisten: (() => void) | null = null
let initialized = false

export async function initDevicePresenceStore(teamId: string): Promise<void> {
  if (initialized) return
  await mqttSubscribe(`amux/${teamId}/device/+/state`)
  unlisten = await listenForEnvelopes((env: IncomingEnvelope) => {
    const parsed = parseDeviceStateTopic(env.topic)
    if (!parsed) return
    if (parsed.teamId !== teamId) return
    try {
      const state = fromBinary(DeviceStateSchema, new Uint8Array(env.bytes))
      useDevicePresenceStore.getState().upsert(parsed.deviceId, {
        online: state.online,
        deviceName: state.deviceName,
        lastUpdated: Date.now(),
      })
    } catch (e) {
      console.warn('[device-presence] failed to decode DeviceState', e)
    }
  })
  initialized = true
}

export function disposeDevicePresenceStore(): void {
  unlisten?.()
  unlisten = null
  useDevicePresenceStore.getState().clear()
  initialized = false
}
