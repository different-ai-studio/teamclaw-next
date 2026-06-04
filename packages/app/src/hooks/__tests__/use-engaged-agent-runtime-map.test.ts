import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useEngagedAgentRuntimeMap } from '../use-engaged-agent-runtime-map'

const mocks = vi.hoisted(() => ({
  agentRuntimeRows: [] as Array<{
    agent_id: string
    runtime_id: string
    backend_type: string | null
    session_id?: string | null
  }>,
  queriedTeamIds: [] as string[],
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    runtime: {
      listLatestAgentRuntimeHints: (teamId: string) => {
        mocks.queriedTeamIds.push(teamId)
        return Promise.resolve(mocks.agentRuntimeRows)
      },
    },
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({ team: { id: 'team-1' } }),
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: (selector: (s: unknown) => unknown) =>
    selector({
      rows: [
        { id: 'displayed-session', team_id: 'team-1' },
        { id: 'session-1', team_id: 'team-1' },
      ],
    }),
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: () => ({}),
}))

describe('useEngagedAgentRuntimeMap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentRuntimeRows = []
    mocks.queriedTeamIds = []
  })

  it('loads runtime mapping for the displayed session id', async () => {
    mocks.agentRuntimeRows = [
      {
        agent_id: 'a-1',
        runtime_id: 'runtime-1',
        backend_type: 'opencode',
        session_id: 'displayed-session',
      },
    ]

    const { result } = renderHook(() =>
      useEngagedAgentRuntimeMap('displayed-session', ['a-1']),
    )

    await waitFor(() => {
      expect(result.current.agentToRuntimeId.get('a-1')).toBe('runtime-1')
    })
    expect(mocks.queriedTeamIds).toContain('team-1')
    expect(result.current.agentToBackendType.get('a-1')).toBe('opencode')
  })

  it('clears maps when engaged agent list becomes empty', async () => {
    mocks.agentRuntimeRows = [
      {
        agent_id: 'a-1',
        runtime_id: 'runtime-1',
        backend_type: 'opencode',
        session_id: 'session-1',
      },
    ]

    const { result, rerender } = renderHook(
      ({ sessionId, ids }: { sessionId: string | null; ids: string[] }) =>
        useEngagedAgentRuntimeMap(sessionId, ids),
      { initialProps: { sessionId: 'session-1' as string | null, ids: ['a-1'] } },
    )

    await waitFor(() => {
      expect(result.current.agentToRuntimeId.get('a-1')).toBe('runtime-1')
    })

    rerender({ sessionId: 'session-1', ids: [] })
    await waitFor(() => {
      expect(result.current.agentToRuntimeId.size).toBe(0)
    })
  })
})
