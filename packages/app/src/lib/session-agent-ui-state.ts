import { RuntimeLifecycle, type RuntimeInfo } from '@/lib/proto/amux_pb'

/** Conversation-area agent pill / send UX states (方案甲). */
export type SessionAgentUiState = 'ready' | 'connecting' | 'offline' | 'stale'

export type MentionDeliverySnapshot = 'ready' | 'offline' | 'stale'

export const SESSION_AGENT_CONNECTING_TIMEOUT_MS = 10_000

export function resolveSessionAgentUiState(input: {
  presenceOnline: boolean | undefined
  runtimeInfo: RuntimeInfo | undefined
  availableModelCount: number
  isStaleBinding: boolean
  connectingTimedOut: boolean
}): SessionAgentUiState {
  if (input.isStaleBinding) return 'stale'
  if (input.presenceOnline === false || input.connectingTimedOut) return 'offline'

  const hasModels = input.availableModelCount > 0
  const state = input.runtimeInfo?.state
  if (
    hasModels &&
    state === RuntimeLifecycle.ACTIVE
  ) {
    return 'ready'
  }

  if (input.presenceOnline === true) {
    if (!input.runtimeInfo || state === RuntimeLifecycle.STARTING || !hasModels) {
      return 'connecting'
    }
    return 'offline'
  }

  // presence unknown — treat as connecting until timeout
  if (!input.connectingTimedOut) return 'connecting'
  return 'offline'
}

export function toMentionDeliverySnapshot(
  uiState: SessionAgentUiState,
): MentionDeliverySnapshot | null {
  if (uiState === 'ready') return 'ready'
  if (uiState === 'stale') return 'stale'
  if (uiState === 'offline' || uiState === 'connecting') return 'offline'
  return null
}

export function isNonReadyEngagedState(uiState: SessionAgentUiState): boolean {
  return uiState !== 'ready'
}
