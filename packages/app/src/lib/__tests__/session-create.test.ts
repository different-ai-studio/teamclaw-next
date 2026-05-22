import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentType } from '@/lib/proto/amux_pb'

const mockRuntimeStart = vi.fn().mockResolvedValue({
  accepted: true,
  runtimeId: 'rt-1',
  sessionId: 'sess-1',
  rejectedReason: '',
})
const mockSetModel = vi.fn().mockResolvedValue({})

const supabaseFrom = vi.fn()

vi.mock('@/lib/teamclaw-rpc', () => ({
  runtimeStart: (...args: unknown[]) => mockRuntimeStart(...args),
  setModel: (...args: unknown[]) => mockSetModel(...args),
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: (...args: unknown[]) => supabaseFrom(...args),
  },
}))

describe('startAgentRuntimesAsync', () => {
  beforeEach(() => {
    mockRuntimeStart.mockClear()
    mockSetModel.mockClear()
    supabaseFrom.mockReset()
  })

  function mockTables(opts: {
    runtimes?: Array<{ agent_id: string; workspace_id: string | null; backend_type: string | null }>
    actors?: Array<{ id: string; agent_types: string[]; default_agent_type: string | null }>
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
      if (table === 'agents') {
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
      actors: [{ id: 'agent-1', agent_types: [], default_agent_type: null }],
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
      actors: [{ id: 'agent-2', agent_types: [], default_agent_type: null }],
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

  it('uses the first supported agent type without runtime history', async () => {
    mockTables({
      runtimes: [],
      actors: [{ id: 'agent-daemon', agent_types: ['opencode', 'claude'], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-daemon'],
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDeviceId: 'agent-daemon',
        workspaceId: '',
        agentType: AgentType.OPENCODE,
      }),
    )
  })

  it('prefers actor.default_agent_type over prior runtime backend_type', async () => {
    // Prior runtime was opencode, but the operator has since set the agent's
    // default_agent_type to codex — the next spawn should respect that.
    mockTables({
      runtimes: [{ agent_id: 'agent-3', workspace_id: 'ws-old', backend_type: 'opencode' }],
      actors: [{ id: 'agent-3', agent_types: ['claude', 'codex'], default_agent_type: 'codex' }],
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

  it('passes the selected model to runtimeStart', async () => {
    mockTables({
      runtimes: [{ agent_id: 'agent-4', workspace_id: 'ws-model', backend_type: 'claude' }],
      actors: [{ id: 'agent-4', agent_types: [], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-4'],
      modelId: 'claude-opus-4-7',
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDeviceId: 'agent-4',
        modelId: 'claude-opus-4-7',
      }),
    )
  })

  it('applies the selected model after runtimeStart accepts the runtime', async () => {
    mockTables({
      runtimes: [{ agent_id: 'agent-6', workspace_id: 'ws-model', backend_type: 'opencode' }],
      actors: [{ id: 'agent-6', agent_types: [], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-6'],
      modelId: 'opencode/deepseek-v4-flash-free',
    })

    expect(mockSetModel).toHaveBeenCalledWith({
      targetDeviceId: 'agent-6',
      runtimeId: 'rt-1',
      modelId: 'opencode/deepseek-v4-flash-free',
    })
  })

  it('uses the selected backend instead of prior runtime backend_type', async () => {
    mockTables({
      runtimes: [{ agent_id: 'agent-5', workspace_id: 'ws-backend', backend_type: 'opencode' }],
      actors: [{ id: 'agent-5', agent_types: [], default_agent_type: null }],
    })

    const { startAgentRuntimesAsync } = await import('../session-create')
    await startAgentRuntimesAsync({
      sessionId: 'sess-1',
      teamId: 'team-1',
      agentActorIds: ['agent-5'],
      agentType: AgentType.CLAUDE_CODE,
      modelId: 'claude-sonnet-4-6',
    })

    expect(mockRuntimeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDeviceId: 'agent-5',
        agentType: AgentType.CLAUDE_CODE,
        modelId: 'claude-sonnet-4-6',
      }),
    )
  })
})
