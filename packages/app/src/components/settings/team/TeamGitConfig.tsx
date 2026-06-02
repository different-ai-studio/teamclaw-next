/**
 * TeamGitConfig - Git-mode team-share status panel.
 *
 * The desktop now proxies team-sync to the amuxd daemon, and the team's Git
 * config (remote URL / auth) is provisioned by FC at share-mode enable time —
 * not entered here. This panel is therefore a status surface:
 *   - connection / enabled status + last sync time
 *   - a "Sync now" button (→ team_shared_git_sync proxy; no size precheck)
 *   - the team LLM service config (owner / manager)
 *   - runtime details + the TeamSyncPaths view + a repo setup guide
 *
 * The old git-URL/token entry form and the `needsConfirmation` size-precheck
 * dialog have been removed (the daemon always proceeds, and config is no longer
 * edited locally).
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users,
  GitBranch,
  Loader2,
  AlertCircle,
  RefreshCw,
  Unlink,
  CheckCircle2,
  Clock,
  KeyRound,
  ChevronRight,
  BookOpen,
  Settings,
  Save,
} from 'lucide-react'
import { cn, isTauri } from '@/lib/utils'
import { ToggleSwitch } from '@/components/settings/shared'
import { DeviceIdDisplay } from '@/components/settings/DeviceIdDisplay'
import { HostLlmConfig } from './HostLlmConfig'
import { TeamSyncPaths } from './TeamSyncPaths'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { buildConfig, TEAM_SYNCED_EVENT } from '@/lib/build-config'
import {
  buildTeamProviderConfig,
  loadTeamProviderFormState,
  removeTeamProviderFile,
  saveTeamProviderFile,
} from '@/lib/team-provider'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

// ─── Types ──────────────────────────────────────────────────────────────────

interface TeamConfig {
  gitUrl: string
  enabled: boolean
  lastSyncAt: string | null
  sharedDirName: string
  envSecret?: string | null
  gitToken?: string | null
  gitBranch?: string | null
  fcEndpoint?: string | null
}

interface GitCheckResult {
  installed: boolean
  version: string | null
}

// The daemon proxy no longer returns a `needsConfirmation` size precheck.
interface TeamGitResult {
  success: boolean
  message: string
}

type ConnectionState = 'loading' | 'no-git' | 'unconfigured' | 'connected' | 'error' | 'syncing'

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`Team feature requires ${buildConfig.app.name} desktop app (Tauri not available)`)
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

// ─── Reusable Components (local to git config) ─────────────────────────────

function SettingCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border bg-card p-5 transition-all', className)}>
      {children}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamGitConfig() {
  const { t } = useTranslation()
  const canManageServiceConfig = true
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspaceReady = !!workspacePath
  const workspaceArgs = React.useMemo<{ workspacePath?: string }>(
    () => (workspacePath ? { workspacePath } : {}),
    [workspacePath],
  )
  const [deviceInfo, setDeviceInfo] = React.useState<{ nodeId: string } | null>(null)
  const [state, setState] = React.useState<ConnectionState>('loading')
  const [teamConfig, setTeamConfig] = React.useState<TeamConfig | null>(null)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [disconnectDialogOpen, setDisconnectDialogOpen] = React.useState(false)
  const [repoGuideOpen, setRepoGuideOpen] = React.useState(false)

  // LLM hosting (connected editing)
  const defaultLlmUrl = buildConfig.team.llm.baseUrl || ''
  const [hostLlm, setHostLlm] = React.useState(!!defaultLlmUrl)
  const [llmUrl, setLlmUrl] = React.useState(defaultLlmUrl)
  const defaultLlmModels = (buildConfig.team.llm.models ?? []).map((m) => ({ id: m.id, name: m.name }))
  const [llmModels, setLlmModels] = React.useState(defaultLlmModels)
  const [llmSaving, setLlmSaving] = React.useState(false)
  const [llmLoaded, setLlmLoaded] = React.useState(false)

  const effectiveSharedDirName = (teamConfig?.sharedDirName || 'teamclaw').trim() || 'teamclaw'
  const gitLocalPath = workspacePath ? `${workspacePath}/${effectiveSharedDirName}` : effectiveSharedDirName

  // ─── Initialize: check git + load config ─────────────────────────────────

  const initialize = React.useCallback(async () => {
    setState('loading')
    setErrorMessage(null)

    try {
      if (!isTauri()) {
        setState('unconfigured')
        return
      }

      // Wait for the workspace to be registered in backend state.
      if (!workspacePath || !workspaceReady) {
        return
      }

      const gitCheck = await tauriInvoke<GitCheckResult>('team_check_git_installed')
      if (!gitCheck.installed) {
        setState('no-git')
        return
      }

      const config = await tauriInvoke<TeamConfig | null>('get_team_config', workspaceArgs)
      if (config) {
        const normalizedConfig = {
          ...config,
          sharedDirName: config.sharedDirName || 'teamclaw',
        }
        setTeamConfig(normalizedConfig)
        setState('connected')

        if (normalizedConfig.enabled) {
          void performSync(false, normalizedConfig)
        }
      } else {
        setState('unconfigured')
      }
    } catch (err) {
      console.error('Team init error:', err)
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }, [workspacePath, workspaceReady, workspaceArgs])

  React.useEffect(() => {
    initialize()
  }, [initialize])

  // Load current LLM config when connected
  React.useEffect(() => {
    if ((state === 'connected' || state === 'syncing') && !llmLoaded && isTauri()) {
      loadTeamProviderFormState(workspacePath!)
        .then((providerState) => {
          if (providerState) {
            setHostLlm(providerState.enabled)
            setLlmUrl(providerState.baseUrl)
            setLlmModels(providerState.models)
            return
          }
          return tauriInvoke<{ active: boolean; llm?: { baseUrl: string; model?: string; modelName?: string; models?: Array<{ id: string; name: string }> } }>('get_team_status', workspaceArgs)
            .then((status) => {
              if (status.llm?.baseUrl) {
                setHostLlm(true)
                setLlmUrl(status.llm.baseUrl)
                if (status.llm.models?.length) {
                  setLlmModels(status.llm.models)
                } else if (status.llm.model) {
                  setLlmModels([{ id: status.llm.model, name: status.llm.modelName || status.llm.model }])
                }
              }
            })
        })
        .catch(() => {})
      setLlmLoaded(true)
    }
  }, [state, llmLoaded, workspaceArgs])

  // Load device info when connected
  React.useEffect(() => {
    if ((state === 'connected' || state === 'syncing') && isTauri()) {
      tauriInvoke<{ nodeId: string }>('get_device_info').then(setDeviceInfo).catch(() => {})
    }
  }, [state])

  const handleSaveLlmConfig = async () => {
    setLlmSaving(true)
    setErrorMessage(null)
    try {
      await tauriInvoke('update_team_llm_config', {
        llmBaseUrl: hostLlm ? (llmUrl || null) : null,
        llmModel: hostLlm ? (llmModels[0]?.id || null) : null,
        llmModelName: hostLlm ? (llmModels[0]?.name || null) : null,
        llmModels: hostLlm && llmModels.length > 0 ? JSON.stringify(llmModels) : null,
        ...workspaceArgs,
      })
      if (workspacePath) {
        const providerConfig = buildTeamProviderConfig(hostLlm, llmUrl, llmModels)
        if (providerConfig) {
          await saveTeamProviderFile(workspacePath, providerConfig, llmModels[0]?.id)
        } else if (!hostLlm) {
          await removeTeamProviderFile(workspacePath)
        }
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLlmSaving(false)
    }
  }

  // ─── Sync flow ─────────────────────────────────────────────────────
  // The daemon proxy always proceeds — no `needsConfirmation` size precheck.

  const performSync = async (updateUi = true, configForSync: TeamConfig | null = teamConfig) => {
    if (updateUi) {
      setState('syncing')
    }
    setErrorMessage(null)

    try {
      if (!workspacePath || !configForSync) {
        throw new Error(t('settings.team.noWorkspace', 'No workspace selected'))
      }
      const result = await tauriInvoke<TeamGitResult>('team_shared_git_sync', {
        config: {
          workspacePath,
          gitUrl: configForSync.gitUrl,
          gitBranch: configForSync.gitBranch || null,
          gitToken: configForSync.gitToken || null,
          sharedDirName: configForSync.sharedDirName || 'teamclaw',
        },
        force: false,
      })

      if (!result.success) {
        console.warn('Team sync skipped:', result.message)
        if (updateUi) {
          setErrorMessage(result.message)
          setState('connected')
        }
        return
      }

      window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))

      const now = new Date().toISOString()
      const updatedConfig: TeamConfig = { ...configForSync, lastSyncAt: now }
      await tauriInvoke('save_team_config', { team: updatedConfig, ...workspaceArgs })
      setTeamConfig(updatedConfig)
      const { useTeamModeStore } = await import('@/stores/team-mode')
      useTeamModeStore.setState({ teamGitLastSyncAt: now })

      if (updateUi) {
        setState('connected')
      }
    } catch (err) {
      console.error('Team sync error:', err)
      if (updateUi) {
        setErrorMessage(err instanceof Error ? err.message : String(err))
        setState('connected')
      }
    }
  }

  // ─── Disconnect flow ───────────────────────────────────────────────

  const handleDisconnect = async () => {
    setDisconnectDialogOpen(false)
    setErrorMessage(null)

    try {
      await tauriInvoke<TeamGitResult>('team_disconnect_repo', workspaceArgs)
      await tauriInvoke('clear_team_config', workspaceArgs)
      setTeamConfig(null)
      setState('unconfigured')
    } catch (err) {
      console.error('Team disconnect error:', err)
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  // ─── Toggle enabled ──────────────────────────────────────────────────────

  const handleToggleEnabled = async (enabled: boolean) => {
    if (!teamConfig) return
    try {
      const updatedConfig: TeamConfig = { ...teamConfig, enabled }
      await tauriInvoke('save_team_config', { team: updatedConfig, ...workspaceArgs })
      setTeamConfig(updatedConfig)
    } catch (err) {
      console.error('Toggle error:', err)
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  // ─── Format last sync time ───────────────────────────────────────────────

  const formatLastSync = (isoString: string | null) => {
    if (!isoString) return t('settings.team.never', 'Never')
    try {
      const date = new Date(isoString)
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffMins = Math.floor(diffMs / 60000)

      if (diffMins < 1) return t('settings.team.justNow', 'Just now')
      if (diffMins < 60) return t('settings.team.minutesAgo', { count: diffMins, defaultValue: `${diffMins}m ago` })
      const diffHours = Math.floor(diffMins / 60)
      if (diffHours < 24) return t('settings.team.hoursAgo', { count: diffHours, defaultValue: `${diffHours}h ago` })
      const diffDays = Math.floor(diffHours / 24)
      return t('settings.team.daysAgo', { count: diffDays, defaultValue: `${diffDays}d ago` })
    } catch {
      return isoString
    }
  }

  return (
    <>
      {/* Error Banner */}
      {errorMessage && (
        <SettingCard className="bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/30 border-red-200 dark:border-red-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-red-900 dark:text-red-100">{t('common.error', 'Error')}</p>
              <p className="text-[13px] text-red-700 dark:text-red-300 mt-1 break-words">
                {errorMessage}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => setErrorMessage(null)}
            >
              ✕
            </Button>
          </div>
        </SettingCard>
      )}

      {/* Loading State */}
      {state === 'loading' && (
        <SettingCard>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SettingCard>
      )}

      {/* Git Not Installed */}
      {state === 'no-git' && (
        <SettingCard>
          <div className="space-y-3">
            <h4 className="font-medium flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-yellow-500" />
              {t('settings.git.notAvailable', 'Git Not Available')}
            </h4>
            <p className="text-[13px] text-muted-foreground">
              {t('settings.team.gitInstallHint', 'Git CLI is not installed or not in PATH. Install git to enable team repository sharing:')}
            </p>
            <div className="bg-muted rounded-md p-3 font-mono text-xs">
              brew install git
            </div>
            <Button variant="outline" size="sm" onClick={initialize} className="gap-2">
              <RefreshCw className="h-3 w-3" />
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        </SettingCard>
      )}

      {/* Unconfigured — config now comes from FC at share-mode enable time */}
      {state === 'unconfigured' && (
        <SettingCard>
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="space-y-1.5">
              <h4 className="text-[13.5px] font-semibold">
                {t('settings.team.gitNotConfiguredTitle', 'Team Git sync not configured')}
              </h4>
              <p className="text-[12px] leading-5 text-muted-foreground">
                {t(
                  'settings.team.gitNotConfiguredDesc',
                  'The team repository is provisioned when team-share is enabled. Once enabled, sync status and controls appear here.',
                )}
              </p>
              <Button variant="outline" size="sm" onClick={initialize} className="mt-1 gap-2">
                <RefreshCw className="h-3 w-3" />
                {t('common.retry', 'Retry')}
              </Button>
            </div>
          </div>
        </SettingCard>
      )}

      {/* Connected State — status + sync now + disconnect */}
      {(state === 'connected' || state === 'syncing') && teamConfig && (
        <>
          {/* Status Card */}
          <SettingCard className={cn(
            teamConfig.enabled
              ? "border-violet-200 dark:border-violet-800 bg-gradient-to-br from-violet-50/50 to-purple-50/50 dark:from-violet-950/20 dark:to-purple-950/20"
              : ""
          )}>
            <div className="space-y-4">
              {/* Header with status */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "h-9 w-9 rounded-lg flex items-center justify-center",
                    teamConfig.enabled
                      ? "bg-violet-100 dark:bg-violet-900/30"
                      : "bg-muted"
                  )}>
                    <Users className={cn(
                      "h-5 w-5",
                      teamConfig.enabled
                        ? "text-violet-700 dark:text-violet-400"
                        : "text-muted-foreground"
                    )} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-medium">{t('settings.team.teamRepo', 'Team Shared Directory')}</p>
                      <span className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
                        teamConfig.enabled
                          ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                          : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                      )}>
                        <CheckCircle2 className="h-3 w-3" />
                        {teamConfig.enabled ? t('settings.llm.connected', 'Connected') : t('settings.team.disabled', 'Disabled')}
                      </span>
                    </div>
                    {teamConfig.gitUrl && (
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className="text-xs text-muted-foreground font-mono truncate max-w-[300px]">
                          {teamConfig.gitUrl}
                        </p>
                        {teamConfig.gitToken && (
                          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                            <KeyRound className="h-2.5 w-2.5" />
                            {t('settings.team.token', 'Token')}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <ToggleSwitch
                  enabled={teamConfig.enabled}
                  onChange={handleToggleEnabled}
                />
              </div>

              {/* Last sync info */}
              <div className="flex items-center justify-between pt-2 border-t">
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  {t('settings.team.lastSynced', 'Last synced')}: {formatLastSync(teamConfig.lastSyncAt)}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => performSync(true)}
                    disabled={state === 'syncing' || !teamConfig.enabled}
                    className="gap-2"
                  >
                    <RefreshCw className={cn("h-3 w-3", state === 'syncing' && "animate-spin")} />
                    {state === 'syncing' ? t('settings.team.syncing', 'Syncing...') : t('settings.team.syncNow', 'Sync Now')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDisconnectDialogOpen(true)}
                    className="gap-2 text-destructive hover:text-destructive"
                  >
                    <Unlink className="h-3 w-3" />
                    {t('settings.team.disconnect', 'Disconnect')}
                  </Button>
                </div>
              </div>
            </div>
          </SettingCard>

          {/* LLM Service Config — owner / manager only */}
          {canManageServiceConfig && (
            <SettingCard>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-900/30">
                    <Settings className="h-5 w-5 text-slate-700 dark:text-slate-400" />
                  </div>
                  <div>
                    <p className="text-[13px] font-medium">{t('settings.team.serviceConfig', 'Service Config')}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.team.serviceConfigDesc', 'LLM hosting settings for this team')}</p>
                  </div>
                </div>
                <HostLlmConfig
                  enabled={hostLlm}
                  onEnabledChange={setHostLlm}
                  baseUrl={llmUrl}
                  onBaseUrlChange={setLlmUrl}
                  models={llmModels}
                  onModelsChange={setLlmModels}
                />
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={handleSaveLlmConfig}
                  disabled={llmSaving}
                >
                  {llmSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {llmSaving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
                </Button>
              </div>
            </SettingCard>
          )}

          {/* Runtime Details */}
          <SettingCard>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-muted">
                  <KeyRound className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.team.runtimeDetails', 'Runtime Details')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.team.runtimeDetailsDesc', 'Local shared directory, Git URL, and this device identity')}</p>
                </div>
              </div>

              <div className="space-y-2 rounded-lg border border-border-soft bg-background/50 p-3">
                <div className="grid gap-1.5 sm:grid-cols-[108px_minmax(0,1fr)] sm:items-start">
                  <span className="text-xs text-muted-foreground">{t('settings.team.workspacePath', 'Workspace Path')}</span>
                  <code className="min-w-0 break-all font-mono text-xs text-foreground">
                    {workspacePath || t('settings.team.noWorkspace', 'No workspace selected')}
                  </code>
                </div>

                <div className="grid gap-1.5 sm:grid-cols-[108px_minmax(0,1fr)] sm:items-start">
                  <span className="text-xs text-muted-foreground">{t('settings.team.gitLocalPath', 'Git Path')}</span>
                  <code className="min-w-0 break-all font-mono text-xs text-foreground">
                    {gitLocalPath}
                  </code>
                </div>

                <div className="grid gap-1.5 border-t border-border-soft pt-2 sm:grid-cols-[108px_minmax(0,1fr)] sm:items-start">
                  <span className="text-xs text-muted-foreground">{t('settings.team.sharedDirName', 'Shared Directory')}</span>
                  <code className="min-w-0 break-all font-mono text-xs text-foreground">
                    {teamConfig.sharedDirName || 'teamclaw'}
                  </code>
                </div>
              </div>

              {deviceInfo && (
                <div className="pt-2 border-t">
                  <p className="text-xs text-muted-foreground mb-1.5">{t('settings.team.myDeviceId', 'My Device ID')}</p>
                  <DeviceIdDisplay nodeId={deviceInfo.nodeId} />
                </div>
              )}
            </div>
          </SettingCard>

          {/* Real sync directory + every workspace symlink (all 3 share modes) */}
          <TeamSyncPaths teamId={teamId} workspacePath={workspacePath} />

          {/* Shared Layer Info */}
          <SettingCard className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border-blue-200 dark:border-blue-800">
            <div className="space-y-3">
              <h4 className="font-medium text-blue-900 dark:text-blue-100 flex items-center gap-2">
                <GitBranch className="h-4 w-4" />
                {t('settings.team.sharedContent', 'Shared Content')}
              </h4>
              <p className="text-[13px] text-blue-700 dark:text-blue-300">
                {t('settings.team.sharedContentDesc', 'The following directories are synced from the team repository:')}
              </p>
              <div className="space-y-1.5">
                {[
                  { path: 'skills/', desc: t('settings.team.sharedSkills', 'Shared AI skills') },
                  { path: '.mcp/', desc: t('settings.team.sharedMcp', 'Shared MCP server configs') },
                  { path: 'knowledge/', desc: t('settings.team.sharedKnowledge', 'Shared knowledge base') },
                ].map((item) => (
                  <div key={item.path} className="flex items-center gap-2 text-[13px]">
                    <span className="font-mono text-xs bg-blue-100 dark:bg-blue-900/50 px-2 py-0.5 rounded text-blue-800 dark:text-blue-200">
                      {item.path}
                    </span>
                    <span className="text-blue-600 dark:text-blue-400 text-xs">{item.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </SettingCard>
        </>
      )}

      {/* Error state with retry */}
      {state === 'error' && !errorMessage && (
        <SettingCard>
          <div className="text-center py-6">
            <AlertCircle className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground mb-3">{t('settings.team.somethingWrong', 'Something went wrong')}</p>
            <Button variant="outline" onClick={initialize} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        </SettingCard>
      )}

      {/* Disconnect Confirmation Dialog */}
      <Dialog open={disconnectDialogOpen} onOpenChange={setDisconnectDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('settings.team.disconnectTitle', 'Disconnect Team Shared Directory')}</DialogTitle>
            <DialogDescription>
              {t('settings.team.disconnectConfirm', { defaultValue: 'Are you sure you want to disconnect the team shared directory? The {{teamRepoDir}} directory and all its content will be permanently deleted.', teamRepoDir: teamConfig?.sharedDirName || 'teamclaw' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectDialogOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDisconnect} className="gap-2">
              <Unlink className="h-4 w-4" />
              {t('settings.team.disconnect', 'Disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Repo setup guide */}
      <Collapsible open={repoGuideOpen} onOpenChange={setRepoGuideOpen}>
        <SettingCard className="bg-muted/30 border-dashed">
          <CollapsibleTrigger className="flex w-full items-center gap-3 text-left hover:opacity-80 transition-opacity">
            <BookOpen className="h-5 w-5 text-violet-500 shrink-0" />
            <span className="font-medium text-[13px]">
              {t('settings.team.repoGuide.title', 'How to set up a team repository')}
            </span>
            <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", repoGuideOpen && "rotate-90")} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-4 pt-4 border-t space-y-4 text-[13px] text-muted-foreground">
              <p>
                {t('settings.team.repoGuide.intro', { defaultValue: 'A shared repository for your team to centrally manage Agent Skills, MCP configurations, and knowledge documents. Use the structure below so {{appName}} can sync correctly.', appName: buildConfig.app.name })}
              </p>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.structureTitle', 'Repository structure')}
                </h5>
                <pre className="bg-muted rounded-md p-3 font-mono text-xs overflow-x-auto whitespace-pre">
                  {t('settings.team.repoGuide.structureTree', '.\n├── skills/\n├── .mcp/\n├── knowledge/\n├── .gitignore\n└── README.md')}
                </pre>
              </div>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.dirDetailsTitle', 'Directory details')}
                </h5>
                <ul className="space-y-2">
                  <li>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t('settings.team.repoGuide.dirSkillsTitle', 'skills/')}</code>
                    <span className="ml-1">{t('settings.team.repoGuide.dirSkills', 'Shared Agent Skill definitions (SKILL.md).')}</span>
                  </li>
                  <li>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t('settings.team.repoGuide.dirMcpTitle', '.mcp/')}</code>
                    <span className="ml-1">{t('settings.team.repoGuide.dirMcp', 'Shared MCP Server config files.')}</span>
                  </li>
                  <li>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t('settings.team.repoGuide.dirKnowledgeTitle', 'knowledge/')}</code>
                    <span className="ml-1">{t('settings.team.repoGuide.dirKnowledge', 'Shared knowledge documents.')}</span>
                  </li>
                </ul>
              </div>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.usageTitle', 'Usage')}
                </h5>
                <ol className="list-decimal list-inside space-y-1">
                  <li>{t('settings.team.repoGuide.usage1', { defaultValue: 'Clone the repo; {{appName}} will create a {{teamRepoDir}} folder in your workspace.', appName: buildConfig.app.name, teamRepoDir: effectiveSharedDirName })}</li>
                  <li>{t('settings.team.repoGuide.usage2', 'Whitelist .gitignore: only the three directories are tracked.')}</li>
                  <li>{t('settings.team.repoGuide.usage3', 'In Cursor, use @ to reference Skills and Knowledge.')}</li>
                </ol>
              </div>
              <div>
                <h5 className="font-medium text-foreground mb-1.5">
                  {t('settings.team.repoGuide.contributingTitle', 'Contributing')}
                </h5>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{t('settings.team.repoGuide.contributingSkills', 'Add Skill: subdirectory under skills/ with SKILL.md.')}</li>
                  <li>{t('settings.team.repoGuide.contributingMcp', 'Add MCP: <server-name>.json under .mcp/.')}</li>
                  <li>{t('settings.team.repoGuide.contributingKnowledge', 'Add knowledge: files in knowledge/, Markdown recommended.')}</li>
                  <li>{t('settings.team.repoGuide.contributingSecurity', 'No sensitive data (keys, credentials) in commits.')}</li>
                </ul>
              </div>
            </div>
          </CollapsibleContent>
        </SettingCard>
      </Collapsible>
    </>
  )
}
