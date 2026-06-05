import * as React from 'react'
import { getLocalDaemonAgent } from '@/lib/daemon-agent-admin'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { useWorkspaceStore } from '@/stores/workspace'

export type QuickChatState =
  | { kind: 'loading' }
  | { kind: 'no_workspace' }
  | { kind: 'no_team' }
  | { kind: 'daemon_down' }
  | { kind: 'agent_not_bound' }
  | { kind: 'ready' }

export function useQuickChatReadiness(): QuickChatState {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const daemonReady = useDaemonOnboardingStore((s) => s.status === 'ready')
  const [checking, setChecking] = React.useState(false)
  const [localAgentBound, setLocalAgentBound] = React.useState(false)

  React.useEffect(() => {
    if (!teamId || !workspacePath || !daemonReady) {
      setLocalAgentBound(false)
      setChecking(false)
      return
    }

    let cancelled = false
    setChecking(true)
    void getLocalDaemonAgent(teamId).then((agent) => {
      if (!cancelled) {
        setLocalAgentBound(!!agent?.id)
        setChecking(false)
      }
    })
    return () => { cancelled = true }
  }, [teamId, workspacePath, daemonReady])

  return React.useMemo((): QuickChatState => {
    if (!workspacePath) return { kind: 'no_workspace' }
    if (!teamId) return { kind: 'no_team' }
    if (!daemonReady) return { kind: 'daemon_down' }
    if (checking) return { kind: 'loading' }
    if (!localAgentBound) return { kind: 'agent_not_bound' }
    return { kind: 'ready' }
  }, [workspacePath, teamId, daemonReady, checking, localAgentBound])
}
