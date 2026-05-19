import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCustomProviderIds: vi.fn(),
  getCustomProviderConfig: vi.fn(),
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
    mocks.getCustomProviderIds.mockReset()
    mocks.getCustomProviderConfig.mockReset()
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
})
