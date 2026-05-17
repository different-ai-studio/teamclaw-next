import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionListColumn } from '../SessionListColumn'
import { useUIStore } from '@/stores/ui'
import { useSessionStore } from '@/stores/session'
import { useSessionListStore } from '@/stores/session-list-store'

vi.mock('@/components/sidebar/session-search-dialog', () => ({
  SessionSearchDialog: () => null,
}))

// Sidebar UI primitives call useSidebar() which requires a SidebarProvider.
// In tests we render the column standalone, so stub these as plain wrappers
// and stub useSidebar to return an expanded sidebar by default.
vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ children, isActive: _isActive, ...rest }: React.ComponentProps<'button'> & { isActive?: boolean }) => (
    <button {...rest}>{children}</button>
  ),
  useSidebar: () => ({ state: 'expanded', open: true, setOpen: () => {}, toggleSidebar: () => {} }),
}))

vi.mock('@/components/app-sidebar', () => ({
  SidebarCollapseToggle: () => null,
}))

vi.mock('@/components/ui/traffic-lights', () => ({
  TrafficLights: () => null,
}))

const mkSessionRow = (over: Partial<{
  id: string
  title: string
  idea_id: string | null
  has_unread: boolean
}>) => ({
  id: 's1',
  title: 't',
  team_id: 'team-1',
  last_message_at: '2026-05-16T08:00:00.000Z',
  last_message_preview: null,
  mode: 'collab' as const,
  idea_id: null as string | null,
  has_unread: false,
  ...over,
})

describe('SessionListColumn', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' } })
    useSessionStore.setState({
      sessions: [],
      pinnedSessionIds: ['s1'],
      activeSessionId: null,
    } as any)
    useSessionListStore.setState({
      rows: [
        mkSessionRow({ id: 's1', title: 'Alpha', idea_id: null, has_unread: true }),
        mkSessionRow({ id: 's2', title: 'Beta', idea_id: 'idea-1' }),
        mkSessionRow({ id: 's3', title: 'Gamma', idea_id: 'idea-1' }),
      ],
      loading: false,
      error: null,
      hasMore: false,
      nextCursor: null,
    })
  })

  it('shows all non-cron sessions in "all" mode', () => {
    render(<SessionListColumn />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('shows a quiet unread indicator for unread inactive sessions', () => {
    render(<SessionListColumn />)
    expect(screen.getByLabelText('Unread')).toBeInTheDocument()
  })

  it('filters to pinned sessions in "pinned" mode', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'pinned' } })
    render(<SessionListColumn />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
  })

  it('filters by ideaId in "idea" mode', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'idea', ideaId: 'idea-1', title: 'I' } })
    render(<SessionListColumn />)
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('shows cron filter button only in "all" mode', () => {
    const { rerender } = render(<SessionListColumn />)
    expect(screen.getByRole('button', { name: /scheduled|all sessions/i })).toBeInTheDocument()
    useUIStore.setState({ sidebarFilter: { kind: 'pinned' } })
    rerender(<SessionListColumn />)
    expect(screen.queryByRole('button', { name: /scheduled|all sessions/i })).not.toBeInTheDocument()
  })
})
