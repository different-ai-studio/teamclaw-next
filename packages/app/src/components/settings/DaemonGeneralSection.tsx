import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Bot, Loader2, RefreshCw, Save, Shield, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCurrentTeamStore } from '@/stores/current-team'
import {
  getCurrentDaemonAgent,
  listAgentAccess,
  listTeamMembersForAccess,
  removeAgentAccess,
  updateCurrentDaemonAgent,
  upsertAgentAccess,
  type AgentAccessRow,
  type AgentPermissionLevel,
  type AgentVisibility,
  type CurrentDaemonAgent,
  type TeamMemberOption,
} from '@/lib/daemon-agent-admin'
import { cn } from '@/lib/utils'
import { SectionHeader, SettingCard } from './shared'

const permissionLevels: AgentPermissionLevel[] = ['view', 'prompt', 'admin']
const visibilityOptions: AgentVisibility[] = ['personal', 'team']

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
  const [memberId, setMemberId] = React.useState('')
  const [permissionLevel, setPermissionLevel] = React.useState<AgentPermissionLevel>('prompt')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    if (!team?.id) return
    setLoading(true)
    setError(null)
    try {
      const nextAgent = await getCurrentDaemonAgent(team.id)
      setAgent(nextAgent)
      setDisplayName(nextAgent?.displayName ?? '')
      setVisibility(nextAgent?.visibility ?? 'team')
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
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                  <Bot className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.daemonGeneral.basicInfo', 'Agent info')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.daemonGeneral.basicInfoDesc', 'This is the daemon agent matched to the local device id.')}</p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('settings.daemonGeneral.displayName', 'Display name')}</span>
                  <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={saving || !agent.isOwner} />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('settings.daemonGeneral.visibility', 'Visibility')}</span>
                  <select
                    value={visibility}
                    onChange={(event) => setVisibility(event.target.value as AgentVisibility)}
                    disabled={saving || !agent.isOwner}
                    className="h-8 w-full rounded-md border border-input bg-background px-3 text-[13px]"
                  >
                    {visibilityOptions.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid gap-2 rounded-lg border border-border-soft bg-background/50 p-3 text-xs sm:grid-cols-[128px_minmax(0,1fr)]">
                <span className="text-muted-foreground">{t('settings.daemonGeneral.agentId', 'Agent ID')}</span>
                <code className="break-all font-mono text-foreground">{agent.id}</code>
                <span className="text-muted-foreground">{t('settings.daemonGeneral.deviceId', 'Device ID')}</span>
                <code className="break-all font-mono text-foreground">{agent.deviceId || '-'}</code>
                <span className="text-muted-foreground">{t('settings.daemonGeneral.backendTypes', 'Backend types')}</span>
                <code className="break-all font-mono text-foreground">{agent.agentTypes.join(', ') || '-'}</code>
                <span className="text-muted-foreground">{t('settings.daemonGeneral.defaultBackend', 'Default backend')}</span>
                <code className="break-all font-mono text-foreground">{agent.defaultAgentType || '-'}</code>
                <span className="text-muted-foreground">{t('settings.daemonGeneral.lastActive', 'Last active')}</span>
                <span>{formatRelative(agent.lastActiveAt)}</span>
              </div>

              <Button size="sm" className="gap-1.5" onClick={handleSaveProfile} disabled={saving || !agent.isOwner || !displayName.trim()}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {t('common.save', 'Save')}
              </Button>
              {!agent.isOwner && (
                <p className="text-xs text-muted-foreground">
                  {t('settings.daemonGeneral.ownerOnly', 'Only the agent owner can edit profile and access settings.')}
                </p>
              )}
            </div>
          </SettingCard>

          <SettingCard>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                  <Shield className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-[13px] font-medium">{t('settings.daemonGeneral.accessTitle', 'Member access')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.daemonGeneral.accessDesc', 'Rows are read from agent_member_access for this daemon agent.')}</p>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
                <select
                  value={memberId}
                  onChange={(event) => setMemberId(event.target.value)}
                  disabled={saving || !agent.isOwner || members.length === 0}
                  className="h-8 rounded-md border border-input bg-background px-3 text-[13px]"
                >
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>{member.displayName}</option>
                  ))}
                </select>
                <select
                  value={permissionLevel}
                  onChange={(event) => setPermissionLevel(event.target.value as AgentPermissionLevel)}
                  disabled={saving || !agent.isOwner}
                  className="h-8 rounded-md border border-input bg-background px-3 text-[13px]"
                >
                  {permissionLevels.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
                <Button size="sm" className="h-8 gap-1.5" onClick={handleAddAccess} disabled={saving || !agent.isOwner || !memberId}>
                  <UserPlus className="h-3.5 w-3.5" />
                  {t('settings.daemonGeneral.addAccess', 'Add')}
                </Button>
              </div>

              <div className="space-y-2">
                {accessRows.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">{t('settings.daemonGeneral.noAccess', 'No member access rows yet.')}</p>
                ) : accessRows.map((row) => (
                  <div key={row.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-soft bg-background/50 p-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium">{row.memberName}</p>
                      <code className="block truncate font-mono text-xs text-muted-foreground">{row.memberId}</code>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <select
                        value={row.permissionLevel}
                        onChange={(event) => handleUpdateAccess(row, event.target.value as AgentPermissionLevel)}
                        disabled={saving || !agent.isOwner}
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
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
  )
}
