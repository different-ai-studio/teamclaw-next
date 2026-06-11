import { create } from 'zustand'

interface MqttReconnectState {
  nonce: number
  /**
   * Shared MQTT connection state as reported by the Rust side. `null` = unknown
   * yet (initial probe in flight, or non-Tauri context). This is the single
   * source of truth: every consumer reads it via `useMqttConnected`, so
   * independent components (settings card, sidebar notice) can never disagree.
   */
  connected: boolean | null
  /**
   * Last MQTT connection error surfaced from the Rust event loop (e.g. a
   * broker auth rejection), or null when the connection is healthy / unknown.
   */
  lastError: string | null
  /** Internal: whether the global probe + listener have been wired. */
  _wired: boolean
  /** Trigger a reconnect attempt. Clears any stale error so the retry is clean. */
  bump: () => void
  /** Record the latest connection error, or pass null to clear it. */
  setError: (message: string | null) => void
  /** Update the shared connection state; a successful connect clears the error. */
  setConnected: (connected: boolean | null) => void
  /**
   * Wire the single source of truth for MQTT state, once. Does an initial
   * `mqtt_status` probe, attaches one `mqtt:connected` / `mqtt:error` listener,
   * re-probes right after attaching (closes the listen-attach race), then
   * re-probes slowly on an interval (self-heals any missed event). Idempotent
   * and Tauri-only — every consumer calls it but only the first does the work.
   */
  ensureWired: () => void
}

export const useMqttReconnectStore = create<MqttReconnectState>((set, get) => ({
  nonce: 0,
  connected: null,
  lastError: null,
  _wired: false,
  bump: () => set({ nonce: get().nonce + 1, lastError: null }),
  setError: (message) => set({ lastError: message }),
  setConnected: (connected) =>
    set(connected ? { connected, lastError: null } : { connected }),
  ensureWired: () => {
    if (get()._wired) return
    set({ _wired: true })
    // Tauri APIs are loaded dynamically so this store module stays import-light
    // (only `zustand`) and unit-testable in a non-Tauri/jsdom env.
    void (async () => {
      const utils = await import('@/lib/utils').catch(() => null)
      const bridge = await import('@/lib/mqtt-bridge').catch(() => null)
      if (!utils || !bridge || !utils.isTauri()) return
      const { mqttStatus } = bridge
      const setConnected = get().setConnected
      const setError = get().setError
      const probe = async () => {
        try {
          const status = await mqttStatus()
          setConnected(status.connected)
        } catch {
          setConnected(false)
        }
      }
      await probe()
      try {
        const { listen } = await import('@tauri-apps/api/event')
        await listen<boolean>('mqtt:connected', (e) => setConnected(!!e.payload))
        await listen<string>('mqtt:error', (e) => {
          if (e.payload) setError(String(e.payload))
        })
        // Reconcile any change that landed while the listener was attaching.
        await probe()
      } catch {
        // Listening is best-effort; the initial probe value still stands.
      }
      // Slow self-heal: a missed event can never leave two indicators disagreeing.
      setInterval(probe, 20_000)
    })()
  },
}))
