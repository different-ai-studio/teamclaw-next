import React from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { exists } from '@tauri-apps/plugin-fs'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamModeStore } from '@/stores/team-mode'
import { TEAM_REPO_DIR } from '@/lib/build-config'
import { resolveTeamDir } from '@/lib/team-skill-paths'
import { isTauri } from '@/lib/utils'

interface TeamSharedFilesBrowserProps {
  hidePanelToolbar?: boolean
  filterText?: string
  onFilterTextChange?: (value: string) => void
  gitChangedOnly?: boolean
  onGitChangedOnlyChange?: (value: boolean) => void
  searchExpanded?: boolean
  onSearchExpandedChange?: (value: boolean) => void
}

export function TeamSharedFilesBrowser({
  hidePanelToolbar = false,
  filterText,
  onFilterTextChange,
  gitChangedOnly,
  onGitChangedOnlyChange,
  searchExpanded,
  onSearchExpandedChange,
}: TeamSharedFilesBrowserProps = {}) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const refreshFileTree = useWorkspaceStore(s => s.refreshFileTree)
  const teamModeType = useTeamModeStore(s => s.teamModeType)
  const [teamRootPath, setTeamRootPath] = React.useState<string | null>(null)
  const [resolving, setResolving] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)

  React.useEffect(() => {
    if (!workspacePath) {
      setTeamRootPath(null)
      return
    }

    let cancelled = false
    setResolving(true)

    void (async () => {
      const linkPath = `${workspacePath.replace(/\/+$/, '')}/${TEAM_REPO_DIR}`
      let resolved: string | null = linkPath

      if (isTauri()) {
        if (await exists(linkPath)) {
          resolved = linkPath
        } else {
          resolved = await resolveTeamDir(workspacePath)
        }
      }

      if (!cancelled) {
        setTeamRootPath(resolved)
        setResolving(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [workspacePath])

  const handleGitSync = React.useCallback(async () => {
    if (!isTauri() || syncing || !workspacePath) return
    setSyncing(true)
    useTeamModeStore.setState({ teamGitSyncing: true })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<{
        success: boolean
        message: string
      }>('team_sync_repo', { force: false, workspacePath })
      if (result.success) {
        toast.success(result.message)
        useTeamModeStore.setState({ teamGitLastSyncAt: new Date().toISOString() })
        await refreshFileTree()
        await useTeamModeStore.getState().loadTeamGitFileSyncStatus(workspacePath)
      } else {
        toast.error(result.message)
      }
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSyncing(false)
      useTeamModeStore.setState({ teamGitSyncing: false })
    }
  }, [syncing, refreshFileTree, workspacePath])

  if (!workspacePath) return null

  if (resolving) {
    return (
      <div className="text-xs text-muted-foreground text-center py-4">
        {t('navigation.teamSharedFilesLoading', 'Loading team shared files...')}
      </div>
    )
  }

  if (!teamRootPath) {
    return (
      <div className="text-xs text-muted-foreground text-center py-4 px-3">
        {t(
          'navigation.teamSharedFilesUnavailable',
          'Team shared directory is not set up yet. Enable team share in Settings → Team.',
        )}
      </div>
    )
  }

  const iconButtonClass =
    'flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground'

  const gitSyncIcon =
    teamModeType === 'git' ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={handleGitSync} disabled={syncing} className={iconButtonClass}>
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('knowledge.gitSync', 'Sync Team')}</TooltipContent>
      </Tooltip>
    ) : null

  const actionIcons = gitSyncIcon ? <>{gitSyncIcon}</> : undefined

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <FileBrowser
        variant="panel"
        rootPath={teamRootPath}
        hideGitStatus={false}
        hideToolbar={hidePanelToolbar}
        filterText={filterText}
        onFilterTextChange={onFilterTextChange}
        gitChangedOnly={gitChangedOnly}
        onGitChangedOnlyChange={onGitChangedOnlyChange}
        searchExpanded={searchExpanded}
        onSearchExpandedChange={onSearchExpandedChange}
        actionIcons={actionIcons}
      />
    </div>
  )
}
