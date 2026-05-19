import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const client = {
    createSession: vi.fn(),
    sendMessageAsync: vi.fn(),
    sendMessageWithPartsAsync: vi.fn(),
    getMessages: vi.fn(),
    getSession: vi.fn(),
    getSessionChildren: vi.fn(),
    getTodos: vi.fn(),
    getSessionDiff: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(),
    restoreSession: vi.fn(),
  }

  return {
    client,
    invoke: vi.fn(),
    markSessionViewed: vi.fn(),
    loadSessionList: vi.fn(),
    trackEvent: vi.fn(),
    subscribeSessionList: vi.fn(() => () => {}),
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}))

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: () => mocks.client,
  isOpenCodeSessionId: (id: string | null | undefined) =>
    typeof id === 'string' && id.startsWith('ses'),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({
      workspacePath: '/workspace/demo',
    }),
    subscribe: vi.fn(() => () => {}),
  },
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: {
    getState: () => ({
      markSessionViewed: mocks.markSessionViewed,
      load: mocks.loadSessionList,
      rows: [],
      loading: false,
    }),
    subscribe: mocks.subscribeSessionList,
  },
}))

vi.mock('@/stores/telemetry', () => ({
  trackEvent: mocks.trackEvent,
}))

describe('session store opencode metadata guards', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.invoke.mockResolvedValue('')
    mocks.client.getMessages.mockResolvedValue([])
    mocks.client.getSession.mockResolvedValue(null)
    mocks.client.getSessionChildren.mockResolvedValue([])
    mocks.client.getTodos.mockResolvedValue([])
    mocks.client.getSessionDiff.mockResolvedValue([])
    mocks.client.listSessions.mockResolvedValue([])
    mocks.client.restoreSession.mockResolvedValue(undefined)
  })

  it('does not call opencode session metadata endpoints for TeamClaw UUID sessions', async () => {
    const { useSessionStore } = await import('../session-store')

    useSessionStore.setState({
      sessions: [{
        id: 'a1ca8f06-94ee-4fb5-bdfb-194a5606062f',
        title: 'UUID session',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    })

    await useSessionStore.getState().setActiveSession('a1ca8f06-94ee-4fb5-bdfb-194a5606062f')

    expect(useSessionStore.getState().currentSessionId).toBe(
      'a1ca8f06-94ee-4fb5-bdfb-194a5606062f',
    )
    expect(mocks.client.getMessages).not.toHaveBeenCalled()
    expect(mocks.client.getSession).not.toHaveBeenCalled()
    expect(mocks.client.getSessionChildren).not.toHaveBeenCalled()
  })
})
