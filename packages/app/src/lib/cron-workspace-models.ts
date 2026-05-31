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
  const [daemonProviders, teamShared] = await Promise.all([
    loadDaemonProvidersForPath(workspacePath),
    loadTeamSharedProvider(workspacePath),
  ])

  const workspaceProviders = daemonProviders.filter((p) => p.id !== TEAM_SHARED_PROVIDER_ID)
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
  } else if (!args.teamId) {
    hint = args.messages.globalNoTeam
  } else {
    const agent = await getCurrentDaemonWorkspaceAgent(args.teamId)
    if (!agent?.defaultWorkspaceId) {
      hint = args.messages.globalNoDefault
    } else {
      const workspaces = await listDaemonWorkspaces(args.teamId, agent.id)
      const defaultWs = workspaces.find((w) => w.id === agent.defaultWorkspaceId)
      if (!defaultWs?.path) {
        hint = args.messages.globalNoDefaultPath
      } else {
        targetPath = defaultWs.path
      }
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
