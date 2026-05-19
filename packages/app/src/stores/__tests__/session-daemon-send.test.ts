import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const client = {
    createSession: vi.fn(),
    sendMessageAsync: vi.fn(),
    sendMessageWithPartsAsync: vi.fn(),
    getMessages: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(),
    getSessionChildren: vi.fn(),
    restoreSession: vi.fn(),
  }

  const sessionListState = {
    rows: [
      {
        id: 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f',
        title: 'Collab Session',
        team_id: 'team-1',
        last_message_at: null,
        last_message_preview: null,
        mode: 'collab',
        idea_id: null,
        has_unread: false,
      },
    ],
    loading: false,
    markSessionViewed: vi.fn(),
    load: vi.fn(),
  }

  return {
    client,
    sessionListState,
    invoke: vi.fn(),
    trackEvent: vi.fn(),
    subscribeSessionList: vi.fn(() => () => {}),
    mqttPublish: vi.fn(),
    resolveCurrentMemberActorId: vi.fn(),
    supabaseInsert: vi.fn(),
    sessionParticipantsSelect: vi.fn(),
    actorDirectorySelect: vi.fn(),
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}))

vi.mock('@/lib/opencode/sdk-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/opencode/sdk-client')>('@/lib/opencode/sdk-client')
  return {
    ...actual,
    getOpenCodeClient: () => mocks.client,
  }
})

vi.mock('@/lib/mqtt-bridge', () => ({
  mqttPublish: mocks.mqttPublish,
}))

vi.mock('@/lib/current-actor', () => ({
  resolveCurrentMemberActorId: mocks.resolveCurrentMemberActorId,
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'messages') {
        return {
          insert: mocks.supabaseInsert,
        }
      }
      if (table === 'session_participants') {
        return {
          select: () => ({
            eq: () => Promise.resolve(mocks.sessionParticipantsSelect()),
          }),
        }
      }
      if (table === 'actor_directory') {
        return {
          select: () => ({
            in: () => ({
              in: () => Promise.resolve(mocks.actorDirectorySelect()),
            }),
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  },
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({
      workspacePath: '/workspace/demo',
    }),
    subscribe: vi.fn(() => () => {}),
  },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      session: {
        user: {
          id: 'user-1',
        },
      },
    }),
  },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({
      team: { id: 'team-1', name: 'Team', slug: 'team' },
      currentMember: { id: 'member-1', displayName: 'Me', role: 'owner', joinedAt: null },
    }),
  },
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => mocks.sessionListState,
    subscribe: mocks.subscribeSessionList,
  },
}))

vi.mock('@/stores/telemetry', () => ({
  trackEvent: mocks.trackEvent,
}))

describe('session store daemon send path', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.invoke.mockResolvedValue('')
    mocks.client.createSession.mockResolvedValue({
      id: 'ses_legacy',
      title: 'Legacy Session',
      time: { created: Date.now(), updated: Date.now() },
    })
    mocks.client.sendMessageAsync.mockResolvedValue(undefined)
    mocks.client.sendMessageWithPartsAsync.mockResolvedValue(undefined)
    mocks.client.getMessages.mockResolvedValue([])
    mocks.client.abortSession.mockResolvedValue(true)
    mocks.client.listSessions.mockResolvedValue([])
    mocks.client.getSessionChildren.mockResolvedValue([])
    mocks.client.restoreSession.mockResolvedValue(undefined)
    mocks.resolveCurrentMemberActorId.mockResolvedValue('member-1')
    mocks.supabaseInsert.mockResolvedValue({ error: null })
    mocks.sessionParticipantsSelect.mockReturnValue({
      data: [],
      error: null,
    })
    mocks.actorDirectorySelect.mockReturnValue({
      data: [],
      error: null,
    })
    mocks.mqttPublish.mockResolvedValue(undefined)
  })

  it('publishes TeamClaw UUID session messages through MQTT instead of opencode promptAsync', async () => {
    const { useSessionStore } = await import('../session-store')

    useSessionStore.setState({
      activeSessionId: 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f',
      currentSessionId: 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f',
      sessions: [{
        id: 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f',
        title: 'Collab Session',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    })

    await useSessionStore.getState().sendMessage('hello daemon')

    expect(mocks.client.sendMessageAsync).not.toHaveBeenCalled()
    expect(mocks.mqttPublish).toHaveBeenCalledTimes(1)
  })

  it('auto-mentions the sole agent when no engaged agent is selected', async () => {
    const { useSessionStore } = await import('../session-store')

    mocks.sessionParticipantsSelect.mockReturnValue({
      data: [{ actor_id: 'agent-1' }, { actor_id: 'member-1' }],
      error: null,
    })
    mocks.actorDirectorySelect.mockReturnValue({
      data: [{ id: 'agent-1' }],
      error: null,
    })

    useSessionStore.setState({
      activeSessionId: 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f',
      currentSessionId: 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f',
      sessions: [{
        id: 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f',
        title: 'Collab Session',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    })

    await useSessionStore.getState().sendMessage('hello daemon')

    expect(mocks.supabaseInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { mention_actor_ids: ['agent-1'] },
      }),
    )
  })
})
