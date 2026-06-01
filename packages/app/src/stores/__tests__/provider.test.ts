import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCustomProviderIds: vi.fn(),
  getCustomProviderConfig: vi.fn(),
  getDaemonProviders: vi.fn(),
  workspacePath: '/workspace/demo',
  runtimeById: {} as Record<string, any>,
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/build-config', () => ({
  appShortName: 'teamclaw',
}))

vi.mock('@/lib/storage', () => ({
  workspaceScopedKey: (base: string, workspacePath?: string | null) => `${base}:${workspacePath ?? ''}`,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({
      workspacePath: mocks.workspacePath,
    }),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/daemon-local-client', () => ({
  encodeWorkspaceId: (path: string) => path,
  getDaemonProviders: mocks.getDaemonProviders,
  putDaemonProviderAuth: vi.fn(),
  deleteDaemonProviderAuth: vi.fn(),
}))

vi.mock('@/lib/amuxd-models', () => ({
  AMUXD_AGENT_TYPES: ['openai'],
  availableModelsFor: (providerId: string) =>
    providerId === 'openai'
      ? [{ id: 'gpt-4o', displayName: 'GPT-4o', provider: 'openai' }]
      : [],
  allAmuxdModels: () => [
    { id: 'gpt-4o', displayName: 'GPT-4o', provider: 'openai' },
  ],
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: {
    getState: () => ({
      byRuntimeId: mocks.runtimeById,
    }),
  },
}))

vi.mock('@/lib/opencode/config', () => ({
  addCustomProviderToConfig: vi.fn(),
  updateCustomProviderConfig: vi.fn(),
  getCustomProviderIds: mocks.getCustomProviderIds,
  getCustomProviderConfig: mocks.getCustomProviderConfig,
  removeCustomProviderFromConfig: vi.fn(),
  providerApiKeyName: vi.fn((id: string) => `PROVIDER_${id.toUpperCase()}_API_KEY`),
}))

describe('provider store initAll', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    mocks.workspacePath = '/workspace/demo'
    mocks.runtimeById = {}
    mocks.getCustomProviderIds.mockReset()
    mocks.getCustomProviderConfig.mockReset()
    mocks.getDaemonProviders.mockReset()
    mocks.getDaemonProviders.mockResolvedValue(null)
    mocks.getCustomProviderIds.mockResolvedValue([])
  })

  it('ignores daemon runtime models when initializing model settings', async () => {
    mocks.runtimeById = {
      'runtime-1': {
        info: {
          agentType: 1,
          availableModels: [
            { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
          ],
          currentModel: 'claude-sonnet-4-6',
        },
      },
    }

    const { useProviderStore, getSelectedModelOption } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.models).toEqual([])
    expect(state.configuredProviders).toEqual([])
    expect(state.providers).toEqual([])
    expect(state.currentModelKey).toBeNull()
    expect(getSelectedModelOption(state)).toBeNull()
  })

  it('keeps an explicit selected model when daemon reports a different catalog', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'opencode',
        display_name: 'OpenCode',
        authenticated: true,
        models: ['opencode/qwen3.6-plus-free', 'opencode/big-pickle'],
      },
    ])

    const { useProviderStore } = await import('../provider')
    useProviderStore.setState({
      currentModelKey: 'opencode/opencode/big-pickle',
    })

    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().currentModelKey).toBe('opencode/opencode/big-pickle')
  })

  it('does not recover a saved model when daemon providers are unavailable', async () => {
    localStorage.setItem('teamclaw-selected-model:/workspace/demo', 'openai/gpt-4o')

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.models).toEqual([])
    expect(state.configuredProviders).toEqual([])
    expect(state.currentModelKey).toBeNull()
  })

  it('loads workspace custom models from daemon providers and restores the saved selection', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'custom-openai',
        display_name: 'Custom OpenAI',
        authenticated: true,
        models: ['my-model'],
      },
    ])
    localStorage.setItem('teamclaw-selected-model:/workspace/demo', 'custom-openai/my-model')

    const { useProviderStore, getSelectedModelOption } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'custom-openai',
          id: 'my-model',
          name: 'my-model',
        }),
      ]),
    )
    expect(state.currentModelKey).toBe('custom-openai/my-model')
    expect(getSelectedModelOption(state)).toMatchObject({
      provider: 'custom-openai',
      id: 'my-model',
      name: 'my-model',
    })
  })

  it('falls back to a custom provider when a saved model is not in the daemon catalog', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'scnet',
        display_name: 'Scnet',
        authenticated: true,
        models: ['minimax-m2.5'],
      },
    ])
    localStorage.setItem('teamclaw-selected-model:/workspace/demo', 'opencode/opencode/qwen3.6-plus-free')

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().currentModelKey).toBe('scnet/minimax-m2.5')
  })

  it('does not recover to daemon runtime info from a custom-provider selection', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'scnet',
        display_name: 'Scnet',
        authenticated: true,
        models: ['minimax-m2.5'],
      },
    ])
    mocks.runtimeById = {
      'runtime-1': {
        info: {
          agentType: 2,
          availableModels: [
            { id: 'opencode/qwen3.6-plus-free', displayName: 'OpenCode Zen/Qwen3.6 Plus Free' },
            { id: 'opencode/big-pickle', displayName: 'Big Pickle' },
          ],
          currentModel: 'opencode/qwen3.6-plus-free',
        },
      },
    }

    const { useProviderStore } = await import('../provider')
    useProviderStore.setState({ currentModelKey: 'scnet/minimax-m2.5' })

    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().currentModelKey).toBe('scnet/minimax-m2.5')
  })

  it('filters model options to the selected backend during a session', async () => {
    const { getModelOptionsForSelectedBackend } = await import('../provider')

    const models = [
      { provider: 'claude-code', id: 'claude-a', name: 'Claude A' },
      { provider: 'claude-code', id: 'claude-b', name: 'Claude B' },
      { provider: 'opencode', id: 'open-a', name: 'Open A' },
    ]

    expect(getModelOptionsForSelectedBackend({
      models,
      currentModelKey: 'claude-code/claude-a',
    } as any)).toEqual([
      { provider: 'claude-code', id: 'claude-a', name: 'Claude A' },
      { provider: 'claude-code', id: 'claude-b', name: 'Claude B' },
    ])
  })

  it('does not carry the selected model memory across workspaces', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'openai',
        display_name: 'OpenAI',
        authenticated: true,
        models: ['gpt-4o', 'gpt-4.1'],
      },
    ])
    localStorage.setItem('teamclaw-selected-model:/workspace/demo', 'openai/gpt-4.1')

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()
    expect(useProviderStore.getState().currentModelKey).toBe('openai/gpt-4.1')

    mocks.workspacePath = '/workspace/next'
    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().currentModelKey).toBe('openai/gpt-4o')
    expect(localStorage.getItem('teamclaw-selected-model:/workspace/next')).toBe('openai/gpt-4o')
  })
})
