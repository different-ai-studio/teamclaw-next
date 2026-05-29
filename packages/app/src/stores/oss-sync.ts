import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types (matching Rust VersionInfo serde camelCase output)
// ---------------------------------------------------------------------------

export interface VersionInfo {
  version: number
  parentVersion: number
  contentHash: string | null
  size: number
  deleted: boolean
  createdBy: string | null
  createdByNodeId: string | null
  createdAt: string
  message: string | null
}

// Per-file sync status, aligned with git-mode file-tree coloring
// (`modified`/`new`) plus OSS-only `conflict`. `synced` files are omitted from
// the map by `refresh()` (no color), matching git-mode behavior.
export interface OssSyncFileStatus {
  status: 'synced' | 'modified' | 'new' | 'conflict'
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
  // Per-file status from the Rust scan. `synced` entries are kept out of the
  // store map (no color). Optional for backward-compat with older binaries.
  fileStates?: Array<{
    path: string
    status: 'synced' | 'modified' | 'new' | 'conflict'
  }>
}

interface SyncNowResult {
  pulled: number
  pushed: number
  conflicts: number
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
      // Build the per-file status map for file-tree coloring. Drop `synced`
      // entries so the map only carries files that should be colored.
      const fileStatusMap: Record<string, OssSyncFileStatus> = {}
      for (const f of status.fileStates ?? []) {
        if (f.status === 'synced') continue
        fileStatusMap[f.path] = { status: f.status }
      }
      set({
        teamId: status.teamId,
        lastSyncAt: status.lastSyncAt,
        fileStatusMap,
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

// JWT bridge note: pushing the Supabase token into teamclaw.json now lives in
// `@/lib/jwt-bridge` (initialized at app startup from main.tsx). It used to live
// here, but this store only loads when the Version History UI opens, so flows
// that never touch OSS sync (team-share, LiteLLM) ran without a JWT.

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
