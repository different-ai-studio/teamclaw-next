import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NavRail } from '../NavRail'
import { useUIStore } from '@/stores/ui'
import { useSessionStore } from '@/stores/session'
import { useSessionListStore } from '@/stores/session-list-store'

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

  it('shows pinned count badge in Pinned row', () => {
    useSessionListStore.setState({
      rows: [
        { id: 's1', title: 'A', team_id: 't1', last_message_at: null, last_message_preview: null, mode: 'collab', idea_id: null, has_unread: false, created_at: '', updated_at: '' },
        { id: 's2', title: 'B', team_id: 't1', last_message_at: null, last_message_preview: null, mode: 'collab', idea_id: null, has_unread: false, created_at: '', updated_at: '' },
      ],
      pinnedSessionIds: ['s1'],
    })
    render(<NavRail />)
    const pinnedButton = screen.getByRole('button', { name: /Pinned|已置顶/ })
    expect(pinnedButton).toHaveTextContent('1')
  })

  it('renders ActorsSection and an Ideas filter entry', () => {
    render(<NavRail />)
    expect(screen.getByTestId('actors-section')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ideas|想法/ })).toBeInTheDocument()
  })
})
