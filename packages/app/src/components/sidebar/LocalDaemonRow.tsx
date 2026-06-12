import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, ChevronDown, ChevronRight, FolderPlus, Loader2, MonitorSmartphone, Settings, Star, Trash2 } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { ActorContextMenu } from '@/components/sidebar/ActorContextMenu'
import type { ActorRow as ActorRowData } from '@/components/panel/ActorsView'
import {
  listDaemonWorkspaces,
  createDaemonWorkspace,
  updateDaemonWorkspace,
  type DaemonWorkspace,
} from '@/lib/daemon-workspaces'
import { addWorkspace } from '@/lib/teamclaw-rpc'
import { syncSessionWorkspaces } from '@/lib/session-workspace-sync'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { workspacePathsMatch } from '@/stores/session-utils'
import { cn } from '@/lib/utils'

interface Props {
  /** The local daemon's actor row (resolved by ActorsSection), or null when the
   *  local daemon agent isn't connected / not yet in the team actor list. */
  actor: ActorRowData | null
  /** True when the daemon agent is the current user's default agent. */
  isDefault?: boolean
  onViewDetail: (actor: ActorRowData) => void
  onCopyName: (actor: ActorRowData) => void
  onCopyId: (actor: ActorRowData) => void
  onRequestRemove: (actor: ActorRowData) => void
}

function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.split('/').pop() || trimmed
}

/**
 * The local daemon agent rendered as the first row of Recents: a normal actor
 * row (shared right-click menu via ActorContextMenu, plus a "Settings" entry)
 * that is lightly emphasized with a coral device avatar, and is expandable to
 * list/manage this machine's workspaces.
 */
