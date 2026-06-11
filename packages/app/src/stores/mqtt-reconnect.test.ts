import { describe, it, expect, beforeEach } from 'vitest'
import { useMqttReconnectStore } from './mqtt-reconnect'

describe('useMqttReconnectStore', () => {
  beforeEach(() => {
    useMqttReconnectStore.setState({ nonce: 0, lastError: null, connected: null })
  })

  it('bump increments the reconnect nonce', () => {
    useMqttReconnectStore.getState().bump()
    expect(useMqttReconnectStore.getState().nonce).toBe(1)
  })

  it('setError records the latest broker error', () => {
    useMqttReconnectStore.getState().setError('bad username or password')
    expect(useMqttReconnectStore.getState().lastError).toBe('bad username or password')
  })

  it('bump clears a stale error so the reconnect attempt starts clean', () => {
    useMqttReconnectStore.getState().setError('connection refused')
    useMqttReconnectStore.getState().bump()
    expect(useMqttReconnectStore.getState().lastError).toBeNull()
  })

  it('setError(null) clears the error after a successful connect', () => {
    useMqttReconnectStore.getState().setError('connection timed out')
    useMqttReconnectStore.getState().setError(null)
    expect(useMqttReconnectStore.getState().lastError).toBeNull()
  })

  it('setConnected updates the shared connection state', () => {
    useMqttReconnectStore.getState().setConnected(false)
    expect(useMqttReconnectStore.getState().connected).toBe(false)
    useMqttReconnectStore.getState().setConnected(true)
    expect(useMqttReconnectStore.getState().connected).toBe(true)
  })

  it('setConnected(true) clears a stale error (a successful connect is healthy)', () => {
    useMqttReconnectStore.getState().setError('bad username or password')
    useMqttReconnectStore.getState().setConnected(true)
    expect(useMqttReconnectStore.getState().connected).toBe(true)
    expect(useMqttReconnectStore.getState().lastError).toBeNull()
  })

  it('setConnected(false) preserves the error so the reason stays visible', () => {
    useMqttReconnectStore.getState().setError('connection refused')
    useMqttReconnectStore.getState().setConnected(false)
    expect(useMqttReconnectStore.getState().connected).toBe(false)
    expect(useMqttReconnectStore.getState().lastError).toBe('connection refused')
  })
})
