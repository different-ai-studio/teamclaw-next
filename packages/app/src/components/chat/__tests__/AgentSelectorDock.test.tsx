import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentSelectorDock, resolveAgentAvailableModels } from '../AgentSelectorDock'
import { useAgentModelPickStore } from '@/stores/agent-model-pick-store'

const mocks = vi.hoisted(() => ({
  agentRuntimeRows: [] as Array<{ agent_id: string; runtime_id: string; backend_type: string | null; session_id?: string | null }>,
  runtimeStates: {} as Record<string, unknown>,
  queriedTeamIds: [] as string[],
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
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
    selector({ rows: [{ id: 'displayed-session', team_id: 'team-1' }, { id: 'session-1', team_id: 'team-1' }] }),
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: (selector: (s: unknown) => unknown) =>
    selector({ byRuntimeId: mocks.runtimeStates }),
}))

vi.mock('@/lib/teamclaw-rpc', () => ({
  setModel: vi.fn(),
}))

describe('AgentSelectorDock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentRuntimeRows = []
    mocks.runtimeStates = {}
    mocks.queriedTeamIds = []
    useAgentModelPickStore.setState({ bySessionAgent: {} })
  })

  it('renders nothing when no agents are engaged', () => {
    const { container } = render(
      <AgentSelectorDock
        activeSessionId={null}
        engagedAgents={[]}
        onRemoveAgent={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders one pill per engaged agent', () => {
    render(
      <AgentSelectorDock
        activeSessionId={null}
        engagedAgents={[
          { id: 'a-1', displayName: 'Reviewer Bot' },
          { id: 'a-2', displayName: 'Ops Buddy' },
        ]}
        onRemoveAgent={vi.fn()}
      />,
    )
    expect(screen.getByText('Reviewer Bot')).toBeInTheDocument()
    expect(screen.getByText('Ops Buddy')).toBeInTheDocument()
  })

  it('does not synthesize fallback models when runtime info has not advertised models', () => {
    expect(resolveAgentAvailableModels(undefined)).toEqual([])
    expect(resolveAgentAvailableModels({ availableModels: [] } as any)).toEqual([])
    expect(resolveAgentAvailableModels({
      availableModels: [{ id: 'm-1', displayName: 'Model One' }],
    } as any)).toEqual([{ id: 'm-1', displayName: 'Model One' }])
  })

  it('loads runtime mapping for the displayed session id instead of legacy global state', async () => {
    mocks.agentRuntimeRows = [
      { agent_id: 'a-1', runtime_id: 'runtime-1', backend_type: 'opencode', session_id: 'displayed-session' },
    ]

    render(
      <AgentSelectorDock
        activeSessionId="displayed-session"
        engagedAgents={[
          { id: 'a-1', displayName: 'OpenCode Bot' },
        ]}
        onRemoveAgent={vi.fn()}
      />,
    )

    await screen.findByText('OpenCode Bot')
    expect(mocks.queriedTeamIds).toContain('team-1')
  })

  it('shows ACP-advertised models when retain is keyed by agent id but DB runtime id differs', async () => {
    mocks.agentRuntimeRows = [
      { agent_id: 'a-1', runtime_id: 'uuid-db', backend_type: 'opencode', session_id: 'session-1' },
    ]
    mocks.runtimeStates = {
      'a-1': {
        daemonActorId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          agentType: 2,
          availableModels: [{ id: 'anthropic/claude-sonnet-4.6', displayName: 'Sonnet 4.6' }],
          currentModel: 'anthropic/claude-sonnet-4.6',
        },
      },
    }

    render(
      <AgentSelectorDock
        activeSessionId="session-1"
        engagedAgents={[{ id: 'a-1', displayName: 'OpenCode Bot' }]}
        onRemoveAgent={vi.fn()}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: /OpenCode Bot/i }))
    expect((await screen.findAllByText('Sonnet 4.6')).length).toBeGreaterThanOrEqual(1)
  })

  it('keeps the newest runtime row when duplicate rows arrive newest-first', async () => {
    mocks.agentRuntimeRows = [
      { agent_id: 'a-1', runtime_id: 'runtime-new', backend_type: 'opencode', session_id: 'session-1' },
      { agent_id: 'a-1', runtime_id: 'runtime-old', backend_type: 'claude', session_id: 'session-1' },
    ]
    mocks.runtimeStates = {
      'runtime-new': {
        daemonActorId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          availableModels: [],
          currentModel: 'new-model',
        },
      },
      'runtime-old': {
        daemonActorId: 'a-1',
        lastUpdated: Date.now() - 1,
        info: {
          availableModels: [],
          currentModel: 'old-model',
        },
      },
    }

    render(
      <AgentSelectorDock
        activeSessionId="session-1"
        engagedAgents={[
          { id: 'a-1', displayName: 'OpenCode Bot' },
        ]}
        onRemoveAgent={vi.fn()}
      />,
    )

    expect(await screen.findByText('new-model')).toBeInTheDocument()
    expect(screen.queryByText('old-model')).not.toBeInTheDocument()
  })

  it('does not refetch runtime hints in a loop when retain payload changes but runtime ids stay the same', async () => {
    mocks.agentRuntimeRows = []
    const retainEntry = {
      daemonActorId: 'a-1',
      lastUpdated: Date.now(),
      info: {
        availableModels: [{ id: 'm-1', displayName: 'Model One' }],
        currentModel: 'm-1',
      },
    }
    mocks.runtimeStates = { 'a-1': retainEntry }

    const props = {
      activeSessionId: 'session-1' as const,
      engagedAgents: [{ id: 'a-1', displayName: 'OpenCode Bot' }],
      onRemoveAgent: vi.fn(),
    }

    const { rerender } = render(<AgentSelectorDock {...props} />)

    await screen.findByText('OpenCode Bot')
    await new Promise((r) => setTimeout(r, 50))
    const callsAfterMount = mocks.queriedTeamIds.length

    for (let i = 0; i < 5; i += 1) {
      mocks.runtimeStates = {
        'a-1': {
          ...retainEntry,
          lastUpdated: Date.now() + i + 1,
          info: {
            ...retainEntry.info,
            currentModel: `m-${i}`,
          },
        },
      }
      rerender(<AgentSelectorDock {...props} />)
    }

    await new Promise((r) => setTimeout(r, 50))
    expect(mocks.queriedTeamIds.length).toBe(callsAfterMount)
  })

  it('shows loading when runtime has not advertised ACP models yet', async () => {
    mocks.agentRuntimeRows = [
      { agent_id: 'a-1', runtime_id: 'runtime-1', backend_type: 'opencode', session_id: 'session-1' },
    ]
    mocks.runtimeStates = {
      'runtime-1': {
        daemonActorId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          availableModels: [],
          currentModel: '',
        },
      },
    }

    render(
      <AgentSelectorDock
        activeSessionId="session-1"
        engagedAgents={[{ id: 'a-1', displayName: 'OpenCode Bot' }]}
        onRemoveAgent={vi.fn()}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: /OpenCode Bot/i }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})
