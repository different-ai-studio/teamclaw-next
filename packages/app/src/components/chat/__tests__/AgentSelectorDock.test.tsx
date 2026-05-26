import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentSelectorDock, resolveAgentAvailableModels } from '../AgentSelectorDock'

const mocks = vi.hoisted(() => ({
  agentRuntimeRows: [] as Array<{ agent_id: string; runtime_id: string; backend_type: string | null; session_id?: string | null }>,
  runtimeStates: {} as Record<string, unknown>,
  providerModels: [] as Array<{ provider: string; id: string; name: string }>,
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

vi.mock('@/stores/provider', () => ({
  useProviderStore: (selector: (s: unknown) => unknown) =>
    selector({ models: mocks.providerModels }),
}))

vi.mock('@/lib/teamclaw-rpc', () => ({
  setModel: vi.fn(),
}))

describe('AgentSelectorDock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentRuntimeRows = []
    mocks.runtimeStates = {}
    mocks.providerModels = []
    mocks.queriedTeamIds = []
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

  it('keeps the newest runtime row when duplicate rows arrive newest-first', async () => {
    mocks.agentRuntimeRows = [
      { agent_id: 'a-1', runtime_id: 'runtime-new', backend_type: 'opencode', session_id: 'session-1' },
      { agent_id: 'a-1', runtime_id: 'runtime-old', backend_type: 'claude', session_id: 'session-1' },
    ]
    mocks.runtimeStates = {
      'runtime-new': {
        daemonDeviceId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          availableModels: [],
          currentModel: 'new-model',
        },
      },
      'runtime-old': {
        daemonDeviceId: 'a-1',
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

  it('uses dynamic provider-store models for the agent backend while waiting for runtime advertised models', async () => {
    mocks.agentRuntimeRows = [
      { agent_id: 'a-1', runtime_id: 'runtime-1', backend_type: 'opencode', session_id: 'session-1' },
    ]
    mocks.runtimeStates = {
      'runtime-1': {
        daemonDeviceId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          availableModels: [],
          currentModel: '',
        },
      },
    }
    mocks.providerModels = [
      { provider: 'opencode', id: 'opencode/qwen3.6-plus-free', name: 'OpenCode Zen/Qwen3.6 Plus Free' },
      { provider: 'scnet', id: 'minimax-m2.5', name: 'MiniMax-M2.5' },
      { provider: 'claude-code', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    ]

    render(
      <AgentSelectorDock
        activeSessionId="session-1"
        engagedAgents={[
          { id: 'a-1', displayName: 'OpenCode Bot' },
        ]}
        onRemoveAgent={vi.fn()}
      />,
    )

    await screen.findByText('opencode/qwen3.6-plus-free')
    await userEvent.click(screen.getByRole('button', { name: /OpenCode Bot/i }))

    expect(await screen.findByText('OpenCode Zen/Qwen3.6 Plus Free')).toBeInTheDocument()
    expect(screen.getByText('MiniMax-M2.5')).toBeInTheDocument()
    expect(screen.queryByText('Claude Sonnet 4.6')).not.toBeInTheDocument()
  })
})
