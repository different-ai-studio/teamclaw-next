import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types (matching Rust VersionInfo serde camelCase output)
// ---------------------------------------------------------------------------

export interface VersionInfo {
  version: number
  contentHash: string | null
  size: number
  deleted: boolean
  createdAt: string
  message: string | null
}

export interface OssSyncFileStatus {
  status: 'synced' | 'dirty' | 'syncing' | 'conflict'
  syncedVersion?: number
  conflicts?: string[] // sibling .conflict.* file paths
}

export interface OssSyncConflict {
  path: string
  conflictFilePath: string
  remoteCipherHash: string
  timestamp: number
}

// ---------------------------------------------------------------------------
// State interface
// ---------------------------------------------------------------------------

export interface OssSyncState {
  syncing: boolean
  lastSyncAt: string | null
  teamId: string | null
  fileStatusMap: Record<string, OssSyncFileStatus>
  conflicts: OssSyncConflict[]
  lastError: string | null

  refresh(workspacePath: string): Promise<void>
  syncNow(workspacePath: string): Promise<void>
  createTeam(
    name: string,
    workspacePath: string,
  ): Promise<{ teamSecret: string; teamId: string }>
  listVersions(workspacePath: string, path: string): Promise<VersionInfo[]>
  restoreVersion(
    workspacePath: string,
    path: string,
    contentHash: string,
  ): Promise<void>
  resolveConflict(
    workspacePath: string,
    path: string,
    choice: 'keepRemote' | 'keepLocal',
  ): Promise<void>
}

// ---------------------------------------------------------------------------
// Rust command result shapes
// ---------------------------------------------------------------------------

interface SyncStatusResult {
  teamId: string | null
  lastServerSeq: number
  lastSyncAt: string
  dirtyCount: number
  totalFiles: number
}

interface SyncNowResult {
  pulled: number
  pushed: number
  conflicts: number
}

interface CreateTeamResult {
  teamId: string
  teamSlug: string
  aiGatewayEndpoint: string
  litellmKey: string
  teamSecret: string
}

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------

export const useOssSyncStore = create<OssSyncState>((set, get) => ({
  syncing: false,
  lastSyncAt: null,
  teamId: null,
  fileStatusMap: {},
  conflicts: [],
  lastError: null,

  async refresh(workspacePath: string) {
    if (!isTauri()) return
    try {
      const status = await invoke<SyncStatusResult>('oss_sync_status', {
        workspacePath,
      })
      set({
        teamId: status.teamId,
        lastSyncAt: status.lastSyncAt,
      })
    } catch (e) {
      set({ lastError: String(e) })
    }
  },

  async syncNow(workspacePath: string) {
    if (!isTauri()) return
    set({ syncing: true, lastError: null })
    try {
      await invoke<SyncNowResult>('oss_sync_now', { workspacePath })
      // Re-fetch status to get fresh lastSyncAt and team info.
      await get().refresh(workspacePath)
    } catch (e) {
      set({ lastError: String(e) })
    } finally {
      set({ syncing: false })
    }
  },

  async createTeam(name: string, workspacePath: string) {
    const r = await invoke<CreateTeamResult>('oss_sync_create_team', {
      name,
      workspacePath,
    })
    set({ teamId: r.teamId })
    return { teamSecret: r.teamSecret, teamId: r.teamId }
  },

  async listVersions(workspacePath: string, path: string) {
    return invoke<VersionInfo[]>('oss_sync_list_versions', {
      workspacePath,
      path,
    })
  },

  async restoreVersion(workspacePath: string, path: string, contentHash: string) {
    await invoke<void>('oss_sync_restore_version', {
      workspacePath,
      path,
      contentHash,
    })
  },

  async resolveConflict(
    workspacePath: string,
    path: string,
    choice: 'keepRemote' | 'keepLocal',
  ) {
    await invoke<void>('oss_sync_resolve_conflict', {
      workspacePath,
      path,
      // Rust expects camelCase enum variant (serde rename_all = "camelCase")
      choice: choice === 'keepRemote' ? 'keepRemote' : 'keepLocal',
    })
  },
}))

// ---------------------------------------------------------------------------
// JWT bridge — push Supabase access_token into teamclaw.json so that the
// Rust oss_sync commands can authenticate against FC.
//
// Subscribes to the auth store; whenever the session access_token changes
// (login, token refresh, logout) we call oss_sync_set_jwt for every open
// workspace. In practice there is usually one workspace, so we read it from
// the workspace store to avoid importing the full workspace store module here.
// ---------------------------------------------------------------------------

if (isTauri()) {
  // Lazy import to avoid circular deps at module init time.
  import('./auth-store').then(({ useAuthStore }) => {
    useAuthStore.subscribe(async (state) => {
      const jwt = state.session?.access_token ?? null
      if (!jwt) return

      try {
        const { useWorkspaceStore } = await import('./workspace')
        const workspacePath = useWorkspaceStore.getState().workspacePath
        if (!workspacePath) return
        await invoke('oss_sync_set_jwt', { workspacePath, jwt })
      } catch (e) {
        console.warn('[oss-sync] JWT bridge failed', e)
      }
    })
  }).catch((e) => console.warn('[oss-sync] JWT bridge subscribe failed', e))
}

// ---------------------------------------------------------------------------
// Tauri event listener — auto-update store on each engine tick.
// ---------------------------------------------------------------------------

if (isTauri()) {
  // Rust engine emits "oss-sync-status" after each tick.
  // NOTE: Tranche 2 did not add this emit yet — this listener is a no-op until
  // engine.rs adds:
  //   app.emit("oss-sync-status", payload)?;
  // Filed as a TODO in engine.rs. When wired, the payload shape should include
  // teamId, lastSyncAt, pulled, pushed, conflicts so the store can update
  // without an extra round-trip.
  listen<{
    teamId?: string | null
    lastSyncAt?: string | null
    syncing?: boolean
  }>('oss-sync-status', (e) => {
    useOssSyncStore.setState((s) => ({
      ...s,
      ...(e.payload.teamId !== undefined ? { teamId: e.payload.teamId } : {}),
      ...(e.payload.lastSyncAt !== undefined
        ? { lastSyncAt: e.payload.lastSyncAt }
        : {}),
      ...(e.payload.syncing !== undefined
        ? { syncing: e.payload.syncing }
        : {}),
    }))
  }).catch((err) => console.warn('[oss-sync] event subscribe failed', err))
}
