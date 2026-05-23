import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SidebarSecondColumn } from '../SidebarSecondColumn'
import { useUIStore } from '@/stores/ui'
import { useShortcutsStore } from '@/stores/shortcuts'

vi.mock('../SessionListColumn', () => ({
  SessionListColumn: () => <div data-testid="session-list-column" />,
}))

vi.mock('@/components/panel', () => ({
  IdeasView: () => <div data-testid="ideas-list-column" />,
  ActorsView: () => <div data-testid="actors-list-column" />,
}))

vi.mock('@/stores/tabs', () => ({
  selectActiveTab: () => null,
  useTabsStore: Object.assign(
    vi.fn((selector?: any) => {
      const state = {
        tabs: [],
        openTab: vi.fn(),
      }
      return selector ? selector(state) : state
    }),
    {
      getState: () => ({ openTab: vi.fn(), tabs: [] }),
    },
  ),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((selector?: any) => {
    const state = { workspacePath: '/workspace' }
    return selector ? selector(state) : state
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: Object.assign(
    vi.fn((selector?: any) => {
      const state = { team: null }
      return selector ? selector(state) : state
    }),
    {
      getState: () => ({ team: null }),
    },
  ),
}))

describe('SidebarSecondColumn', () => {
  beforeEach(() => {
    useShortcutsStore.setState({
      personalNodes: [
        {
          id: 'shortcut-1',
          scope: 'personal',
          ownerMemberId: null,
          teamId: null,
          parentId: null,
          label: 'Docs',
          icon: null,
          order: 0,
          type: 'link',
          target: 'https://docs.example.com',
          createdAt: '',
          updatedAt: '',
        },
      ],
      teamNodes: [],
      loading: false,
      loadedAt: null,
      teamRoles: null,
      shortcutVisibility: null,
    })
  })

  it('renders SessionListColumn for normal session filters', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'all' } })
    render(<SidebarSecondColumn />)
    expect(screen.getByTestId('session-list-column')).toBeInTheDocument()
  })

  it('renders shortcuts when the shortcuts filter is active', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'shortcuts' } })
    render(<SidebarSecondColumn />)
    expect(screen.getByText('Shortcuts')).toBeInTheDocument()
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.queryByTestId('session-list-column')).not.toBeInTheDocument()
  })

  it('renders the full ideas list when the ideas filter is active', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'ideas' } })
    render(<SidebarSecondColumn />)
    expect(screen.getByTestId('ideas-list-column')).toBeInTheDocument()
    expect(screen.queryByTestId('session-list-column')).not.toBeInTheDocument()
  })

  it('renders the full actor list when the actors filter is active', () => {
    useUIStore.setState({ sidebarFilter: { kind: 'actors' } })
    render(<SidebarSecondColumn />)
    expect(screen.getByTestId('actors-list-column')).toBeInTheDocument()
    expect(screen.queryByTestId('session-list-column')).not.toBeInTheDocument()
  })
})
