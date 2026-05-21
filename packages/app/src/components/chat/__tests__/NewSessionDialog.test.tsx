import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  closeNewSessionDialog: vi.fn(),
  switchToSession: vi.fn(),
  loadSessions: vi.fn(),
  addHighlightedSession: vi.fn(),
  selectModel: vi.fn(),
  createSessionWithFirstMessage: vi.fn(),
  ensureSessionLiveSubscribed: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        newSessionDialogOpen: true,
        newSessionDialogInitialMessage: '',
        closeNewSessionDialog: mocks.closeNewSessionDialog,
        switchToSession: mocks.switchToSession,
      }),
    {
      getState: () => ({
        closeNewSessionDialog: mocks.closeNewSessionDialog,
        switchToSession: mocks.switchToSession,
      }),
    },
  ),
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        session: {
          user: { id: 'user-1' },
          access_token: 'token',
        },
      }),
    {
      getState: () => ({
        session: {
          user: { id: 'user-1' },
          access_token: 'token',
        },
      }),
    },
  ),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (state: unknown) => unknown) =>
    selector({
      team: { id: 'team-1' },
      currentMember: { id: 'member-1' },
    }),
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({ load: mocks.loadSessions }),
  },
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: {
    getState: () => ({ addHighlightedSession: mocks.addHighlightedSession }),
  },
}))

vi.mock('@/stores/provider', () => ({
  useProviderStore: (selector: (state: unknown) => unknown) =>
    selector({
      models: [],
      currentModelKey: null,
      selectModel: mocks.selectModel,
    }),
}))

vi.mock('@/lib/current-actor', () => ({
  resolveCurrentMemberActorId: vi.fn().mockResolvedValue('member-1'),
}))

vi.mock('@/lib/local-cache', () => ({
  loadActorsForTeam: vi.fn().mockResolvedValue([
    { id: 'agent-1', actorType: 'agent', displayName: 'MCA2' },
  ]),
}))

vi.mock('@/lib/sync/actor-sync', () => ({
  syncActorsForTeam: vi.fn().mockResolvedValue(0),
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

vi.mock('@/lib/actor-color', () => ({
  actorAvatarColor: () => ({ bg: '#64748b', fg: '#fff' }),
}))

vi.mock('@/lib/session-create', () => ({
  createSessionWithFirstMessage: (...args: unknown[]) => mocks.createSessionWithFirstMessage(...args),
}))

vi.mock('@/App', () => ({
  ensureSessionLiveSubscribed: (...args: unknown[]) => mocks.ensureSessionLiveSubscribed(...args),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

import { NewSessionDialog } from '../NewSessionDialog'

describe('NewSessionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createSessionWithFirstMessage.mockResolvedValue({ sessionId: 'sess-1' })
  })

  it('allows creating a daemon-agent session before the daemon has advertised models', async () => {
    render(<NewSessionDialog />)

    fireEvent.click(await screen.findByText('MCA2'))
    fireEvent.change(screen.getByPlaceholderText('想聊点什么？'), {
      target: { value: 'hello daemon' },
    })
    fireEvent.click(screen.getByRole('button', { name: /创建会话/ }))

    await waitFor(() => {
      expect(mocks.createSessionWithFirstMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'team-1',
          creatorActorId: 'member-1',
          agentActorIds: ['agent-1'],
          messageText: 'hello daemon',
          modelId: undefined,
        }),
      )
    })
    expect(mocks.selectModel).not.toHaveBeenCalled()
  })
})
