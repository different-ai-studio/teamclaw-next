import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ActorDetailDialog } from '../ActorDetailDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}))

vi.mock('@/lib/date-format', () => ({
  formatRelativeTime: () => 'just now',
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DialogTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <h2 className={className}>{children}</h2>
  ),
}))

describe('ActorDetailDialog', () => {
  it('uses the member detail pane surface', () => {
    render(
      <ActorDetailDialog
        actor={{
          id: 'actor-1',
          actor_type: 'member',
          display_name: 'Matt-iOS',
          member_status: 'iOS',
          agent_status: null,
          last_active_at: new Date().toISOString(),
        }}
        onOpenChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Matt-iOS')).toBeInTheDocument()
    expect(screen.getByText('Member details')).toBeInTheDocument()
    expect(screen.getByText('Details')).toBeInTheDocument()
    expect(screen.getByText('Role')).toBeInTheDocument()
    expect(screen.getByText('Last active')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy ID/i })).toBeInTheDocument()
  })
})
