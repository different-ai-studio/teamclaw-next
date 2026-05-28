import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2 } from 'lucide-react'

import { TeamSecretEntry } from '@/components/settings/team/TeamSecretEntry'

type Phase = 'loading' | 'not_opened' | 'initializing' | 'secret_prompt' | 'error'

interface StatusResponse {
  mode: 'oss' | 'managed_git' | 'custom_git' | null
}

interface JoinResult {
  initialized: boolean
  shareMode: string | null
}

interface Props {
  teamId: string
  workspacePath: string
  onDone?: () => void
}

/**
 * Task 12 — JoinTeamFlow.
 *
 * After a user claims an invite, this component:
 *   1. Fetches `team_share_get_status` to learn if the owner has enabled a
 *      share mode.
 *   2. If `mode === null`, displays an "owner hasn't enabled share yet" notice.
 *   3. Otherwise auto-invokes `team_share_join_existing` which writes
 *      `oss_team_id`, `share_mode`, `git_remote_url`, `litellm_team_id` into
 *      the local `teamclaw.json` and creates `teamclaw-team/`.
 *   4. Prompts the user to paste their team secret via `TeamSecretEntry`.
 *
 * Per spec: the team secret must be entered manually. We do not auto-import.
 */
export function JoinTeamFlow({ teamId, workspacePath, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [mode, setMode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const status = await invoke<StatusResponse>('team_share_get_status', {
          teamId,
          workspacePath,
        })
        if (cancelled) return
        if (status?.mode == null) {
          setPhase('not_opened')
          return
        }
        setPhase('initializing')
        const res = await invoke<JoinResult>('team_share_join_existing', {
          teamId,
          workspacePath,
        })
        if (cancelled) return
        if (!res.initialized) {
          setPhase('not_opened')
          return
        }
        setMode(res.shareMode)
        setPhase('secret_prompt')
      } catch (e) {
        if (cancelled) return
        setError(String(e))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [teamId, workspacePath])

  if (phase === 'loading' || phase === 'initializing') {
    return (
      <div className="flex items-center gap-2 text-sm text-neutral-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{phase === 'loading' ? '正在检查团队共享状态…' : '正在初始化团队工作区…'}</span>
      </div>
    )
  }

  if (phase === 'not_opened') {
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium">已加入团队</p>
        <p className="text-[12px] text-neutral-600">
          团队共享未开通，待 owner 开通后即可同步。
        </p>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <p className="text-[12px] text-red-500">加入流程失败：{error}</p>
    )
  }

  // secret_prompt
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">已加入团队（模式：{mode ?? '未知'}）</p>
        <p className="text-[12px] text-neutral-600">
          请输入团队密钥以解密共享内容。密钥由邀请人提供。
        </p>
      </div>
      <TeamSecretEntry teamId={teamId} workspacePath={workspacePath} onSaved={onDone} />
    </div>
  )
}
