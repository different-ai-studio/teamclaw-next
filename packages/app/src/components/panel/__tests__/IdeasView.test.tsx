import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IdeasView } from '../IdeasView'

const supabaseFrom = vi.fn()
const updateIdeaSortOrder = vi.fn()
vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: (...args: unknown[]) => supabaseFrom(...args),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u-1' } } }) },
  },
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: (sel: any) => sel({ rows: [{ id: 's-1', team_id: 'team-1' }] }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fallback: string) => fallback }),
}))

vi.mock('@/lib/date-format', () => ({
  formatRelativeTime: () => 'just now',
}))

vi.mock('@/components/sidebar/IdeaDetailDialog', () => ({
  IdeaDetailDialog: ({ idea }: { idea: { title: string } | null }) => (
    idea ? <div data-testid="idea-detail-panel">{idea.title}</div> : null
  ),
}))

beforeEach(() => {
  supabaseFrom.mockReset()
  updateIdeaSortOrder.mockReset()
  vi.useRealTimers()
})

function mockIdeasResponse(ideas: any[], actors: any[]) {
  supabaseFrom.mockImplementation((table: string) => {
    if (table === 'ideas') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                order: () => Promise.resolve({ data: ideas, error: null }),
              }),
            }),
          }),
        }),
        update: (payload: any) => {
          updateIdeaSortOrder(payload)
          return {
            eq: () => Promise.resolve({ error: null }),
          }
        },
      }
    }
    if (table === 'actors') {
      return {
        select: () => ({
          in: () => Promise.resolve({ data: actors, error: null }),
          eq: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
        }),
      }
    }
    return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }
  })
}

describe('IdeasView', () => {
  it('renders ideas with title and creator name', async () => {
    mockIdeasResponse(
      [
        { id: 'i-1', title: 'Launch beta', status: 'in_progress', created_by_actor_id: 'a-1', sort_order: 1000, updated_at: '2026-05-10T00:00:00Z' },
      ],
      [{ id: 'a-1', display_name: 'Alice' }],
    )
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('Ideas')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('Launch beta')).toBeInTheDocument())
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
    expect(screen.getByLabelText(/in progress/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Search')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument()
    expect(screen.getByLabelText('Drag idea Launch beta')).toHaveClass('hover:bg-selected')
  })

  it('renders empty state when no ideas', async () => {
    mockIdeasResponse([], [])
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText(/no ideas yet/i)).toBeInTheDocument())
  })

  it('opens idea detail panel when an idea row is clicked', async () => {
    mockIdeasResponse(
      [
        { id: 'i-1', title: 'Launch beta', status: 'open', created_by_actor_id: 'a-1', sort_order: 1000, updated_at: '2026-05-10T00:00:00Z' },
      ],
      [{ id: 'a-1', display_name: 'Alice' }],
    )
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('Launch beta')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Drag idea Launch beta'))

    expect(screen.getByTestId('idea-detail-panel')).toHaveTextContent('Launch beta')
  })

  it('long-press drag reorders ideas and persists sort order', async () => {
    mockIdeasResponse(
      [
        { id: 'i-1', title: 'First idea', status: 'open', created_by_actor_id: 'a-1', sort_order: 1000, updated_at: '2026-05-10T00:00:00Z' },
        { id: 'i-2', title: 'Second idea', status: 'open', created_by_actor_id: 'a-1', sort_order: 2000, updated_at: '2026-05-11T00:00:00Z' },
        { id: 'i-3', title: 'Third idea', status: 'open', created_by_actor_id: 'a-1', sort_order: 3000, updated_at: '2026-05-12T00:00:00Z' },
      ],
      [{ id: 'a-1', display_name: 'Alice' }],
    )

    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('First idea')).toBeInTheDocument())

    fireEvent.pointerDown(screen.getByLabelText('Drag idea First idea'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    fireEvent.pointerEnter(screen.getByLabelText('Drag idea Third idea'))
    fireEvent.pointerUp(screen.getByLabelText('Drag idea Third idea'))

    await waitFor(() => {
      expect(updateIdeaSortOrder).toHaveBeenCalledWith({ sort_order: 3000 })
    })
    expect(updateIdeaSortOrder).toHaveBeenCalledWith({ sort_order: 1000 })
    expect(updateIdeaSortOrder).toHaveBeenCalledWith({ sort_order: 2000 })
  })
})
