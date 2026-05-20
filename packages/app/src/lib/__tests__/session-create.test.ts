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

  function mockTables(opts: {
    runtimes?: Array<{ agent_id: string; workspace_id: string | null; backend_type: string | null }>
    actors?: Array<{ id: string; agent_kind: string | null; default_agent_type: string | null }>
  }) {
    supabaseFrom.mockImplementation((table: string) => {
      if (table === 'agent_runtimes') {
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                order: () => Promise.resolve({
                  data: (opts.runtimes ?? []).map((r) => ({
                    ...r,
                    updated_at: '2026-05-18T00:00:00.000Z',
                  })),
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'actors') {
        return {
          select: () => ({
            in: () => Promise.resolve({
              data: opts.actors ?? [],
              error: null,
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    })
  }

  it('sends opencode runtimeStart requests for prior opencode agent runtimes', async () => {
    mockTables({
      runtimes: [{ agent_id: 'agent-1', workspace_id: 'ws-opencode', backend_type: 'opencode' }],
      actors: [{ id: 'agent-1', agent_kind: 'daemon', default_agent_type: null }],
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
    mockTables({
      runtimes: [],
      actors: [{ id: 'agent-2', agent_kind: null, default_agent_type: null }],
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

  it('prefers actor.default_agent_type over prior runtime backend_type', async () => {
    // Prior runtime was opencode, but the operator has since set the agent's
    // default_agent_type to codex — the next spawn should respect that.
    mockTables({
      runtimes: [{ agent_id: 'agent-3', workspace_id: 'ws-old', backend_type: 'opencode' }],
      actors: [{ id: 'agent-3', agent_kind: 'daemon', default_agent_type: 'codex' }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-3'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDeviceId: 'agent-3',
        agentType: AgentType.CODEX,
      }),
    )
  })
})
