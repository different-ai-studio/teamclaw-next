import * as React from 'react'
import { mqttStatus } from '@/lib/mqtt-bridge'
import { isTauri } from '@/lib/utils'
import { useMqttReconnectStore } from '@/stores/mqtt-reconnect'

// Returns the MQTT connection state as known by the Rust side.
// `null` = unknown yet (initial probe in flight, or non-Tauri context).
//
// As a side effect this also keeps `useMqttReconnectStore.lastError` in sync:
// the Rust event loop emits `mqtt:error` with the broker's rejection reason
// (e.g. bad username/password) and clears it on a successful CONNACK. Without
// this the only trace of a failed connection was a `tracing::warn!` line that
// never reached the UI.
export function useMqttConnected(): boolean | null {
  const [connected, setConnected] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    const unlisteners: Array<() => void> = []
    const setError = useMqttReconnectStore.getState().setError

    void (async () => {
      try {
        const status = await mqttStatus()
        if (!cancelled) {
          setConnected(status.connected)
          if (status.connected) setError(null)
        }
      } catch {
        if (!cancelled) setConnected(false)
      }

      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return
        const offConnected = await listen<boolean>('mqtt:connected', (e) => {
          const isConnected = !!e.payload
          setConnected(isConnected)
          // A successful (re)connect clears whatever error was showing.
          if (isConnected) setError(null)
        })
        const offError = await listen<string>('mqtt:error', (e) => {
          if (e.payload) setError(String(e.payload))
        })
        if (cancelled) {
          offConnected()
          offError()
          return
        }
        unlisteners.push(offConnected, offError)
      } catch {
        // Listening is best-effort; we still have the initial probe value.
      }
    })()

    return () => {
      cancelled = true
      for (const off of unlisteners) off()
    }
  }, [])

  return connected
}
