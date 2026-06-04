import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, Bot, Check, Loader2, RefreshCw, RotateCcw, Save, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DaemonOnboardingWizard } from '@/components/auth/DaemonOnboardingWizard'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { useCurrentTeamStore } from '@/stores/current-team'
import {
  getCurrentDaemonAgent,
  listAgentAccess,
  listTeamMembersForAccess,
  removeAgentAccess,
  setAgentDefaultType,
  updateCurrentDaemonAgent,
  upsertAgentAccess,
  type AgentAccessRow,
  type AgentPermissionLevel,
  type AgentVisibility,
  type CurrentDaemonAgent,
  type TeamMemberOption,
} from '@/lib/daemon-agent-admin'
import { cn, isTauri } from '@/lib/utils'
import { SectionHeader, SettingCard } from './shared'

const permissionLevels: AgentPermissionLevel[] = ['view', 'prompt', 'admin']

function formatRelative(value: string | null): string {
  if (!value) return '-'
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return value
  const diff = Date.now() - time
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function DaemonGeneralSection() {
  const { t } = useTranslation()
  const team = useCurrentTeamStore((s) => s.team)
  const currentMember = useCurrentTeamStore((s) => s.currentMember)
  const [agent, setAgent] = React.useState<CurrentDaemonAgent | null>(null)
  const [accessRows, setAccessRows] = React.useState<AgentAccessRow[]>([])
  const [members, setMembers] = React.useState<TeamMemberOption[]>([])
  const [displayName, setDisplayName] = React.useState('')
  const [visibility, setVisibility] = React.useState<AgentVisibility>('team')
  const [defaultAgentType, setDefaultAgentType] = React.useState('')
  const [memberId, setMemberId] = React.useState('')
  const [permissionLevel, setPermissionLevel] = React.useState<AgentPermissionLevel>('prompt')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [daemonTeamId, setDaemonTeamId] = React.useState<string | null>(null)
  // When set, render the existing daemon onboarding wizard as an overlay to
  // re-bind the local daemon to the current team.
  const [rebinding, setRebinding] = React.useState(false)
  // Surfaced so the overlay can offer a safe cancel *before* the daemon binding
  // is cleared (status 'mismatch'); once re-init starts there's no going back.
  const onboardingStatus = useDaemonOnboardingStore((s) => s.status)
  const onboardingBusy = useDaemonOnboardingStore((s) => s.busy)

  // The local daemon is single-team (its team_id is fixed at `amuxd init`).
  // Read it so we can warn when it diverges from the app's selected team —
  // team-share content syncs/links under the daemon's team, not the app's.
  const loadDaemonTeamId = React.useCallback(async () => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const id = await invoke<string | null>('get_daemon_team_id')
      setDaemonTeamId(id ?? null)
    } catch {
      // Best-effort: no daemon config / not onboarded → no warning.
    }
  }, [])

  React.useEffect(() => {
    void loadDaemonTeamId()
  }, [loadDaemonTeamId])

  const teamMismatch = !!daemonTeamId && !!team?.id && daemonTeamId !== team.id

  const load = React.useCallback(async () => {
    if (!team?.id) return
    setLoading(true)
    setError(null)
    try {
      const nextAgent = await getCurrentDaemonAgent(team.id)
      setAgent(nextAgent)
      setDisplayName(nextAgent?.displayName ?? '')
      setVisibility(nextAgent?.visibility ?? 'team')
      setDefaultAgentType(nextAgent?.defaultAgentType ?? '')
      const [nextMembers, nextAccessRows] = await Promise.all([
        listTeamMembersForAccess(team.id),
        nextAgent ? listAgentAccess(nextAgent.id) : Promise.resolve([]),
      ])
      setMembers(nextMembers)
      setAccessRows(nextAccessRows)
      setMemberId((current) => nextMembers.some((member) => member.id === current) ? current : nextMembers[0]?.id ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [team?.id])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleSaveProfile = async () => {
    if (!agent || !displayName.trim()) return
    setSaving(true)
    setError(null)
    try {
      await updateCurrentDaemonAgent({
        agentId: agent.id,
        displayName: displayName.trim(),
        visibility,
      })
      if (defaultAgentType && defaultAgentType !== (agent.defaultAgentType ?? '')) {
        await setAgentDefaultType(agent.id, defaultAgentType)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleAddAccess = async () => {
    if (!agent || !memberId) return
    setSaving(true)
    setError(null)
    try {
      await upsertAgentAccess({
        agentId: agent.id,
        memberId,
        permissionLevel,
        grantedByMemberId: currentMember?.id ?? null,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateAccess = async (row: AgentAccessRow, nextLevel: AgentPermissionLevel) => {
    setSaving(true)
    setError(null)
    try {
      await upsertAgentAccess({
        agentId: row.agentId,
        memberId: row.memberId,
        permissionLevel: nextLevel,
        grantedByMemberId: currentMember?.id ?? row.grantedByMemberId,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRemoveAccess = async (row: AgentAccessRow) => {
    setSaving(true)
    setError(null)
    try {
      await removeAgentAccess(row.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!team) {
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={Bot}
          title={t('settings.daemonGeneral.title', 'General')}
          description={t('settings.daemonGeneral.description', 'Maintain this machine daemon agent and access')}
          iconColor="text-slate-500"
        />
        <SettingCard>
          <p className="text-[13px] text-muted-foreground">
            {t('settings.daemonGeneral.noTeam', 'Join or create a team before configuring daemon agent settings.')}
          </p>
        </SettingCard>
      </div>
    )
  }

  return (
    <>
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <SectionHeader
          icon={Bot}
          title={t('settings.daemonGeneral.title', 'General')}
          description={t('settings.daemonGeneral.description', 'Maintain this machine daemon agent and access')}
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
              <p className="text-[13px] font-medium text-destructive">{t('common.error', 'Error')}</p>
              <p className="mt-1 break-words text-[13px] text-destructive/80">{error}</p>
            </div>
          </div>
        </SettingCard>
      )}

      {teamMismatch && (
        <SettingCard className="border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 space-y-1.5">
              <p className="text-[13px] font-medium text-amber-700 dark:text-amber-400">
                {t('settings.daemonGeneral.teamMismatchTitle', '本机 Daemon 与当前团队不一致')}
              </p>
              <p className="text-[12px] leading-5 text-amber-700/80 dark:text-amber-400/80">
                {t(
                  'settings.daemonGeneral.teamMismatchDesc',
                  'Daemon 绑定的团队与 App 当前选中的团队不同。团队共享内容会同步并软链到 Daemon 的团队，而非当前团队。如需让本机参与当前团队的共享，请用当前团队的邀请重新初始化 Daemon。',
                )}
              </p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-0.5 pt-0.5 text-[11px]">
                <dt className="text-amber-700/70 dark:text-amber-400/70">
                  {t('settings.daemonGeneral.daemonTeam', 'Daemon 团队')}
                </dt>
                <dd className="truncate font-mono text-amber-800 dark:text-amber-300">{daemonTeamId}</dd>
                <dt className="text-amber-700/70 dark:text-amber-400/70">
                  {t('settings.daemonGeneral.currentTeam', '当前团队')}
                </dt>
                <dd className="truncate font-mono text-amber-800 dark:text-amber-300">{team.id}</dd>
              </dl>
              <div className="pt-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
                  onClick={() => setRebinding(true)}
                  disabled={rebinding}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('settings.daemonGeneral.rebind', '重新绑定到当前团队')}
                </Button>
              </div>
            </div>
          </div>
        </SettingCard>
      )}

      {loading && !agent ? (
        <SettingCard>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SettingCard>
      ) : !agent ? (
        <SettingCard>
          <p className="text-[13px] text-muted-foreground">
            {t('settings.daemonGeneral.noAgent', 'No daemon agent is associated with this machine yet.')}
          </p>
        </SettingCard>
      ) : (
        <>
          <SettingCard>
            <div className="space-y-5">
              <div>
                <p className="text-[13px] font-semibold">{t('settings.daemonGeneral.basicInfo', 'Agent info')}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.daemonGeneral.basicInfoDesc', 'This is the daemon agent running on this machine.')}</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('settings.daemonGeneral.displayName', 'Display name')}</span>
                  <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={saving || !agent.isOwner} />
                </label>
                <div className="space-y-1.5">
                  <span className="block text-xs font-medium text-muted-foreground">{t('settings.daemonGeneral.visibility', 'Visibility')}</span>
                  <label className="flex h-9 items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={visibility === 'team'}
                      onChange={(event) => setVisibility(event.target.checked ? 'team' : 'personal')}
                      disabled={saving || !agent.isOwner}
                      className="h-4 w-4 shrink-0 rounded-[5px] border-border accent-coral disabled:opacity-60"
                    />
                    <span className="text-[13px] text-foreground">{t('settings.daemonGeneral.shareWithTeam', 'Share with the team')}</span>
                  </label>
                </div>
              </div>

              <div className="space-y-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t('settings.daemonGeneral.backendTypes', 'Backend types')}</span>
                  {agent.isOwner && agent.agentTypes.length > 1 && (
                    <span className="text-[11px] text-faint">{t('settings.daemonGeneral.backendHint', 'Click a type to make it the default')}</span>
                  )}
                </div>
                {agent.agentTypes.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    {t('settings.daemonGeneral.noBackends', 'This daemon has not advertised any backend types yet.')}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {agent.agentTypes.map((type) => {
                      const isDefault = type === defaultAgentType
                      const interactive = agent.isOwner && !saving
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => interactive && setDefaultAgentType(type)}
                          disabled={!interactive}
                          aria-pressed={isDefault}
                          title={isDefault
                            ? t('settings.daemonGeneral.isDefaultBackend', 'Default backend')
                            : t('settings.daemonGeneral.setAsDefault', 'Set as default backend')}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 font-mono text-[12px] transition-colors',
                            isDefault
                              ? 'bg-foreground text-background'
                              : 'border border-border bg-paper text-ink-2',
                            interactive && !isDefault && 'hover:border-foreground/25 hover:bg-selected/50',
                            !interactive && 'cursor-default',
                          )}
                        >
                          {isDefault && <Check className="h-3 w-3" />}
                          {type}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 gap-y-2.5 border-t border-border-soft pt-4 text-[12px]">
                <dt className="text-muted-foreground">{t('settings.daemonGeneral.agentId', 'Agent ID')}</dt>
                <dd className="truncate font-mono text-foreground">{agent.id}</dd>
                <dt className="text-muted-foreground">{t('settings.daemonGeneral.lastActive', 'Last active')}</dt>
                <dd className="font-mono text-ink-2">{formatRelative(agent.lastActiveAt)}</dd>
              </dl>

              <div className="flex items-center gap-3 border-t border-border-soft pt-4">
                <Button size="sm" className="gap-1.5" onClick={handleSaveProfile} disabled={saving || !agent.isOwner || !displayName.trim()}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {t('common.save', 'Save')}
                </Button>
                {!agent.isOwner && (
                  <p className="text-[11px] text-faint">
                    {t('settings.daemonGeneral.ownerOnly', 'Only the agent owner can edit profile and access settings.')}
                  </p>
                )}
              </div>
            </div>
          </SettingCard>

          <SettingCard>
            <div className="space-y-5">
              <div>
                <p className="text-[13px] font-semibold">{t('settings.daemonGeneral.accessTitle', 'Member access')}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.daemonGeneral.accessDesc', 'Rows are read from agent_member_access for this daemon agent.')}</p>
              </div>

              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
                <select
                  value={memberId}
                  onChange={(event) => setMemberId(event.target.value)}
                  disabled={saving || !agent.isOwner || members.length === 0}
                  className="h-9 rounded-[7px] border border-border bg-paper px-3 text-[13px] transition-colors focus:border-foreground/30 focus:outline-none disabled:opacity-60"
                >
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>{member.displayName}</option>
                  ))}
                </select>
                <select
                  value={permissionLevel}
                  onChange={(event) => setPermissionLevel(event.target.value as AgentPermissionLevel)}
                  disabled={saving || !agent.isOwner}
                  className="h-9 rounded-[7px] border border-border bg-paper px-3 text-[13px] transition-colors focus:border-foreground/30 focus:outline-none disabled:opacity-60"
                >
                  {permissionLevels.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
                <Button size="sm" className="h-9 gap-1.5" onClick={handleAddAccess} disabled={saving || !agent.isOwner || !memberId}>
                  <UserPlus className="h-3.5 w-3.5" />
                  {t('settings.daemonGeneral.addAccess', 'Add')}
                </Button>
              </div>

              <div className="space-y-2">
                {accessRows.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">{t('settings.daemonGeneral.noAccess', 'No member access rows yet.')}</p>
                ) : accessRows.map((row) => (
                  <div key={row.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-border-soft bg-background/40 px-3.5 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium">{row.memberName}</p>
                      <code className="block truncate font-mono text-[11px] text-faint">{row.memberId}</code>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <select
                        value={row.permissionLevel}
                        onChange={(event) => handleUpdateAccess(row, event.target.value as AgentPermissionLevel)}
                        disabled={saving || !agent.isOwner}
                        className="h-8 rounded-[7px] border border-border bg-paper px-2 text-xs transition-colors focus:border-foreground/30 focus:outline-none disabled:opacity-60"
                      >
                        {permissionLevels.map((level) => (
                          <option key={level} value={level}>{level}</option>
                        ))}
                      </select>
                      <Button variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive" onClick={() => handleRemoveAccess(row)} disabled={saving || !agent.isOwner || row.memberId === agent.id}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </SettingCard>
        </>
      )}
    </div>

      {rebinding && (
        <div className="fixed inset-0 z-50">
          {onboardingStatus === 'mismatch' && !onboardingBusy && (
            <button
              type="button"
              onClick={() => setRebinding(false)}
              className="absolute right-5 top-5 z-10 rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
            >
              {t('common.cancel', '取消')}
            </button>
          )}
          <DaemonOnboardingWizard
            onDone={() => {
              setRebinding(false)
              // Daemon is now bound to the current team — clear the warning and
              // reload the agent profile/access for the freshly-bound team.
              void loadDaemonTeamId()
              void load()
            }}
          />
        </div>
      )}
    </>
  )
}
