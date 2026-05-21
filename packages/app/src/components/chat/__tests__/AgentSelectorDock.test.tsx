import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentSelectorDock, resolveAgentAvailableModels } from '../AgentSelectorDock'

const mocks = vi.hoisted(() => ({
  activeSessionId: null as string | null,
  agentRuntimeRows: [] as Array<{ agent_id: string; runtime_id: string; backend_type: string | null }>,
  runtimeStates: {} as Record<string, unknown>,
  providerModels: [] as Array<{ provider: string; id: string; name: string }>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: mocks.agentRuntimeRows, error: null }),
        in: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
          not: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
  },
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: (selector: (s: unknown) => unknown) =>
    selector({ byRuntimeId: mocks.runtimeStates }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ activeSessionId: mocks.activeSessionId }),
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
    mocks.activeSessionId = null
    mocks.agentRuntimeRows = []
    mocks.runtimeStates = {}
    mocks.providerModels = []
  })

  it('renders nothing when no agents are engaged', () => {
    const { container } = render(
      <AgentSelectorDock
        engagedAgents={[]}
        onRemoveAgent={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders one pill per engaged agent', () => {
    render(
      <AgentSelectorDock
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

  it('uses dynamic provider-store models for the agent backend while waiting for runtime advertised models', async () => {
    mocks.activeSessionId = 'session-1'
    mocks.agentRuntimeRows = [
      { agent_id: 'a-1', runtime_id: 'runtime-1', backend_type: 'opencode' },
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
