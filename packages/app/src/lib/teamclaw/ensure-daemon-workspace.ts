import { getBackend } from '@/lib/backend'
import i18n from '@/lib/i18n'
import { addWorkspace, fetchWorkspaces } from '@/lib/teamclaw-rpc'
import type { WorkspaceInfo } from '@/lib/proto/amux_pb'
import { workspacePathsMatch } from '@/stores/session-utils'
import { sessionFlowError, sessionFlowLog } from '@/lib/session-flow-log'

export type EnsureDaemonWorkspaceArgs = {
  targetActorId: string
  teamId: string
  cloudWorkspaceId: string
  /** Shown in desktop error toasts. */
  agentLabel?: string
}

export type EnsureDaemonWorkspaceResult = {
  /** Id to pass in runtimeStart.workspaceId (daemon-local or cloud UUID). */
  runtimeWorkspaceId: string
}

function daemonWorkspaceMatchesCloud(
  daemon: WorkspaceInfo,
  cloudId: string,
  cloudPath: string,
): boolean {
  const localId = daemon.workspaceId.trim()
  if (localId && localId === cloudId) return true
  const daemonPath = daemon.path.trim()
  if (cloudPath && daemonPath && workspacePathsMatch(daemonPath, cloudPath)) return true
  return false
}

function runtimeWorkspaceIdForDaemon(daemon: WorkspaceInfo, cloudId: string): string {
  const localId = daemon.workspaceId.trim()
  return localId || cloudId
}

async function notifyDaemonWorkspaceError(title: string, description: string): Promise<void> {
  const { toast } = await import('sonner')
  toast.error(title, { description, duration: 10_000 })
}

/**
 * Ensure the target agent daemon has the cloud workspace registered locally
 * before runtimeStart. Calls fetchWorkspaces first; addWorkspace when missing.
 */
export async function ensureDaemonWorkspaceRegistered(
  args: EnsureDaemonWorkspaceArgs,
): Promise<EnsureDaemonWorkspaceResult> {
  const cloudId = args.cloudWorkspaceId.trim()
  const targetActorId = args.targetActorId.trim()
  if (!cloudId) return { runtimeWorkspaceId: '' }
  if (!targetActorId) {
    throw new Error('ensureDaemonWorkspaceRegistered: targetActorId is required')
  }

  const agentLabel = args.agentLabel?.trim() || targetActorId.slice(0, 8)

  let cloudPath = ''
  try {
    const rows = await getBackend().workspaces.listWorkspacesByIds(args.teamId, [cloudId])
    cloudPath = rows[0]?.path?.trim() ?? ''
  } catch (error) {
    sessionFlowError('daemon_workspace.cloud_lookup.failed', error, {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      targetActorId,
    })
    const message = error instanceof Error ? error.message : String(error)
    await notifyDaemonWorkspaceError(
      i18n.t('daemon.workspace.loadInfoFailedTitle'),
      i18n.t('daemon.workspace.labeledMessage', { agentLabel, message }),
    )
    throw new Error(`Failed to load cloud workspace ${cloudId}: ${message}`, { cause: error })
  }

  if (!cloudPath) {
    const message = `Cloud workspace ${cloudId} has no filesystem path`
    sessionFlowLog('daemon_workspace.cloud_path_missing', {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      targetActorId,
    }, 'warn')
    await notifyDaemonWorkspaceError(
      i18n.t('daemon.workspace.missingPathTitle'),
      i18n.t('daemon.workspace.missingPathDesc', { agentLabel }),
    )
    throw new Error(message)
  }

  sessionFlowLog('daemon_workspace.fetch.begin', {
    teamId: args.teamId,
    cloudWorkspaceId: cloudId,
    cloudPath,
    targetActorId,
  })

  let daemonWorkspaces: WorkspaceInfo[]
  try {
    const fetched = await fetchWorkspaces({ targetActorId })
    daemonWorkspaces = fetched.workspaces ?? []
  } catch (error) {
    sessionFlowError('daemon_workspace.fetch.failed', error, {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      targetActorId,
    })
    const message = error instanceof Error ? error.message : String(error)
    await notifyDaemonWorkspaceError(
      i18n.t('daemon.workspace.listFailedTitle'),
      i18n.t('daemon.workspace.labeledMessage', { agentLabel, message }),
    )
    throw new Error(`fetchWorkspaces failed for ${targetActorId}: ${message}`, { cause: error })
  }

  const existing = daemonWorkspaces.find((ws) => daemonWorkspaceMatchesCloud(ws, cloudId, cloudPath))
  if (existing) {
    const runtimeWorkspaceId = runtimeWorkspaceIdForDaemon(existing, cloudId)
    sessionFlowLog('daemon_workspace.already_registered', {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      runtimeWorkspaceId,
      daemonPath: existing.path,
      targetActorId,
    })
    return { runtimeWorkspaceId }
  }

  sessionFlowLog('daemon_workspace.add.begin', {
    teamId: args.teamId,
    cloudWorkspaceId: cloudId,
    cloudPath,
    targetActorId,
  })

  try {
    const added = await addWorkspace({ targetActorId, path: cloudPath })
    const workspace = added.workspace
    const runtimeWorkspaceId = workspace?.workspaceId?.trim()
    if (!runtimeWorkspaceId) {
      throw new Error('addWorkspace succeeded but returned no workspace id')
    }
    sessionFlowLog('daemon_workspace.add.ok', {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      runtimeWorkspaceId,
      daemonPath: workspace?.path ?? cloudPath,
      targetActorId,
    })
    return { runtimeWorkspaceId }
  } catch (error) {
    sessionFlowError('daemon_workspace.add.failed', error, {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      cloudPath,
      targetActorId,
    })
    const message = error instanceof Error ? error.message : String(error)
    await notifyDaemonWorkspaceError(
      i18n.t('daemon.workspace.registerFailedTitle'),
      i18n.t('daemon.workspace.registerFailedDesc', { agentLabel, cloudPath, message }),
    )
    throw new Error(`addWorkspace failed for ${targetActorId} path ${cloudPath}: ${message}`, { cause: error })
  }
}
