/**
 * TeamGitConfig — Git-mode team-share status panel.
 *
 * Source of truth is the FC share-mode (`useTeamShareStore`), exactly like the
 * OSS panel reads the daemon sync store. The desktop proxies team-sync to the
 * amuxd daemon, which owns the clone, credentials, and materialization — this
 * panel is a pure status surface:
 *   - enabled mode + repo URL + daemon global copy path + workspace link status
 *   - a "Sync now" button (→ team_shared_git_sync proxy; daemon-owned, the proxy
 *     only needs workspacePath)
 *   - the TeamSyncPaths view (real dir + every workspace symlink)
 *   - a static repo setup guide
 *
 * This panel is only mounted for a team whose share mode is already locked to a
 * git mode (managed_git / custom_git) — see TeamSection's router — so it never
 * renders an "unconfigured" empty state. The legacy local-config plumbing
 * (get/save/clear_team_config, the enabled toggle, Disconnect, the embedded LLM
 * service config, and the git-installed precheck) has been removed: team
 * identity now lives behind the Cloud API, the daemon owns sync, and LLM hosting
 * is configured from the LLM settings pane (TeamSharedLlmPane).
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  Clock,
  KeyRound,
  ChevronRight,
  BookOpen,
} from 'lucide-react'
import { cn, isTauri } from '@/lib/utils'
import { TeamSyncPaths } from './TeamSyncPaths'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useTeamShareStore } from '@/stores/team-share'
import { buildConfig, TEAM_SYNCED_EVENT, TEAM_REPO_DIR } from '@/lib/build-config'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

// The daemon proxy no longer returns a `needsConfirmation` size precheck.
interface TeamGitResult {
  success: boolean
  message: string
}

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
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const status = useTeamShareStore((s) => s.status)
  const refresh = useTeamShareStore((s) => s.refresh)

  const [syncing, setSyncing] = React.useState(false)
  const [lastSyncAt, setLastSyncAt] = React.useState<string | null>(null)
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [repoGuideOpen, setRepoGuideOpen] = React.useState(false)

  const sharedDirName = TEAM_REPO_DIR

  // Keep the FC share-mode status fresh (TeamSection resolves it before mounting
  // us; this re-fetch covers team/workspace switches while the pane is open).
  React.useEffect(() => {
    if (!teamId || !workspacePath || !isTauri()) return
    void refresh(teamId, workspacePath)
  }, [teamId, workspacePath, refresh])

  const modeLabel =
    status.mode === 'managed_git'
      ? t('settings.teamShare.modeManagedGitLabel', 'Managed Git')
      : status.mode === 'custom_git'
        ? t('settings.teamShare.modeCustomGitLabel', 'Self-hosted Git')
        : t('settings.team.teamRepo', 'Team Shared Directory')

  // ─── Sync flow — daemon-owned; the proxy only needs workspacePath ─────────

  const performSync = async () => {
    if (!workspacePath) {
      setErrorMessage(t('settings.team.noWorkspace', 'No workspace selected'))
      return
    }
    setSyncing(true)
    setErrorMessage(null)
    try {
      const result = await tauriInvoke<TeamGitResult>('team_shared_git_sync', {
        config: { workspacePath },
        force: false,
      })
      if (!result.success) {
        setErrorMessage(result.message)
        return
      }
      window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))
      setLastSyncAt(new Date().toISOString())
      // Refresh link/global-path status after a sync materializes the dir.
      if (teamId) void refresh(teamId, workspacePath)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }

  // ─── Format last sync time ───────────────────────────────────────────────

  const formatLastSync = (isoString: string | null) => {
    if (!isoString) return t('settings.team.never', 'Never')
    try {
      const date = new Date(isoString)
      const now = new Date()
      const diffMins = Math.floor((now.getTime() - date.getTime()) / 60000)
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

      {/* Status Card */}
      <SettingCard className="border-violet-200 dark:border-violet-800 bg-gradient-to-br from-violet-50/50 to-purple-50/50 dark:from-violet-950/20 dark:to-purple-950/20">
        <div className="space-y-4">
          {/* Header with status */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-violet-100 dark:bg-violet-900/30">
                <Users className="h-5 w-5 text-violet-700 dark:text-violet-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-medium">{modeLabel}</p>
                  <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-3 w-3" />
                    {t('settings.llm.connected', 'Connected')}
                  </span>
                </div>
                {status.gitRemoteUrl && (
                  <div className="flex items-center gap-2 mt-0.5 min-w-0">
                    <p className="text-xs text-muted-foreground font-mono truncate min-w-0">
                      {status.gitRemoteUrl}
                    </p>
                    {status.gitAuthKind && (
                      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                        <KeyRound className="h-2.5 w-2.5" />
                        {status.gitAuthKind === 'ssh_key'
                          ? t('settings.team.authSsh', 'SSH')
                          : t('settings.team.token', 'Token')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Last sync info + Sync now */}
          <div className="flex items-center justify-between pt-2 border-t">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {t('settings.team.lastSynced', 'Last synced')}: {formatLastSync(lastSyncAt)}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={performSync}
              disabled={syncing || !workspacePath}
              className="gap-2"
            >
              <RefreshCw className={cn('h-3 w-3', syncing && 'animate-spin')} />
              {syncing ? t('settings.team.syncing', 'Syncing...') : t('settings.team.syncNow', 'Sync Now')}
            </Button>
          </div>
        </div>
      </SettingCard>

      {/* Real sync directory + every workspace symlink (all 3 share modes) */}
      <TeamSyncPaths teamId={teamId} workspacePath={workspacePath} />

      {/* Repo setup guide */}
      <Collapsible open={repoGuideOpen} onOpenChange={setRepoGuideOpen}>
        <SettingCard className="bg-muted/30 border-dashed">
          <CollapsibleTrigger className="flex w-full items-center gap-3 text-left hover:opacity-80 transition-opacity">
            <BookOpen className="h-5 w-5 text-violet-500 shrink-0" />
            <span className="font-medium text-[13px]">
              {t('settings.team.repoGuide.title', 'How to set up a team repository')}
            </span>
            <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', repoGuideOpen && 'rotate-90')} />
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
                  <li>{t('settings.team.repoGuide.usage1', { defaultValue: 'Clone the repo; {{appName}} will create a {{teamRepoDir}} folder in your workspace.', appName: buildConfig.app.name, teamRepoDir: sharedDirName })}</li>
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
