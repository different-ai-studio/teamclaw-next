import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NavRail } from '../NavRail'
import { useUIStore } from '@/stores/ui'
import { useSessionStore } from '@/stores/session'

vi.mock('@/components/sidebar/ActorsSection', () => ({
  ActorsSection: () => <div data-testid="actors-section" />,
}))
vi.mock('@/components/sidebar/NewChatSplitButton', () => ({
  NewChatSplitButton: () => <div data-testid="new-chat-split" />,
}))
vi.mock('@/hooks/use-quick-chat-readiness', () => ({
  useQuickChatReadiness: () => ({ kind: 'ready' }),
}))
vi.mock('sonner', () => ({
  toast: vi.fn(),
}))

describe('NavRail', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' } })
    useSessionStore.setState({ sessions: [
      { id: 's1', title: 'A', messages: [], createdAt: new Date(), updatedAt: new Date() },
      { id: 's2', title: 'B', messages: [], createdAt: new Date(), updatedAt: new Date() },
    ] as any })
  })

  it('clicking Sessions sets filter to { kind: "all" }', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'pinned' } })
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /会话/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'all' })
  })

  it('clicking Pinned sets filter to { kind: "pinned" }', () => {
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /已置顶/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'pinned' })
  })

  it('clicking Shortcuts sets filter to { kind: "shortcuts" }', () => {
    render(<NavRail />)
    fireEvent.click(screen.getByRole('button', { name: /快捷方式/ }))
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'shortcuts' })
  })

  it('shows session count badge in Sessions row', () => {
    render(<NavRail />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders ActorsSection and an Ideas filter entry', () => {
    render(<NavRail />)
    expect(screen.getByTestId('actors-section')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ideas|想法/ })).toBeInTheDocument()
  })
})
