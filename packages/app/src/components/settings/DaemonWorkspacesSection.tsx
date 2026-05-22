import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Archive, CheckCircle2, FolderOpen, Loader2, Plus, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  createDaemonWorkspace,
  getCurrentDaemonWorkspaceAgent,
  listDaemonWorkspaces,
  setAgentDefaultWorkspace,
  updateDaemonWorkspace,
  type DaemonAgent,
  type DaemonWorkspace,
} from '@/lib/daemon-workspaces'
import { cn } from '@/lib/utils'
import { SectionHeader, SettingCard } from './shared'

function workspaceNameFromPath(path: string | null): string {
  if (!path) return ''
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.split('/').pop() || trimmed
}

export function DaemonWorkspacesSection() {
  const { t } = useTranslation()
  const team = useCurrentTeamStore((s) => s.team)
  const currentMember = useCurrentTeamStore((s) => s.currentMember)
  const currentWorkspacePath = useWorkspaceStore((s) => s.workspacePath)
  const [agent, setAgent] = React.useState<DaemonAgent | null>(null)
  const [workspaces, setWorkspaces] = React.useState<DaemonWorkspace[]>([])
  const [name, setName] = React.useState('')
  const [path, setPath] = React.useState(currentWorkspacePath ?? '')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    if (!team?.id) return
    setLoading(true)
    setError(null)
    try {
      const nextAgent = await getCurrentDaemonWorkspaceAgent(team.id)
      setAgent(nextAgent)
      const nextWorkspaces = nextAgent ? await listDaemonWorkspaces(team.id, nextAgent.id) : []
      setWorkspaces(nextWorkspaces)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [team?.id])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (!path && currentWorkspacePath) {
      setPath(currentWorkspacePath)
    }
  }, [currentWorkspacePath, path])

  const handleUseCurrentWorkspace = () => {
    if (!currentWorkspacePath) return
    setPath(currentWorkspacePath)
    if (!name.trim()) {
      setName(workspaceNameFromPath(currentWorkspacePath))
    }
  }

  const handleCreate = async () => {
    if (!team?.id || !agent?.id || !name.trim() || !path.trim()) return
    setSaving(true)
    setError(null)
    try {
      await createDaemonWorkspace({
        teamId: team.id,
        agentId: agent.id,
        createdByMemberId: currentMember?.id ?? null,
        name: name.trim(),
        path: path.trim(),
      })
      setName('')
      setPath(currentWorkspacePath ?? '')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleSetDefault = async (agentId: string, workspaceId: string) => {
    setSaving(true)
    setError(null)
    try {
      await setAgentDefaultWorkspace(agentId, workspaceId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleArchive = async (workspace: DaemonWorkspace, archived: boolean) => {
    setSaving(true)
    setError(null)
    try {
      await updateDaemonWorkspace({
        workspaceId: workspace.id,
        name: workspace.name,
        path: workspace.path ?? '',
        archived,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const activeWorkspaces = workspaces.filter((workspace) => !workspace.archived)
  const archivedWorkspaces = workspaces.filter((workspace) => workspace.archived)

  if (!team) {
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={FolderOpen}
          title={t('settings.daemonWorkspaces.title', 'Workspace')}
          description={t('settings.daemonWorkspaces.description', 'Manage workspaces that daemon agents can use')}
          iconColor="text-slate-500"
        />
        <SettingCard>
          <p className="text-sm text-muted-foreground">
            {t('settings.daemonWorkspaces.noTeam', 'Join or create a team before configuring daemon workspaces.')}
          </p>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <SectionHeader
          icon={FolderOpen}
          title={t('settings.daemonWorkspaces.title', 'Workspace')}
          description={t('settings.daemonWorkspaces.description', 'Manage workspaces that daemon agents can use')}
          iconColor="text-slate-500"
        />
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground" onClick={load} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {t('common.refresh', 'Refresh')}
        </Button>
      </div>

      {error && (
        <SettingCard className="border-destructive/20 bg-destructive/5">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="text-sm font-medium text-destructive">{t('common.error', 'Error')}</p>
              <p className="mt-1 break-words text-sm text-destructive/80">{error}</p>
            </div>
          </div>
        </SettingCard>
      )}

      {!agent && !loading && (
        <SettingCard>
          <p className="text-sm text-muted-foreground">
            {t('settings.daemonWorkspaces.noCurrentAgent', 'No daemon agent is associated with this machine yet.')}
          </p>
        </SettingCard>
      )}

      <SettingCard>
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium">{t('settings.daemonWorkspaces.addTitle', 'Add daemon workspace')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('settings.daemonWorkspaces.addDesc', 'Writes to Supabase workspaces and binds the row to this machine daemon agent.')}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('settings.daemonWorkspaces.agent', 'Daemon Agent')}</span>
              <div className="rounded-md border border-border-soft bg-background/50 px-3 py-2">
                <p className="truncate text-sm font-medium">{agent?.displayName || '-'}</p>
                <code className="block truncate font-mono text-xs text-muted-foreground">{agent?.id || '-'}</code>
              </div>
            </div>
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('settings.daemonWorkspaces.name', 'Name')}</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="TeamClaw" disabled={saving} />
            </label>
          </div>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('settings.daemonWorkspaces.path', 'Path')}</span>
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/Users/me/TeamClaw"
                className="font-mono text-xs"
                disabled={saving}
              />
              <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={handleUseCurrentWorkspace} disabled={!currentWorkspacePath || saving}>
                {t('settings.daemonWorkspaces.useCurrent', 'Use current')}
              </Button>
            </div>
          </label>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={handleCreate}
            disabled={saving || !agent?.id || !name.trim() || !path.trim()}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {t('settings.daemonWorkspaces.add', 'Add Workspace')}
          </Button>
        </div>
      </SettingCard>

      <SettingCard>
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium">{t('settings.daemonWorkspaces.availableTitle', 'Daemon workspaces')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('settings.daemonWorkspaces.availableDesc', 'Rows are read from public.workspaces. Default workspace updates public.agents.default_workspace_id.')}
            </p>
          </div>

          {loading && workspaces.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : activeWorkspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('settings.daemonWorkspaces.empty', 'No daemon workspaces configured yet.')}</p>
          ) : (
            <div className="space-y-2">
              {activeWorkspaces.map((workspace) => {
                const isDefault = Boolean(agent?.defaultWorkspaceId && agent.defaultWorkspaceId === workspace.id)
                return (
                  <div key={workspace.id} className="rounded-lg border border-border-soft bg-background/50 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{workspace.name}</p>
                          {isDefault && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
                              <CheckCircle2 className="h-3 w-3" />
                              {t('settings.daemonWorkspaces.default', 'Default')}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 break-all font-mono text-xs text-foreground">{workspace.path || '-'}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {agent?.displayName || t('settings.daemonWorkspaces.unknownAgent', 'Unknown agent')}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!isDefault && workspace.agentId && (
                          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => handleSetDefault(workspace.agentId!, workspace.id)} disabled={saving}>
                            <Save className="mr-1 h-3.5 w-3.5" />
                            {t('settings.daemonWorkspaces.setDefault', 'Set default')}
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={() => handleArchive(workspace, true)} disabled={saving}>
                          <Archive className="mr-1 h-3.5 w-3.5" />
                          {t('settings.daemonWorkspaces.archive', 'Archive')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </SettingCard>

      {archivedWorkspaces.length > 0 && (
        <SettingCard>
          <div className="space-y-3">
            <p className="text-sm font-medium">{t('settings.daemonWorkspaces.archivedTitle', 'Archived')}</p>
            {archivedWorkspaces.map((workspace) => (
              <div key={workspace.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-muted-foreground">{workspace.name}</p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{workspace.path || '-'}</p>
                </div>
                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => handleArchive(workspace, false)} disabled={saving}>
                  {t('settings.daemonWorkspaces.restore', 'Restore')}
                </Button>
              </div>
            ))}
          </div>
        </SettingCard>
      )}
    </div>
  )
}
