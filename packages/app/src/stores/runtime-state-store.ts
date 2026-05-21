import { create as createZustand } from 'zustand'
import { fromBinary } from '@bufbuild/protobuf'
import { RuntimeInfoSchema, type RuntimeInfo } from '@/lib/proto/amux_pb'
import { mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt-bridge'
import { sessionFlowLog } from '@/lib/session-flow-log'

export type RuntimeStateEntry = {
  info: RuntimeInfo
  daemonDeviceId: string
  lastUpdated: number // ms epoch
}

interface RuntimeStateState {
  byRuntimeId: Record<string, RuntimeStateEntry>
  upsert: (runtimeId: string, daemonDeviceId: string, info: RuntimeInfo) => void
  clear: () => void
}

export const useRuntimeStateStore = createZustand<RuntimeStateState>((set, get) => ({
  byRuntimeId: {},
  upsert: (runtimeId, daemonDeviceId, info) => {
    set({
      byRuntimeId: {
        ...get().byRuntimeId,
        [runtimeId]: { info, daemonDeviceId, lastUpdated: Date.now() },
      },
    })
  },
  clear: () => set({ byRuntimeId: {} }),
}))

export function parseRuntimeStateTopic(
  topic: string
): { teamId: string; daemonDeviceId: string; runtimeId: string } | null {
  const parts = topic.split('/')
  if (parts.length !== 7) return null
  if (parts[0] !== 'amux') return null
  if (parts[2] !== 'device') return null
  if (parts[4] !== 'runtime') return null
  if (parts[6] !== 'state') return null
  return { teamId: parts[1], daemonDeviceId: parts[3], runtimeId: parts[5] }
}

let unlisten: (() => void) | null = null
let initialized = false

export async function initRuntimeStateStore(teamId: string): Promise<void> {
  if (initialized) return
  await mqttSubscribe(`amux/${teamId}/device/+/runtime/+/state`)
  unlisten = await listenForEnvelopes((env: IncomingEnvelope) => {
    const parsed = parseRuntimeStateTopic(env.topic)
    if (!parsed) return
    if (parsed.teamId !== teamId) return // ignore other teams (shouldn't happen with scoped subscribe, defense in depth)
    let info: RuntimeInfo
    try {
      info = fromBinary(RuntimeInfoSchema, new Uint8Array(env.bytes))
    } catch (e) {
      console.warn('[runtime-state] failed to decode RuntimeInfo', e)
      return
    }
    sessionFlowLog('runtime_state.retain.received', {
      teamId: parsed.teamId,
      daemonDeviceId: parsed.daemonDeviceId,
      runtimeId: parsed.runtimeId,
      infoRuntimeId: info.runtimeId,
      agentType: info.agentType,
      currentModel: info.currentModel,
      availableModelIds: info.availableModels.map((model) => model.id),
      state: info.state,
      status: info.status,
    })
    useRuntimeStateStore.getState().upsert(parsed.runtimeId, parsed.daemonDeviceId, info)
  })
  initialized = true
}

export function disposeRuntimeStateStore(): void {
  unlisten?.()
  unlisten = null
  useRuntimeStateStore.getState().clear()
  initialized = false
}
