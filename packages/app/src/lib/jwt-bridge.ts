import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'

// ---------------------------------------------------------------------------
// JWT bridge — push the Supabase access_token into teamclaw.json so the Rust
// FC commands (team share, LiteLLM, OSS sync, team create/join, …) can
// authenticate. All of those read `supabase_jwt` from teamclaw.json, so this
// is the single source of JWT freshness for every FC-backed feature.
//
// CRITICAL: this must initialize at app startup (called from main.tsx), NOT
// from a feature store. The previous bridge lived in the oss-sync store, which
// only loads when the Version History UI opens — so a user who went straight to
// team-share settings never ran it and every FC command failed with
// "supabase_jwt not found — user not logged in".
//
// The write needs BOTH a session token and a workspace path, which arrive in
// either order at startup (the session is often hydrated / anonymously signed
// in before the workspace path is restored). We sync on init and on changes to
// EITHER store, deduped, so whichever arrives last triggers the write.
// ---------------------------------------------------------------------------

let started = false

export function initJwtBridge(): void {
  if (started || !isTauri()) return
  started = true
  void (async () => {
    try {
      const { useAuthStore } = await import('@/stores/auth-store')
      const { useWorkspaceStore } = await import('@/stores/workspace')

      let lastKey = ''
      const syncJwt = async () => {
        const jwt = useAuthStore.getState().session?.access_token ?? null
        const workspacePath = useWorkspaceStore.getState().workspacePath
        if (!jwt || !workspacePath) return
        const key = `${workspacePath} ${jwt}`
        if (key === lastKey) return
        lastKey = key
        try {
          await invoke('oss_sync_set_jwt', { workspacePath, jwt })
        } catch (e) {
          lastKey = '' // allow a retry on the next change
          console.warn('[jwt-bridge] write failed', e)
        }
      }

      void syncJwt()
      useAuthStore.subscribe(() => void syncJwt())
      useWorkspaceStore.subscribe(() => void syncJwt())
    } catch (e) {
      console.warn('[jwt-bridge] init failed', e)
    }
  })()
}

/**
 * Force-write the current Supabase JWT into teamclaw.json *now* and await it.
 * Call this immediately before an FC-backed command to close any residual
 * startup race (e.g. the very first team-share status fetch firing before the
 * background bridge has written the token). No-op when signed out or before a
 * workspace exists.
 */
export async function ensureJwtSynced(workspacePath?: string): Promise<void> {
  if (!isTauri()) return
  try {
    const { useAuthStore } = await import('@/stores/auth-store')
    const jwt = useAuthStore.getState().session?.access_token ?? null
    if (!jwt) return
    let wp = workspacePath
    if (!wp) {
      const { useWorkspaceStore } = await import('@/stores/workspace')
      wp = useWorkspaceStore.getState().workspacePath ?? undefined
    }
    if (!wp) return
    await invoke('oss_sync_set_jwt', { workspacePath: wp, jwt })
  } catch (e) {
    console.warn('[jwt-bridge] ensure failed', e)
  }
}
