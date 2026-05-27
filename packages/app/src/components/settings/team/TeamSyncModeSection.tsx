import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { isTauri } from '@/lib/utils'

type SyncMode = 'oss' | 'git'

/**
 * Settings panel: owner-only sync_mode toggle.
 * Tranche 5 — OSS Sync v3.
 *
 * Mounted ABOVE <TeamGitConfig /> in TeamSection so users see the mode
 * switch before the Git-mode configuration panel.
 */
export function TeamSyncModeSection() {
  const team = useCurrentTeamStore((s) => s.team)
  const teamId = team?.id ?? null
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const [mode, setMode] = useState<SyncMode | null>(null)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load current mode from server on mount / team change.
  useEffect(() => {
    if (!teamId || !workspacePath || !isTauri()) return
    setMode(null)
    setError(null)
    invoke<string | null>('oss_sync_get_team_sync_mode', { workspacePath, teamId })
      .then((m) => setMode((m as SyncMode) ?? null))
      .catch((e) => setError(String(e)))
  }, [teamId, workspacePath])

  async function switchTo(target: SyncMode) {
    if (target === mode || switching || !teamId || !workspacePath) return
    const confirmed = window.confirm(
      `Switch sync mode to ${target.toUpperCase()}?\n\nThis does NOT migrate existing data — blobs and files synced under the previous mode are left in place.`,
    )
    if (!confirmed) return

    setSwitching(true)
    setError(null)
    try {
      const returned = await invoke<string>('oss_sync_set_team_sync_mode', {
        workspacePath,
        teamId,
        mode: target,
      })
      setMode(returned as SyncMode)
    } catch (e) {
      setError(String(e))
    } finally {
      setSwitching(false)
    }
  }

  if (!teamId) return null

  return (
    <section className="rounded-xl border border-border-soft bg-panel p-4 space-y-3">
      <div>
        <h4 className="text-[13.5px] font-semibold">Sync mode</h4>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Current:{' '}
          <span className="font-medium text-foreground">
            {mode ?? 'loading…'}
          </span>
          {'. '}
          Switching does not migrate existing data.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          disabled={switching || mode === 'oss'}
          onClick={() => switchTo('oss')}
          className="rounded-md border border-border-soft bg-surface px-3 py-1.5 text-[12px] font-medium
                     hover:bg-panel disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
        >
          OSS (default)
        </button>
        <button
          disabled={switching || mode === 'git'}
          onClick={() => switchTo('git')}
          className="rounded-md border border-border-soft bg-surface px-3 py-1.5 text-[12px] font-medium
                     hover:bg-panel disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
        >
          Git
        </button>
      </div>

      {error && (
        <p className="text-[12px] text-red-500">{error}</p>
      )}
    </section>
  )
}
