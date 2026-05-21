import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSetModel = vi.fn().mockResolvedValue({})
const supabaseFrom = vi.fn()

vi.mock('@/lib/teamclaw-rpc', () => ({
  setModel: (...args: unknown[]) => mockSetModel(...args),
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: (...args: unknown[]) => supabaseFrom(...args),
  },
}))

describe('applySessionRuntimeModel', () => {
  beforeEach(() => {
    mockSetModel.mockClear()
    supabaseFrom.mockReset()
  })

  it('sends setModel to each runtime in the active session', async () => {
    supabaseFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          in: () => Promise.resolve({
            data: [
              { agent_id: 'agent-1', runtime_id: 'rt-1' },
              { agent_id: 'agent-2', runtime_id: 'rt-2' },
            ],
            error: null,
          }),
        }),
      }),
    })

    const { applySessionRuntimeModel } = await import('../session-runtime-model')

    await applySessionRuntimeModel({
      sessionId: 'sess-1',
      agentActorIds: ['agent-1', 'agent-2'],
      modelId: 'claude-opus-4-7',
    })

    expect(mockSetModel).toHaveBeenCalledTimes(2)
    expect(mockSetModel).toHaveBeenCalledWith({
      targetDeviceId: 'agent-1',
      runtimeId: 'rt-1',
      modelId: 'claude-opus-4-7',
    })
    expect(mockSetModel).toHaveBeenCalledWith({
      targetDeviceId: 'agent-2',
      runtimeId: 'rt-2',
      modelId: 'claude-opus-4-7',
    })
  })

  it('targets all session runtimes when no agent ids are provided', async () => {
    const inSpy = vi.fn()
    supabaseFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          in: inSpy,
          then: undefined,
        }),
      }),
    })
    supabaseFrom.mockReturnValueOnce({
      select: () => ({
        eq: () => Promise.resolve({
          data: [
            { agent_id: 'agent-1', runtime_id: 'rt-1' },
          ],
          error: null,
        }),
      }),
    })

    const { applySessionRuntimeModel } = await import('../session-runtime-model')

    await applySessionRuntimeModel({
      sessionId: 'sess-1',
      agentActorIds: [],
      modelId: 'claude-sonnet-4-6',
    })

    expect(inSpy).not.toHaveBeenCalled()
    expect(mockSetModel).toHaveBeenCalledWith({
      targetDeviceId: 'agent-1',
      runtimeId: 'rt-1',
      modelId: 'claude-sonnet-4-6',
    })
  })
})
