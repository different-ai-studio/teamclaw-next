import { describe, it, expect } from 'vitest'
import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import { resolveSessionAgentUiState } from '@/lib/session-agent-ui-state'

describe('resolveSessionAgentUiState', () => {
  it('returns stale when binding superseded', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: true,
        connectingTimedOut: false,
      }),
    ).toBe('stale')
  })

  it('returns offline when presence is false', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: false,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: false,
      }),
    ).toBe('offline')
  })

  it('returns ready when online with models and active runtime', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: true,
        runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        availableModelCount: 2,
        isStaleBinding: false,
        connectingTimedOut: false,
      }),
    ).toBe('ready')
  })

  it('returns offline after connecting timeout', () => {
    expect(
      resolveSessionAgentUiState({
        presenceOnline: undefined,
        runtimeInfo: undefined,
        availableModelCount: 0,
        isStaleBinding: false,
        connectingTimedOut: true,
      }),
    ).toBe('offline')
  })
})
