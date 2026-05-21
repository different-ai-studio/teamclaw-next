import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentSelectorDock } from '../AgentSelectorDock'

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

  it('uses configured opencode provider models before the runtime advertises live models', async () => {
    mocks.activeSessionId = 'session-1'
    mocks.agentRuntimeRows = [
      { agent_id: 'a-1', runtime_id: 'runtime-1', backend_type: 'opencode' },
    ]
    mocks.providerModels = [
      { provider: 'claude-code', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
      { provider: 'opencode', id: 'kimi-k2', name: 'Kimi K2' },
      { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    ]

    render(
      <AgentSelectorDock
        engagedAgents={[
          { id: 'a-1', displayName: 'OpenCode Bot' },
        ]}
        onRemoveAgent={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByText('openai/gpt-5')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /OpenCode Bot/i }))

    expect(await screen.findByText('GPT-5')).toBeInTheDocument()
    expect(screen.getByText('Kimi K2')).toBeInTheDocument()
    expect(screen.queryByText('Claude Haiku 4.5')).not.toBeInTheDocument()
  })

  it('shows configured models when runtime only reports the current opencode model', async () => {
    mocks.activeSessionId = 'session-1'
    mocks.agentRuntimeRows = [
      { agent_id: 'a-1', runtime_id: 'runtime-1', backend_type: null },
    ]
    mocks.runtimeStates = {
      'runtime-1': {
        daemonDeviceId: 'a-1',
        lastUpdated: Date.now(),
        info: {
          availableModels: [],
          currentModel: 'openai/gpt-5',
        },
      },
    }
    mocks.providerModels = [
      { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
      { provider: 'opencode', id: 'kimi-k2', name: 'Kimi K2' },
    ]

    render(
      <AgentSelectorDock
        engagedAgents={[
          { id: 'a-1', displayName: 'OpenCode Bot' },
        ]}
        onRemoveAgent={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByText('openai/gpt-5')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /OpenCode Bot/i }))

    expect(await screen.findByText('GPT-5')).toBeInTheDocument()
    expect(screen.getByText('Kimi K2')).toBeInTheDocument()
  })
})
