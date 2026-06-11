import { create } from 'zustand'

interface MqttReconnectState {
  nonce: number
  /**
   * Last MQTT connection error surfaced from the Rust event loop (e.g. a
   * broker auth rejection), or null when the connection is healthy / unknown.
   */
  lastError: string | null
  /** Trigger a reconnect attempt. Clears any stale error so the retry is clean. */
  bump: () => void
  /** Record the latest connection error, or pass null to clear it. */
  setError: (message: string | null) => void
}

export const useMqttReconnectStore = create<MqttReconnectState>((set, get) => ({
  nonce: 0,
  lastError: null,
  bump: () => set({ nonce: get().nonce + 1, lastError: null }),
  setError: (message) => set({ lastError: message }),
}))
