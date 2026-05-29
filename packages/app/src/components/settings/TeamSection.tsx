import * as React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { Users, ArrowRightLeft, Loader2 } from 'lucide-react'

import { TeamGitConfig } from './team/TeamGitConfig'
import { TeamWebDavConfig } from './team/TeamWebDavConfig'
import { TeamShareSection } from './team/TeamShareSection'
import { Button } from '@/components/ui/button'
import { useTeamModeStore } from '@/stores/team-mode'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamShareStore } from '@/stores/team-share'
import { isTauri } from '@/lib/utils'

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

// ─── OSS → Git switch entry (owner only) ─────────────────────────────────────

function SwitchToGitEntry() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const loadTeamConfig = useTeamModeStore((s) => s.loadTeamConfig)
  const [switching, setSwitching] = useState(false)

  const handleSwitch = async () => {
    if (!teamId || !workspacePath || !isTauri()) return
    const confirmed = window.confirm(
      t(
        'settings.team.switchToGitConfirm',
        '切换为 Git 共享后，团队将通过 Git 仓库同步知识与配置。已通过 OSS 同步的文件不会自动迁移，需手动处理。是否继续？',
      ),
    )
    if (!confirmed) return

    setSwitching(true)
    try {
      await invoke('oss_sync_set_team_sync_mode', {
        workspacePath,
        teamId,
        mode: 'git',
      })
      await loadTeamConfig(workspacePath)
      toast.success(
        t('settings.team.switchToGitDone', '已切换到 Git 共享，请在下方完成 Git 配置。'),
      )
    } catch (error) {
      console.error('[TeamSection] switch to git failed:', error)
      toast.error(String(error))
    } finally {
      setSwitching(false)
    }
  }

  return (
    <section className="rounded-xl border border-border-soft bg-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-[13.5px] font-semibold">
            {t('settings.team.switchToGitTitle', '切换为 Git 共享')}
          </h4>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
            {t(
              'settings.team.switchToGitBody',
              '作为团队 owner，你可以把团队共享切换为 Git 模式（仅切换模式，不迁移已同步数据）。',
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleSwitch}
          disabled={switching}
          className="shrink-0"
        >
          {switching ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('settings.team.switchToGit', '切换为 Git')}
        </Button>
      </div>
    </section>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TeamSection() {
  const { t } = useTranslation()
  const teamModeType = useTeamModeStore((s) => s.teamModeType)
  const myRole = useTeamModeStore((s) => s.myRole)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const currentMemberRole = useCurrentTeamStore((s) => s.currentMember?.role ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const shareMode = useTeamShareStore((s) => s.status.mode)

  // Two notions of "mode" coexist:
  //   - teamModeType ('git' | 'webdav' | null): legacy, from local teamclaw.json
  //   - shareMode ('oss' | 'managed_git' | 'custom_git' | null): the FC-locked share mode
  // A team is "already configured" if either source reports a mode. New teams (PR #213
  // no longer auto-create team-share) report neither — those land in the onboarding wizard.
  const isOss = teamModeType === 'webdav'
  // Ownership for the "enable team-share" action comes from the cloud membership
  // role, which is set the moment a team exists (e.g. an anonymous user is the
  // owner of their own team). team-mode's myRole only resolves once team-share
  // is already active, so relying on it alone hid the 开通 button from owners of
  // not-yet-configured teams.
  const isOwner = currentMemberRole === 'owner' || myRole === 'owner'
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

      {!isConfigured && teamId && workspacePath ? (
        // New team (PR #213 no longer auto-creates team-share): show the onboarding
        // wizard so the owner can lock in oss / managed_git / custom_git. Needs a team +
        // workspace to target; without them we fall through to the legacy config UI.
        <TeamShareSection
          teamId={teamId}
          workspacePath={workspacePath}
          isOwner={isOwner}
        />
      ) : isOss ? (
        <>
          {isOwner && <SwitchToGitEntry />}
          <TeamWebDavConfig />
        </>
      ) : (
        <TeamGitConfig />
      )}
    </div>
  )
}
