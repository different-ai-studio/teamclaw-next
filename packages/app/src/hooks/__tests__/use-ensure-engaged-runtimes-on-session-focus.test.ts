import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  agentIdsNeedingRuntimeWake,
  useEnsureEngagedRuntimesOnSessionFocus,
} from '../use-ensure-engaged-runtimes-on-session-focus'
import type { EngagedAgentUiEntry } from '../use-engaged-agent-ui-states'

const ensureMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/teamclaw/ensure-agent-runtime', () => ({
  ensureAgentRuntimesForSession: ensureMock,
}))

function entry(id: string, uiState: EngagedAgentUiEntry['uiState']): EngagedAgentUiEntry {
  return { agent: { id, displayName: id }, uiState }
}

describe('agentIdsNeedingRuntimeWake', () => {
  it('includes connecting and offline agents only', () => {
    expect(
      agentIdsNeedingRuntimeWake([
        entry('a1', 'ready'),
        entry('a2', 'connecting'),
        entry('a3', 'offline'),
        entry('a4', 'stale'),
      ]),
    ).toEqual(['a2', 'a3'])
  })
})

describe('useEnsureEngagedRuntimesOnSessionFocus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ensures non-ready agents when session focus changes', () => {
    const { rerender } = renderHook(
      (props: {
        sessionId: string | null
        teamId: string | null
        engagedUiEntries: EngagedAgentUiEntry[]
      }) => useEnsureEngagedRuntimesOnSessionFocus(props),
      {
        initialProps: {
          sessionId: 'session-a',
          teamId: 'team-1',
          engagedUiEntries: [entry('agent-1', 'connecting')],
        },
      },
    )

    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-a',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_focus',
    })

    ensureMock.mockClear()

    rerender({
      sessionId: 'session-b',
      teamId: 'team-1',
      engagedUiEntries: [entry('agent-1', 'offline')],
    })

    expect(ensureMock).toHaveBeenCalledWith({
      sessionId: 'session-b',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
      reason: 'session_focus',
    })
  })

  it('does not ensure when focus unchanged or all agents ready', () => {
    const { rerender } = renderHook(
      (props: {
        sessionId: string | null
        teamId: string | null
        engagedUiEntries: EngagedAgentUiEntry[]
      }) => useEnsureEngagedRuntimesOnSessionFocus(props),
      {
        initialProps: {
          sessionId: 'session-a',
          teamId: 'team-1',
          engagedUiEntries: [entry('agent-1', 'ready')],
        },
      },
    )

    expect(ensureMock).not.toHaveBeenCalled()

    rerender({
      sessionId: 'session-a',
      teamId: 'team-1',
      engagedUiEntries: [entry('agent-1', 'connecting')],
    })

    expect(ensureMock).not.toHaveBeenCalled()
  })
})