export function LocalDaemonRow({
  actor,
  isDefault = false,
  onViewDetail,
  onCopyName,
  onCopyId,
  onRequestRemove,
}: Props) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const currentMember = useCurrentTeamStore((s) => s.currentMember)
  const expanded = useUIStore((s) => s.localDaemonExpanded)
  const toggle = useUIStore((s) => s.toggleLocalDaemon)
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const openSettings = useUIStore((s) => s.openSettings)
  const currentWorkspacePath = useWorkspaceStore((s) => s.workspacePath)
  const currentWorkspaceName = useWorkspaceStore((s) => s.workspaceName)

  const agentId = actor?.id ?? null
  const defaultWorkspaceId = actor?.default_workspace_id ?? null
  const [workspaces, setWorkspaces] = React.useState<DaemonWorkspace[]>([])
  const [loading, setLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)

  const loadWorkspaces = React.useCallback(async () => {
    if (!teamId || !agentId) return
    setLoading(true)
    try {
      const ws = await listDaemonWorkspaces(teamId, agentId)
      setWorkspaces(ws.filter((w) => !w.archived))
      void syncSessionWorkspaces(teamId).catch(() => {})
    } finally {
      setLoading(false)
    }
  }, [teamId, agentId])

  React.useEffect(() => {
    if (expanded) void loadWorkspaces()
  }, [expanded, loadWorkspaces])

  const handleNewWorkspace = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!teamId || !agentId || creating) return
    let selected: string | string[] | null
    try {
      selected = await open({ directory: true, multiple: false, title: t('sidebar.newWorkspace', 'New workspace') })
    } catch (err) {
      console.error('[LocalDaemonRow] folder dialog failed', err)
      return
    }
    if (typeof selected !== 'string') return
    const path = selected
    setCreating(true)
    try {
      await createDaemonWorkspace({
        teamId,
        agentId,
        createdByMemberId: currentMember?.id ?? null,
        name: workspaceNameFromPath(path),
        path,
      })
      try {
        await addWorkspace({ targetActorId: agentId, path, timeoutMs: 10_000 })
      } catch (err) {
        toast.warning(t('sidebar.workspaceDaemonRegisterFailed', 'Workspace added but daemon registration failed'), {
          description: err instanceof Error ? err.message : String(err),
        })
      }
      await useWorkspaceStore.getState().setWorkspace(path)
      await loadWorkspaces()
      toast.success(t('sidebar.workspaceAdded', 'Workspace added'))
    } catch (err) {
      toast.error(t('sidebar.workspaceAddFailed', 'Failed to add workspace: {{msg}}', { msg: err instanceof Error ? err.message : String(err) }))
    } finally {
      setCreating(false)
    }
  }

  const handleSwitchWorkspace = async (ws: DaemonWorkspace) => {
    if (!ws.path) return
    try {
      await useWorkspaceStore.getState().setWorkspace(ws.path)
      toast.success(t('sidebar.workspaceSwitched', 'Switched to {{name}}', { name: ws.name }))
    } catch (err) {
      toast.error(t('sidebar.workspaceSwitchFailed', 'Failed to switch workspace: {{msg}}', { msg: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleDeleteWorkspace = async (ws: DaemonWorkspace) => {
    try {
      await updateDaemonWorkspace({ workspaceId: ws.id, name: ws.name, path: ws.path ?? '', archived: true })
      await loadWorkspaces()
      toast.success(t('sidebar.workspaceDeleted', 'Workspace deleted'))
    } catch (err) {
      toast.error(t('sidebar.workspaceDeleteFailed', 'Failed to delete workspace: {{msg}}', { msg: err instanceof Error ? err.message : String(err) }))
    }
  }

  if (!actor) return null

  return (
    <>
      {/* Local daemon = a normal Recents actor row (shared right-click menu),
          lightly emphasized with a coral device avatar, plus an expand
          disclosure and a hover-revealed "new workspace" action. */}
      <ActorContextMenu
        actor={actor}
        isDefault={isDefault}
        onViewDetail={onViewDetail}
        onCopyName={onCopyName}
        onCopyId={onCopyId}
        onRequestRemove={onRequestRemove}
        extraItems={
          <ContextMenuItem onSelect={() => openSettings('daemonGeneral')}>
            <Settings className="h-4 w-4" />
            {t('sidebar.deviceSettings', 'Settings')}
          </ContextMenuItem>
        }
      >
        <div className="group/daemon flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-selected/60">
          <button
            type="button"
            onClick={toggle}
            className="flex min-w-0 flex-1 items-center gap-[9px] rounded-md px-[9px] py-[5px] text-left"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-coral text-coral-foreground">
              <MonitorSmartphone className="h-3 w-3" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0">
              <span className="truncate text-[12.5px] font-medium leading-tight text-foreground">
                {actor.display_name}
              </span>
              <span
                className="truncate font-mono text-[10px] leading-tight text-faint"
                title={currentWorkspacePath ?? undefined}
              >
                {currentWorkspaceName || t('workspace.selectWorkspace', 'Select Workspace')}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={handleNewWorkspace}
            disabled={creating}
            className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-selected/80 hover:text-foreground group-hover/daemon:opacity-100 disabled:opacity-50"
            title={t('sidebar.newWorkspace', 'New workspace')}
            aria-label={t('sidebar.newWorkspace', 'New workspace')}
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderPlus className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={toggle}
            className="shrink-0 rounded-md p-1 text-faint hover:bg-selected/80 hover:text-foreground"
            aria-label={expanded ? t('common.collapse', 'Collapse') : t('common.expand', 'Expand')}
          >
            {expanded
              ? <ChevronDown className="h-3 w-3" />
              : <ChevronRight className="h-3 w-3" />}
          </button>
        </div>
      </ActorContextMenu>

      {expanded && (
        <div className="flex flex-col">
          {loading && workspaces.length === 0 && (
            <div className="px-[9px] py-1 pl-7 text-[12px] text-faint">{t('sidebar.workspacesLoading', 'Loading workspaces…')}</div>
          )}
          {!loading && workspaces.length === 0 && (
            <div className="px-[9px] py-1 pl-7 text-[12px] text-faint">{t('sidebar.noWorkspaces', 'No workspaces yet')}</div>
          )}
          {workspaces.map((ws) => {
            const active = filter.kind === 'workspace' && (filter.workspaceId === ws.id || filter.path === (ws.path ?? ''))
            const isCurrent = !!currentWorkspacePath && !!ws.path && workspacePathsMatch(ws.path, currentWorkspacePath)
            const isDefault = !!defaultWorkspaceId && ws.id === defaultWorkspaceId
            return (
              <ContextMenu key={ws.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setFilter({ kind: 'workspace', workspaceId: ws.id, path: ws.path ?? '', name: ws.name })}
                    className={cn(
                      'flex w-full items-center gap-[9px] rounded-md py-[5px] pl-7 pr-[9px] text-left text-[12.5px] transition-colors',
                      active ? 'bg-selected font-semibold text-foreground' : 'text-ink-2 hover:bg-selected/60',
                    )}
                    title={ws.path ?? ws.name}
                  >
                    <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                    {isCurrent && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                        title={t('sidebar.currentWorkspace', 'Current workspace')}
                        aria-label={t('sidebar.currentWorkspace', 'Current workspace')}
                      />
                    )}
                    {isDefault && (
                      <Star
                        className="h-3 w-3 shrink-0 fill-coral text-coral"
                        aria-label={t('sidebar.defaultWorkspace', 'Default workspace')}
                      />
                    )}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuItem onSelect={() => void handleSwitchWorkspace(ws)} disabled={!ws.path}>
                    <ArrowLeftRight className="h-4 w-4" />
                    {t('sidebar.switchToWorkspace', 'Switch to this workspace')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onSelect={() => void handleDeleteWorkspace(ws)}>
                    <Trash2 className="h-4 w-4" />
                    {t('common.delete', 'Delete')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      )}
    </>
  )
}
