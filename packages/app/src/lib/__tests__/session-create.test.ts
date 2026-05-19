import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentType } from '@/lib/proto/amux_pb'

const mockRuntimeStart = vi.fn().mockResolvedValue({
  accepted: true,
  runtimeId: 'rt-1',
  sessionId: 'sess-1',
  rejectedReason: '',
})

const supabaseFrom = vi.fn()

vi.mock('@/lib/teamclaw-rpc', () => ({
  runtimeStart: (...args: unknown[]) => mockRuntimeStart(...args),
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: (...args: unknown[]) => supabaseFrom(...args),
  },
}))

describe('startAgentRuntimesAsync', () => {
  beforeEach(() => {
    mockRuntimeStart.mockClear()
    supabaseFrom.mockReset()
  })

  it('sends opencode runtimeStart requests for prior opencode agent runtimes', async () => {
    supabaseFrom.mockImplementation((table: string) => {
      if (table === 'agent_runtimes') {
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                order: () => Promise.resolve({
                  data: [
                    {
                      agent_id: 'agent-1',
                      workspace_id: 'ws-opencode',
                      backend_type: 'opencode',
                      updated_at: '2026-05-18T00:00:00.000Z',
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-1'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDeviceId: 'agent-1',
        workspaceId: 'ws-opencode',
        agentType: AgentType.OPENCODE,
      }),
    )
  })

  it('falls back to claude runtimeStart requests without runtime history', async () => {
    supabaseFrom.mockImplementation((table: string) => {
      if (table === 'agent_runtimes') {
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                order: () => Promise.resolve({
                  data: [],
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-2'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDeviceId: 'agent-2',
        workspaceId: '',
        agentType: AgentType.CLAUDE_CODE,
      }),
    )
  })
})
