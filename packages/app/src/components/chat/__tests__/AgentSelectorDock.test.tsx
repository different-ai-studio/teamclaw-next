import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentSelectorDock } from '../AgentSelectorDock'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [], error: null }),
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
    selector({ byRuntimeId: {} }),
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ activeSessionId: null }),
}))

vi.mock('@/lib/teamclaw-rpc', () => ({
  setModel: vi.fn(),
}))

describe('AgentSelectorDock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
