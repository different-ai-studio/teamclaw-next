import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCustomProviderConfig, getCustomProviderIds } from '../teamclaw-config'

const files = vi.hoisted(() => new Map<string, string>())

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async (path: string) => files.has(path)),
  readTextFile: vi.fn(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`missing file: ${path}`)
    return content
  }),
  writeTextFile: vi.fn(),
}))

describe('teamclaw-config custom providers', () => {
  beforeEach(() => {
    files.clear()
  })

  it('loads custom provider models from workspace opencode.json when teamclaw.json is absent', async () => {
    files.set('/workspace/opencode.json', JSON.stringify({
      provider: {
        scnet: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Scnet',
          options: { baseURL: 'https://scnet.example/v1' },
          models: {
            'minimax-m2.5': { name: 'MiniMax-M2.5' },
          },
        },
      },
    }))

    await expect(getCustomProviderIds('/workspace')).resolves.toEqual(['scnet'])
    await expect(getCustomProviderConfig('/workspace', 'scnet')).resolves.toEqual({
      name: 'Scnet',
      baseURL: 'https://scnet.example/v1',
      models: [
        {
          modelId: 'minimax-m2.5',
          modelName: 'MiniMax-M2.5',
          limit: undefined,
          modalities: undefined,
        },
      ],
    })
  })
})
