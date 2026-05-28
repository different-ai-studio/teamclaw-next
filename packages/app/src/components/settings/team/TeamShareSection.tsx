import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTeamShareStore, type ShareMode } from '@/stores/team-share'
import { EnableShareWizard } from './EnableShareWizard'

interface Props {
  teamId: string
  workspacePath: string
  isOwner: boolean
}

const MODE_LABEL: Record<Exclude<ShareMode, null>, string> = {
  oss: 'OSS',
  managed_git: '托管 Git',
  custom_git: '自建 Git',
}

/**
 * Team-share onboarding panel.
 *
 * States:
 *   - loading: spinner
 *   - mode === null: "团队共享未开通" + (owner) "开通" button → opens wizard
 *   - mode !== null: "已开通：{label}" — locked, no toggle
 */
export function TeamShareSection({ teamId, workspacePath, isOwner }: Props) {
  const status = useTeamShareStore((s) => s.status)
  const loading = useTeamShareStore((s) => s.loading)
  const lastError = useTeamShareStore((s) => s.lastError)
  const refresh = useTeamShareStore((s) => s.refresh)

  const [wizardOpen, setWizardOpen] = useState(false)

  useEffect(() => {
    if (!teamId || !workspacePath) return
    void refresh(teamId, workspacePath)
  }, [teamId, workspacePath, refresh])

  return (
    <section className="rounded-xl border border-border-soft bg-panel p-4 space-y-3">
      <div>
        <h4 className="text-[13.5px] font-semibold">团队共享</h4>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          团队共享模式一经开通，不可切换。
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          加载中…
        </div>
      ) : status.mode === null ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-foreground">团队共享未开通</p>
          {isOwner && (
            <Button size="sm" onClick={() => setWizardOpen(true)}>
              开通
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-[12.5px]">
            已开通:
            <span className="ml-1 font-medium">{MODE_LABEL[status.mode]}</span>
          </p>
          {status.gitRemoteUrl && (
            <p className="text-[12px] text-muted-foreground break-all">
              仓库：{status.gitRemoteUrl}
            </p>
          )}
        </div>
      )}

      {lastError && (
        <p className="text-[12px] text-red-500">{lastError}</p>
      )}

      {isOwner && (
        <EnableShareWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          teamId={teamId}
          workspacePath={workspacePath}
        />
      )}
    </section>
  )
}
