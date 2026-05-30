import { getBackend } from '@/lib/backend'
import { addWorkspace, fetchWorkspaces } from '@/lib/teamclaw-rpc'
import type { WorkspaceInfo } from '@/lib/proto/amux_pb'
import { workspacePathsMatch } from '@/stores/session-utils'
import { sessionFlowError, sessionFlowLog } from '@/lib/session-flow-log'

export type EnsureDaemonWorkspaceArgs = {
  targetDeviceId: string
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
  const targetDeviceId = args.targetDeviceId.trim()
  if (!cloudId) return { runtimeWorkspaceId: '' }
  if (!targetDeviceId) {
    throw new Error('ensureDaemonWorkspaceRegistered: targetDeviceId is required')
  }

  const agentLabel = args.agentLabel?.trim() || targetDeviceId.slice(0, 8)

  let cloudPath = ''
  try {
    const rows = await getBackend().workspaces.listWorkspacesByIds(args.teamId, [cloudId])
    cloudPath = rows[0]?.path?.trim() ?? ''
  } catch (error) {
    sessionFlowError('daemon_workspace.cloud_lookup.failed', error, {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      targetDeviceId,
    })
    const message = error instanceof Error ? error.message : String(error)
    await notifyDaemonWorkspaceError('无法加载 workspace 信息', `${agentLabel}：${message}`)
    throw new Error(`Failed to load cloud workspace ${cloudId}: ${message}`)
  }

  if (!cloudPath) {
    const message = `Cloud workspace ${cloudId} has no filesystem path`
    sessionFlowLog('daemon_workspace.cloud_path_missing', {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      targetDeviceId,
    }, 'warn')
    await notifyDaemonWorkspaceError('Workspace 缺少路径', `${agentLabel}：云端 workspace 未配置本地目录路径。`)
    throw new Error(message)
  }

  sessionFlowLog('daemon_workspace.fetch.begin', {
    teamId: args.teamId,
    cloudWorkspaceId: cloudId,
    cloudPath,
    targetDeviceId,
  })

  let daemonWorkspaces: WorkspaceInfo[] = []
  try {
    const fetched = await fetchWorkspaces({ targetDeviceId })
    daemonWorkspaces = fetched.workspaces ?? []
  } catch (error) {
    sessionFlowError('daemon_workspace.fetch.failed', error, {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      targetDeviceId,
    })
    const message = error instanceof Error ? error.message : String(error)
    await notifyDaemonWorkspaceError('无法读取 Agent workspace 列表', `${agentLabel}：${message}`)
    throw new Error(`fetchWorkspaces failed for ${targetDeviceId}: ${message}`)
  }

  const existing = daemonWorkspaces.find((ws) => daemonWorkspaceMatchesCloud(ws, cloudId, cloudPath))
  if (existing) {
    const runtimeWorkspaceId = runtimeWorkspaceIdForDaemon(existing, cloudId)
    sessionFlowLog('daemon_workspace.already_registered', {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      runtimeWorkspaceId,
      daemonPath: existing.path,
      targetDeviceId,
    })
    return { runtimeWorkspaceId }
  }

  sessionFlowLog('daemon_workspace.add.begin', {
    teamId: args.teamId,
    cloudWorkspaceId: cloudId,
    cloudPath,
    targetDeviceId,
  })

  try {
    const added = await addWorkspace({ targetDeviceId, path: cloudPath })
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
      targetDeviceId,
    })
    return { runtimeWorkspaceId }
  } catch (error) {
    sessionFlowError('daemon_workspace.add.failed', error, {
      teamId: args.teamId,
      cloudWorkspaceId: cloudId,
      cloudPath,
      targetDeviceId,
    })
    const message = error instanceof Error ? error.message : String(error)
    await notifyDaemonWorkspaceError(
      'Agent workspace 注册失败',
      `${agentLabel}：无法在 daemon 上注册目录 ${cloudPath}。${message}`,
    )
    throw new Error(`addWorkspace failed for ${targetDeviceId} path ${cloudPath}: ${message}`)
  }
}
