import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'
import { ensureJwtSynced } from '@/lib/jwt-bridge'
import { linkDaemonTeamWorkspace } from '@/lib/daemon-local-client'

// ---------------------------------------------------------------------------
// Types — mirror FC GET /v1/teams/:id/share-mode response (camelCase JSON)
// ---------------------------------------------------------------------------

export type ShareMode = 'oss' | 'managed_git' | 'custom_git' | null

// What the workspace `teamclaw-team` entry currently is, as reported by the
// daemon-aware `team_share_get_status` command.
export type LinkStatus = 'symlink' | 'real_dir' | 'missing'

export interface ShareStatus {
  mode: ShareMode
  gitRemoteUrl?: string | null
  gitAuthKind?: string | null
  enabledAt?: string | null
  // Per-workspace link to the daemon's single global copy, and where that
  // global copy lives on disk (~/.amuxd/teams/<team_id>/teamclaw-team).
  linkStatus?: LinkStatus
  globalPath?: string | null
}

export interface CustomGitInput {
  remote_url: string
  auth_kind: 'ssh_key' | 'https_token'
  credential: string
  branch?: string
}

// Result of an enable_* command (matches Rust `EnableShareResult`).
export interface EnableShareResult {
  teamId: string
  shareMode: string
  cloneWarning?: string | null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface TeamShareState {
  status: ShareStatus
  loading: boolean
  lastError: string | null

  refresh(teamId: string, workspacePath: string): Promise<void>
  enableOss(teamId: string, workspacePath: string): Promise<EnableShareResult>
  enableManagedGit(
    teamId: string,
    workspacePath: string,
  ): Promise<EnableShareResult>
  enableCustomGit(
    teamId: string,
    workspacePath: string,
    input: CustomGitInput,
  ): Promise<EnableShareResult>
  setSecret(
    teamId: string,
    secretHex: string,
    workspacePath: string,
  ): Promise<void>
}

const EMPTY_STATUS: ShareStatus = {
  mode: null,
  gitRemoteUrl: null,
  gitAuthKind: null,
  enabledAt: null,
}

export const useTeamShareStore = create<TeamShareState>((set, get) => ({
  status: EMPTY_STATUS,
  loading: false,
  lastError: null,

  async refresh(teamId, workspacePath) {
    if (!isTauri()) return
    set({ loading: true, lastError: null })
    try {
      // Make sure the Supabase JWT is in teamclaw.json before the FC call, in
      // case the background bridge hasn't written it yet this session.
      await ensureJwtSynced(workspacePath)
      const raw = await invoke<ShareStatus>('team_share_get_status', {
        teamId,
        workspacePath,
      })
      set({
        status: {
          mode: (raw?.mode ?? null) as ShareMode,
          gitRemoteUrl: raw?.gitRemoteUrl ?? null,
          gitAuthKind: raw?.gitAuthKind ?? null,
          enabledAt: raw?.enabledAt ?? null,
          linkStatus: raw?.linkStatus,
          globalPath: raw?.globalPath ?? null,
        },
      })
    } catch (e) {
      set({ lastError: String(e) })
    } finally {
      set({ loading: false })
    }
  },

  async enableOss(teamId, workspacePath) {
    await ensureJwtSynced(workspacePath)
    const res = await invoke<EnableShareResult>('team_share_enable_oss', {
      teamId,
      workspacePath,
    })
    // Materialize the daemon's global dir + workspace symlink now (best-effort)
    // so the synced directory exists immediately instead of after a restart.
    await linkDaemonTeamWorkspace(workspacePath)
    await get().refresh(teamId, workspacePath)
    return res
  },

  async enableManagedGit(teamId, workspacePath) {
    await ensureJwtSynced(workspacePath)
    const res = await invoke<EnableShareResult>(
      'team_share_enable_managed_git',
      { teamId, workspacePath },
    )
    await linkDaemonTeamWorkspace(workspacePath)
    await get().refresh(teamId, workspacePath)
    return res
  },

  async enableCustomGit(teamId, workspacePath, input) {
    await ensureJwtSynced(workspacePath)
    const res = await invoke<EnableShareResult>(
      'team_share_enable_custom_git',
      { teamId, workspacePath, input },
    )
    await linkDaemonTeamWorkspace(workspacePath)
    await get().refresh(teamId, workspacePath)
    return res
  },

  async setSecret(teamId, secretHex, workspacePath) {
    await invoke<void>('team_share_set_team_secret', {
      teamId,
      secretHex,
      workspacePath,
    })
  },
}))
