import { invoke } from '@tauri-apps/api/core'
import {
  getCurrentDaemonWorkspaceAgent,
  listDaemonWorkspaces,
} from '@/lib/daemon-workspaces'
import {
  encodeWorkspaceId,
  getDaemonProviders,
  type DaemonProviderInfo,
} from '@/lib/daemon-local-client'
import { loadTeamProviderFormState, TEAM_SHARED_PROVIDER_ID } from '@/lib/team-provider'
import {
  getCustomProviderConfig,
  getCustomProviderIds,
} from '@/lib/teamclaw-config'
import { workspacePathsMatch } from '@/stores/session-utils'
import type { ConfiguredProvider } from '@/stores/provider'
import type { CronScope } from '@/stores/cron'

/** Map daemon HTTP workspace path to the canonical path registered on this daemon. */
export async function resolveDaemonWorkspacePath(
  teamId: string | null,
  localPath: string | null | undefined,
): Promise<string | null> {
  const trimmed = localPath?.trim()
  if (!trimmed) return null
  if (!teamId) return trimmed

  const rows = await listDaemonWorkspaces(teamId).catch(() => [])
  for (const row of rows) {
    const daemonPath = row.path?.trim()
    if (!daemonPath) continue
    if (workspacePathsMatch(trimmed, daemonPath)) return daemonPath
  }
  return trimmed
}

export interface LocalDaemonWorkspace {
  workspaceId: string
  remoteWorkspaceId: string
  path: string
  displayName: string
  teamId: string | null
  isDefault: boolean
}

export async function listLocalDaemonWorkspaces(): Promise<LocalDaemonWorkspace[]> {
  try {
    return await invoke<LocalDaemonWorkspace[]>('list_local_daemon_workspaces')
  } catch {
    return []
  }
}

export function defaultLocalDaemonWorkspacePath(rows: LocalDaemonWorkspace[]): string | null {
  const explicit = rows.find((row) => row.isDefault && row.path.trim())
  if (explicit) return explicit.path
  if (rows.length === 1 && rows[0].path.trim()) return rows[0].path
  return null
}

function daemonProvidersToCronOptions(
  daemonProviders: DaemonProviderInfo[],
): ConfiguredProvider[] {
  return daemonProviders
    .filter((p) => p.authenticated && p.models.length > 0)
    .map((p) => ({
      id: p.id,
      name: p.display_name,
      models: p.models.map((modelId) => ({ id: modelId, name: modelId })),
    }))
}

async function loadDaemonProvidersForPath(workspacePath: string): Promise<ConfiguredProvider[]> {
  const daemonProviders = await getDaemonProviders(encodeWorkspaceId(workspacePath))
  if (!daemonProviders) return []
  return daemonProvidersToCronOptions(daemonProviders)
}

async function loadWorkspaceConfigProviders(workspacePath: string): Promise<ConfiguredProvider[]> {
  const ids = await getCustomProviderIds(workspacePath).catch(() => [])
  const providers = await Promise.all(
    ids.map(async (id): Promise<ConfiguredProvider | null> => {
      const config = await getCustomProviderConfig(workspacePath, id).catch(() => null)
      if (!config || config.models.length === 0) return null
      return {
        id,
        name: config.name || id,
        models: config.models.map((model) => ({
          id: model.modelId,
          name: model.modelName || model.modelId,
        })),
      }
    }),
  )
  return providers.filter((provider): provider is ConfiguredProvider => provider !== null)
}

async function loadTeamSharedProvider(workspacePath: string): Promise<ConfiguredProvider | null> {
  const teamState = await loadTeamProviderFormState(workspacePath).catch(() => null)
  if (!teamState?.enabled || teamState.models.length === 0) return null
  return {
    id: TEAM_SHARED_PROVIDER_ID,
    name: 'Team Shared',
    models: teamState.models.map((m) => ({ id: m.id, name: m.name })),
  }
}

/**
 * Workspace + team-shared models for the cron job dialog (mirrors LLM settings sources).
 * Team shared comes from `{teamclaw-team}/_meta/provider.json`; other providers from daemon
 * opencode config at the resolved workspace path.
 */
export async function loadCronDialogProviders(workspacePath: string): Promise<ConfiguredProvider[]> {
  const [daemonProviders, configProviders, teamShared] = await Promise.all([
    loadDaemonProvidersForPath(workspacePath),
    loadWorkspaceConfigProviders(workspacePath),
    loadTeamSharedProvider(workspacePath),
  ])

  const byId = new Map<string, ConfiguredProvider>()
  for (const provider of daemonProviders) {
    if (provider.id !== TEAM_SHARED_PROVIDER_ID) byId.set(provider.id, provider)
  }
  for (const provider of configProviders) {
    if (provider.id !== TEAM_SHARED_PROVIDER_ID) byId.set(provider.id, provider)
  }
  const workspaceProviders = Array.from(byId.values())

  if (workspaceProviders.length > 0) {
    return teamShared ? [teamShared, ...workspaceProviders] : workspaceProviders
  }
  if (teamShared) return [teamShared]
  return daemonProviders
}

export type CronDialogModelLoadResult = {
  providers: ConfiguredProvider[]
  hint: string | null
}

/** Resolve target workspace path for cron scope and load provider/model options. */
export async function loadCronDialogModels(args: {
  activeScope: CronScope
  teamId: string | null
  workspacePath: string | null
  localWorkspaces?: LocalDaemonWorkspace[]
  messages: {
    workspaceNoPath: string
    globalNoTeam: string
    globalNoDefault: string
    globalNoDefaultPath: string
    loadFailed: string
  }
}): Promise<CronDialogModelLoadResult> {
  let targetPath: string | null = null
  let hint: string | null = null

  if (args.activeScope === 'workspace') {
    if (!args.workspacePath) {
      hint = args.messages.workspaceNoPath
    } else {
      targetPath = args.workspacePath
    }
  } else {
    const localWorkspaces = args.localWorkspaces ?? await listLocalDaemonWorkspaces()
    targetPath = defaultLocalDaemonWorkspacePath(localWorkspaces)
    if (!targetPath && args.teamId) {
      // Compatibility fallback for registries written before
      // `default_workspace_id` existed: use the cloud default for this daemon
      // when it resolves to a local daemon workspace path.
      const agent = await getCurrentDaemonWorkspaceAgent(args.teamId).catch(() => null)
      const workspaces = agent ? await listDaemonWorkspaces(args.teamId, agent.id).catch(() => []) : []
      const defaultWs = workspaces.find((w) => w.id === agent?.defaultWorkspaceId)
      targetPath = defaultWs?.path || null

      if (targetPath) {
        const resolved = localWorkspaces.find((w) => workspacePathsMatch(w.path, targetPath!))
        targetPath = resolved?.path || targetPath
      }
    }
    if (!targetPath) {
      hint = args.messages.globalNoDefault
    }
  }

  if (!targetPath) {
    return { providers: [], hint }
  }

  const resolvedPath = await resolveDaemonWorkspacePath(args.teamId, targetPath)
  if (!resolvedPath) {
    return { providers: [], hint: args.messages.loadFailed }
  }

  try {
    const providers = await loadCronDialogProviders(resolvedPath)
    return { providers, hint: providers.length === 0 ? args.messages.loadFailed : null }
  } catch {
    return { providers: [], hint: args.messages.loadFailed }
  }
}
