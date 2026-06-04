import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, FolderPlus, Loader2, MonitorSmartphone } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { toast } from 'sonner'
import { getCurrentDaemonAgent } from '@/lib/daemon-agent-admin'
import { listDaemonWorkspaces, createDaemonWorkspace, type DaemonWorkspace } from '@/lib/daemon-workspaces'
import { addWorkspace } from '@/lib/teamclaw-rpc'
import { syncSessionWorkspaces } from '@/lib/session-workspace-sync'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { cn } from '@/lib/utils'

function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.split('/').pop() || trimmed
}

export function LocalDaemonRow() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const currentMember = useCurrentTeamStore((s) => s.currentMember)
  const expanded = useUIStore((s) => s.localDaemonExpanded)
  const toggle = useUIStore((s) => s.toggleLocalDaemon)
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)

  const [agent, setAgent] = React.useState<{ id: string; displayName: string } | null>(null)
  const [workspaces, setWorkspaces] = React.useState<DaemonWorkspace[]>([])
  const [loading, setLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)

  React.useEffect(() => {
    if (!teamId) { setAgent(null); return }
    let cancelled = false
    void getCurrentDaemonAgent(teamId).then((a) => {
      if (!cancelled) setAgent(a ? { id: a.id, displayName: a.displayName } : null)
    })
    return () => { cancelled = true }
  }, [teamId])

  const loadWorkspaces = React.useCallback(async () => {
    if (!teamId || !agent?.id) return
    setLoading(true)
    try {
      const ws = await listDaemonWorkspaces(teamId, agent.id)
      setWorkspaces(ws.filter((w) => !w.archived))
      void syncSessionWorkspaces(teamId).catch(() => {})
    } finally {
      setLoading(false)
    }
  }, [teamId, agent?.id])

  React.useEffect(() => {
    if (expanded) void loadWorkspaces()
  }, [expanded, loadWorkspaces])

  const handleNewWorkspace = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!teamId || !agent?.id || creating) return
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
        agentId: agent.id,
        createdByMemberId: currentMember?.id ?? null,
        name: workspaceNameFromPath(path),
        path,
      })
      try {
        await addWorkspace({ targetActorId: agent.id, path, timeoutMs: 10_000 })
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

  if (!agent) return null

  return (
    <>
      {/* Local daemon = a normal Recents actor row, lightly emphasized (coral
          device avatar, like the default agent's coral accent) + an expand
          disclosure and a hover-revealed "new workspace" action. */}
      <div className="group/daemon flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-selected/60">
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-[9px] rounded-md px-[9px] py-[5px] text-left text-[12.5px]"
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-coral/15 text-coral">
            <MonitorSmartphone className="h-3 w-3" />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {agent.displayName}
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
            return (
              <button
                key={ws.id}
                type="button"
                onClick={() => setFilter({ kind: 'workspace', workspaceId: ws.id, path: ws.path ?? '', name: ws.name })}
                className={cn(
                  'flex w-full items-center gap-[9px] rounded-md py-[5px] pl-7 pr-[9px] text-left text-[12.5px] transition-colors',
                  active ? 'bg-selected font-semibold text-foreground' : 'text-ink-2 hover:bg-selected/60',
                )}
                title={ws.path ?? ws.name}
              >
                <span className="min-w-0 flex-1 truncate">{ws.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
