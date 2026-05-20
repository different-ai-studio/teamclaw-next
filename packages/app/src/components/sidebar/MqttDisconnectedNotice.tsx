import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import { useSessionListStore } from '@/stores/session-list-store'
import { useUIStore } from '@/stores/ui'
import { useMqttConnected } from '@/hooks/useMqttConnected'

// Shows a small notice above the sidebar footer when MQTT should be connected
// (signed-in + has a team) but the Rust side reports `connected: false`.
// Click opens Settings → Server so the user can fix broker config.
export function MqttDisconnectedNotice() {
  const { t } = useTranslation()
  const userId = useAuthStore((s) => s.session?.user.id ?? null)
  const firstTeamId = useSessionListStore((s) => s.rows[0]?.team_id ?? null)
  const openSettings = useUIStore((s) => s.openSettings)
  const connected = useMqttConnected()

  const expected = !!userId && !!firstTeamId
  if (!expected) return null
  if (connected !== false) return null

  return (
    <button
      type="button"
      onClick={() => openSettings('server')}
      className="flex w-full items-start gap-2 rounded-lg border border-[color:var(--coral-soft)] bg-paper px-2.5 py-2 text-left shadow-sm transition-colors hover:bg-[color:var(--coral-soft)]/40"
    >
      <span
        aria-hidden
        className="mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full bg-[color:var(--coral)]"
      />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[12px] font-semibold text-foreground">
          {t('sidebar.mqttDisconnected', 'MQTT 未连接')}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {t('sidebar.mqttDisconnectedHint', '点击配置服务器')}
        </span>
      </span>
    </button>
  )
}
