import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'
import { getSession as getAuthSession, subscribe as subscribeAuth } from '@/lib/auth'

// ---------------------------------------------------------------------------
// JWT bridge — push the Supabase access_token into teamclaw.json so the Rust
// FC commands (team share, LiteLLM, OSS sync, team create/join, …) can
// authenticate. All of those read `supabase_jwt` from teamclaw.json, so this
// is the single source of JWT freshness for every FC-backed feature.
//
// TOKEN SOURCE: read from `@/lib/auth` getSession() — the SAME session store
// the Cloud API client uses for its bearer token (see cloud-api/auth.ts +
// http.ts). It is kept fresh by the auth client's auto-refresh, so it always
// matches the token that actually works against FC. (The earlier version read
// the zustand auth-store snapshot, which is a separate copy that can drift out
// of sync after a token refresh — writing a stale/foreign token.)
//
// CRITICAL: this must initialize at app startup (called from main.tsx), NOT
// from a feature store. The original bridge lived in the oss-sync store, which
// only loads when the Version History UI opens — so a user who went straight to
// team-share settings never ran it and every FC command failed with
// "supabase_jwt not found — user not logged in".
//
// The write needs BOTH a session token and a workspace path, which arrive in
// either order at startup. We sync on init and on changes to EITHER the auth
// session or the workspace path, deduped, so whichever arrives last writes.
// ---------------------------------------------------------------------------

let started = false

function currentJwt(): string | null {
  return getAuthSession()?.access_token ?? null
}

export function initJwtBridge(): void {
  if (started || !isTauri()) return
  started = true
  void (async () => {
    try {
      const { useWorkspaceStore } = await import('@/stores/workspace')

      let lastKey = ''
      const syncJwt = async () => {
        const jwt = currentJwt()
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
      subscribeAuth(() => void syncJwt())
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
    const jwt = currentJwt()
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
