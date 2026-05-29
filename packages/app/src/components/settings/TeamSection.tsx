import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Users, Loader2, AlertCircle } from 'lucide-react'

import { TeamGitConfig } from './team/TeamGitConfig'
import { TeamOssSyncStatus } from './team/TeamOssSyncStatus'
import { TeamShareSection } from './team/TeamShareSection'
import { useTeamModeStore } from '@/stores/team-mode'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamShareStore } from '@/stores/team-share'
import { isTauri } from '@/lib/utils'
import { useTeamPermissions } from '@/lib/team-permissions'

// ─── Section Header ──────────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType
  title: string
  description: string
  iconColor?: string
}) {
  return (
    <div className="mb-6 flex items-start gap-4">
      <div className="rounded-[14px] border border-border-soft bg-panel p-3">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-[15px] font-semibold tracking-normal">{title}</h3>
        <p className="mt-1 text-[12.5px] text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

// ─── Missing prerequisite notice ─────────────────────────────────────────────
// Shown when team-share is not yet configured but we lack a team and/or workspace
// to target. Previously this case fell through to the legacy Git config form,
// which was misleading — surface the actual missing prerequisite instead.

function MissingPrereqNotice({
  teamId,
  workspacePath,
}: {
  teamId: string | null
  workspacePath: string | null
}) {
  const { t } = useTranslation()

  return (
    <section className="rounded-xl border border-border-soft bg-panel p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1.5">
          <h4 className="text-[13.5px] font-semibold">
            {t('settings.team.prereqTitle', '暂无法配置团队共享')}
          </h4>
          {!teamId && (
            <p className="text-[12px] leading-5 text-muted-foreground">
              {t(
                'settings.team.prereqNoTeam',
                '尚未创建或选择团队，请先创建/选择一个团队后再配置团队共享。',
              )}
            </p>
          )}
          {!workspacePath && (
            <p className="text-[12px] leading-5 text-muted-foreground">
              {t(
                'settings.team.prereqNoWorkspace',
                'workspacePath 为空，请先打开一个工作区。',
              )}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamSection() {
  const { t } = useTranslation()
  const teamModeType = useTeamModeStore((s) => s.teamModeType)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const shareMode = useTeamShareStore((s) => s.status.mode)
  const refreshShare = useTeamShareStore((s) => s.refresh)
  const { isOwner } = useTeamPermissions()

  // Resolve the FC share mode before deciding which page to render. Without
  // this, a configured team starts with shareMode === null and would flash the
  // onboarding wizard until some child component happened to refresh — which
  // read like "it jumped back to setup". Gate the decision on shareResolved so
  // we show a spinner instead of the wrong screen during that window.
  const [shareResolved, setShareResolved] = React.useState(false)
  React.useEffect(() => {
    if (!teamId || !workspacePath || !isTauri()) {
      setShareResolved(true)
      return
    }
    let cancelled = false
    setShareResolved(false)
    void refreshShare(teamId, workspacePath).finally(() => {
      if (!cancelled) setShareResolved(true)
    })
    return () => {
      cancelled = true
    }
  }, [teamId, workspacePath, refreshShare])

  // Two notions of "mode" coexist:
  //   - teamModeType ('git' | 'webdav' | null): legacy, from local teamclaw.json
  //   - shareMode ('oss' | 'managed_git' | 'custom_git' | null): the FC-locked share mode
  // A team is "already configured" if either source reports a mode. New teams (PR #213
  // no longer auto-create team-share) report neither — those land in the onboarding wizard.
  //
  // Route on the FC shareMode first: a team that locked 'oss' via the share-mode
  // flow has shareMode === 'oss' but its local teamModeType is still null until
  // the OSS directory is configured locally. Keying isOss on teamModeType alone
  // sent those freshly-OSS-enabled teams to the Git config form. Fall back to the
  // legacy teamModeType only when shareMode is absent (older teams).
  const isOss =
    shareMode === 'oss' || (shareMode === null && teamModeType === 'webdav')
  const isConfigured = shareMode !== null || teamModeType !== null

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Users}
        title={t('settings.team.title', 'Team Shared')}
        description={t(
          'settings.team.description',
          'Configure the team shared Git repository, local shared directory, and sync status',
        )}
      />

      {teamId && workspacePath && !shareResolved ? (
        // Prereqs present but the FC share mode is still loading — show a spinner
        // rather than briefly flashing the wizard / git form before we know it.
        <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('settings.team.loadingShareMode', 'Loading team share status…')}
        </div>
      ) : !isConfigured ? (
        // New team (PR #213 no longer auto-creates team-share): show the onboarding
        // wizard so the owner can lock in oss / managed_git / custom_git. This needs a
        // team + workspace to target; without them, surface the missing prerequisite
        // instead of falling through to the (misleading) legacy Git config form.
        teamId && workspacePath ? (
          <TeamShareSection
            teamId={teamId}
            workspacePath={workspacePath}
            isOwner={isOwner}
          />
        ) : (
          <MissingPrereqNotice teamId={teamId} workspacePath={workspacePath} />
        )
      ) : isOss ? (
        <TeamOssSyncStatus />
      ) : (
        <TeamGitConfig />
      )}
    </div>
  )
}
