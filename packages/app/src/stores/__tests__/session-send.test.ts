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

describe('session store sendMessage', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.invoke.mockResolvedValue('')
    mocks.client.createSession.mockResolvedValue({
      id: 'ses_session-1',
      title: 'New Chat',
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    })
    mocks.client.sendMessageAsync.mockResolvedValue(undefined)
    mocks.client.sendMessageWithPartsAsync.mockResolvedValue(undefined)
    mocks.client.getMessages.mockResolvedValue([])
    mocks.client.abortSession.mockResolvedValue(true)
    mocks.client.listSessions.mockResolvedValue([])
    mocks.client.getSessionChildren.mockResolvedValue([])
    mocks.client.restoreSession.mockResolvedValue(undefined)
  })

  it('creates a session and forwards the prompt to the sdk client', async () => {
    const { useSessionStore } = await import('../session-store')

    await useSessionStore.getState().sendMessage('hello world')

    expect(mocks.client.createSession).toHaveBeenCalledTimes(1)
    expect(mocks.client.sendMessageAsync).toHaveBeenCalledWith(
      'ses_session-1',
      'hello world',
      undefined,
      undefined,
      expect.any(String),
    )
  })
})
