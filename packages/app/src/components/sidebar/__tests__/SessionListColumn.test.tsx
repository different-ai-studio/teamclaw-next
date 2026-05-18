import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionListColumn } from '../SessionListColumn'
import { useUIStore } from '@/stores/ui'
import { useSessionListStore } from '@/stores/session-list-store'
import { useSessionStore } from '@/stores/session'

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

const mkSession = (over: Partial<{ id: string; title: string; ideaId: string | null; updatedAt: Date }>) => ({
  id: 's1',
  title: 't',
  messages: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ideaId: null as string | null,
  ...over,
}) as any

const mkRow = (over: Partial<{ id: string; title: string; ideaId: string | null; lastMessageAt: string | null }> = {}) => ({
  id: over.id ?? 's1',
  title: over.title ?? 't',
  team_id: 'team-1',
  mode: 'collab' as const,
  idea_id: over.ideaId ?? null,
  last_message_at: over.lastMessageAt ?? '2026-05-17T08:00:00.000Z',
  last_message_preview: null,
  has_unread: false,
  created_at: '2026-05-17T07:59:00.000Z',
  updated_at: '2026-05-17T08:00:00.000Z',
})

describe('SessionListColumn', () => {
  beforeEach(() => {
    localStorage.setItem('teamclaw-pinned-sessions', JSON.stringify({ __legacy__: ['s1'] }))
    useUIStore.setState({ sidebarFilter: { kind: 'all' } })
    useSessionListStore.setState({
      rows: [
        mkRow({ id: 's1', title: 'Alpha', ideaId: null }),
        mkRow({ id: 's2', title: 'Beta', ideaId: 'idea-1' }),
        mkRow({ id: 's3', title: 'Gamma', ideaId: 'idea-1' }),
      ],
      pinnedSessionIds: ['s1'],
      highlightedSessionIds: [],
      hasMore: false,
      loading: false,
    })
    useSessionStore.setState({
      sessions: [
        mkSession({ id: 's1', title: 'Alpha', ideaId: null }),
        mkSession({ id: 's2', title: 'Beta', ideaId: 'idea-1' }),
        mkSession({ id: 's3', title: 'Gamma', ideaId: 'idea-1' }),
      ],
      pinnedSessionIds: ['s1'],
      activeSessionId: null,
    } as any)
  })

  it('shows all non-cron sessions in "all" mode', () => {
    render(<SessionListColumn />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
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
