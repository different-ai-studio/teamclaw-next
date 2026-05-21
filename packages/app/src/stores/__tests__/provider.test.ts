import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCustomProviderIds: vi.fn(),
  getCustomProviderConfig: vi.fn(),
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
      workspacePath: '/workspace/demo',
    }),
  },
}))

vi.mock('@/lib/opencode/sdk-client', () => ({
  getOpenCodeClient: vi.fn(() => {
    throw new Error('not connected')
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
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

vi.mock('@/lib/teamclaw-config', () => ({
  addCustomProviderToConfig: vi.fn(),
  updateCustomProviderConfig: vi.fn(),
  getCustomProviderIds: mocks.getCustomProviderIds,
  getCustomProviderConfig: mocks.getCustomProviderConfig,
  removeCustomProviderFromConfig: vi.fn(),
  providerApiKeyName: vi.fn(),
}))

describe('provider store initAll', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    mocks.runtimeById = {}
    mocks.getCustomProviderIds.mockReset()
    mocks.getCustomProviderConfig.mockReset()
  })

  it('loads available models and current selection from daemon runtime info', async () => {
    mocks.getCustomProviderIds.mockResolvedValue([])
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
    expect(state.models).toEqual([
      {
        provider: 'claude-code',
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
      },
    ])
    expect(state.currentModelKey).toBe('claude-code/claude-sonnet-4-6')
    expect(getSelectedModelOption(state)).toMatchObject({
      provider: 'claude-code',
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
    })
  })

  it('keeps an explicit selected model when daemon runtime info reports a different current model', async () => {
    mocks.getCustomProviderIds.mockResolvedValue([])
    mocks.runtimeById = {
      'runtime-1': {
        info: {
          agentType: 1,
          availableModels: [
            { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
            { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7' },
          ],
          currentModel: 'claude-sonnet-4-6',
        },
      },
    }

    const { useProviderStore } = await import('../provider')
    await useProviderStore.getState().selectModel('claude-code', 'claude-opus-4-7', 'Claude Opus 4.7')

    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().currentModelKey).toBe('claude-code/claude-opus-4-7')
  })

  it('does not load the old static model list when daemon has no runtime info', async () => {
    mocks.getCustomProviderIds.mockResolvedValue([])
    localStorage.setItem('teamclaw-selected-model:/workspace/demo', 'openai/gpt-4o')

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.models).toEqual([])
    expect(state.configuredProviders).toEqual([])
    expect(state.currentModelKey).toBeNull()
  })

  it('keeps workspace custom models available and restores the saved selection', async () => {
    mocks.getCustomProviderIds.mockResolvedValue(['custom-openai'])
    mocks.getCustomProviderConfig.mockResolvedValue({
      name: 'Custom OpenAI',
      baseURL: 'https://example.com/v1',
      models: [
        { modelId: 'my-model', modelName: 'My Model' },
      ],
    })

    localStorage.setItem('teamclaw-selected-model:/workspace/demo', 'custom-openai/my-model')

    const { useProviderStore, getSelectedModelOption } = await import('../provider')

    await useProviderStore.getState().initAll()

    const state = useProviderStore.getState()
    expect(state.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'custom-openai',
          id: 'my-model',
          name: 'My Model',
        }),
      ]),
    )
    expect(state.currentModelKey).toBe('custom-openai/my-model')
    expect(getSelectedModelOption(state)).toMatchObject({
      provider: 'custom-openai',
      id: 'my-model',
      name: 'My Model',
    })
  })

  it('does not replace a saved runtime backend model with a custom provider while daemon models are still loading', async () => {
    mocks.getCustomProviderIds.mockResolvedValue(['scnet'])
    mocks.getCustomProviderConfig.mockResolvedValue({
      name: 'Scnet',
      baseURL: 'https://example.com/v1',
      models: [
        { modelId: 'minimax-m2.5', modelName: 'MiniMax-M2.5' },
      ],
    })
    localStorage.setItem('teamclaw-selected-model:/workspace/demo', 'opencode/opencode/qwen3.6-plus-free')

    const { useProviderStore } = await import('../provider')

    await useProviderStore.getState().initAll()

    expect(useProviderStore.getState().currentModelKey).toBe('opencode/opencode/qwen3.6-plus-free')
  })

  it('recovers from a custom-provider fallback once daemon runtime info is available', async () => {
    mocks.getCustomProviderIds.mockResolvedValue(['scnet'])
    mocks.getCustomProviderConfig.mockResolvedValue({
      name: 'Scnet',
      baseURL: 'https://example.com/v1',
      models: [
        { modelId: 'minimax-m2.5', modelName: 'MiniMax-M2.5' },
      ],
    })
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

    expect(useProviderStore.getState().currentModelKey).toBe('opencode/opencode/qwen3.6-plus-free')
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
})
