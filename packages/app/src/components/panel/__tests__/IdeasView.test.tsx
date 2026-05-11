import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { IdeasView } from '../IdeasView'

const supabaseFrom = vi.fn()
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

beforeEach(() => {
  supabaseFrom.mockReset()
})

function mockIdeasResponse(ideas: any[], actors: any[]) {
  supabaseFrom.mockImplementation((table: string) => {
    if (table === 'ideas') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: ideas, error: null }),
            }),
          }),
        }),
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
        { id: 'i-1', title: 'Launch beta', status: 'in_progress', created_by_actor_id: 'a-1', updated_at: '2026-05-10T00:00:00Z' },
      ],
      [{ id: 'a-1', display_name: 'Alice' }],
    )
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText('Launch beta')).toBeInTheDocument())
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
    expect(screen.getByText(/in progress/i)).toBeInTheDocument()
  })

  it('renders empty state when no ideas', async () => {
    mockIdeasResponse([], [])
    render(<IdeasView />)
    await waitFor(() => expect(screen.getByText(/no ideas yet/i)).toBeInTheDocument())
  })
})
