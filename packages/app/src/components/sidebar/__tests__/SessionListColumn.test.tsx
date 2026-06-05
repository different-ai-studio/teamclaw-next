import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionListColumn } from '../SessionListColumn'
import { useUIStore } from '@/stores/ui'
import { useSessionListStore } from '@/stores/session-list-store'
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

vi.mock('@/hooks/use-session-workspace-labels', () => ({
  useSessionWorkspaceLabels: () => new Map([['s1', 'copilot-ws-v3']]),
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
    expect(screen.getByLabelText('未读')).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: /显示定时会话|显示全部会话/ })).toBeInTheDocument()
    useUIStore.setState({ sidebarFilter: { kind: 'pinned' } })
    rerender(<SessionListColumn />)
    expect(screen.queryByRole('button', { name: /显示定时会话|显示全部会话/ })).not.toBeInTheDocument()
  })

  it('shows workspace subline under session title in non-workspace filters', () => {
    render(<SessionListColumn />)
    expect(screen.getByTestId('v2-session-row-workspace')).toHaveTextContent('copilot-ws-v3')
  })

  it('hides workspace subline when filtering by workspace', () => {
    useUIStore.setState({
      sidebarFilter: { kind: 'workspace', workspaceId: 'ws1', path: '/p', name: 'copilot-ws-v3' },
    })
    render(<SessionListColumn />)
    expect(screen.queryByTestId('v2-session-row-workspace')).not.toBeInTheDocument()
  })
})
