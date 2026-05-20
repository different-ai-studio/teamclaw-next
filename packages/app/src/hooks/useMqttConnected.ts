import * as React from 'react'
import { mqttStatus } from '@/lib/mqtt-bridge'
import { isTauri } from '@/lib/utils'

// Returns the MQTT connection state as known by the Rust side.
// `null` = unknown yet (initial probe in flight, or non-Tauri context).
export function useMqttConnected(): boolean | null {
  const [connected, setConnected] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null

    void (async () => {
      try {
        const status = await mqttStatus()
        if (!cancelled) setConnected(status.connected)
      } catch {
        if (!cancelled) setConnected(false)
      }

      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return
        const off = await listen<boolean>('mqtt:connected', (e) => {
          setConnected(!!e.payload)
        })
        if (cancelled) {
          off()
          return
        }
        unlisten = off
      } catch {
        // Listening is best-effort; we still have the initial probe value.
      }
    })()

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return connected
}
