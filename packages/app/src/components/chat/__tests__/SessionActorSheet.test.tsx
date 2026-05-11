import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { create } from '@bufbuild/protobuf'
import {
  RuntimeInfoSchema,
  AgentStatus,
  AgentType,
  RuntimeLifecycle,
} from '@/lib/proto/amux_pb'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import { SessionActorSheet } from '../SessionActorSheet'

const supabaseFrom = vi.fn()
vi.mock('@/lib/supabase-client', () => ({
  supabase: { from: (...args: unknown[]) => supabaseFrom(...args) },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fallback: string) => fallback }),
}))

beforeEach(() => {
  supabaseFrom.mockReset()
  useRuntimeStateStore.getState().clear()
})

function mockJoinedRows(participantActorIds: string[], actorRows: unknown[]) {
  supabaseFrom.mockImplementation((table: string) => {
    if (table === 'session_participants') {
      return {
        select: () => ({
          eq: () => Promise.resolve({
            data: participantActorIds.map(id => ({ actor_id: id })),
            error: null,
          }),
        }),
      }
    }
    if (table === 'actor_directory') {
      return {
        select: () => ({
          in: () => Promise.resolve({ data: actorRows, error: null }),
        }),
      }
    }
    if (table === 'agent_runtimes') {
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }
    }
    return { select: () => Promise.resolve({ data: [], error: null }) }
  })
}

function mockSheetData(participantActorIds: string[], actorRows: unknown[], runtimeRows: unknown[]) {
  supabaseFrom.mockImplementation((table: string) => {
    if (table === 'session_participants') {
      return {
        select: () => ({
          eq: () => Promise.resolve({
            data: participantActorIds.map(id => ({ actor_id: id })),
            error: null,
          }),
        }),
      }
    }
    if (table === 'actor_directory') {
      return {
        select: () => ({
          in: () => Promise.resolve({ data: actorRows, error: null }),
        }),
      }
    }
    if (table === 'agent_runtimes') {
      return {
        select: () => ({ eq: () => Promise.resolve({ data: runtimeRows, error: null }) }),
      }
    }
    return { select: () => Promise.resolve({ data: [], error: null }) }
  })
}

describe('SessionActorSheet', () => {
  it('lists members and agents from session_participants × actor_directory', async () => {
    mockJoinedRows(
      ['m-1', 'a-1'],
      [
        { id: 'm-1', actor_type: 'member', display_name: 'Alice', member_status: 'active', agent_status: null, agent_kind: null, last_active_at: null },
        { id: 'a-1', actor_type: 'agent', display_name: 'Reviewer', member_status: null, agent_status: 'idle', agent_kind: 'claude', last_active_at: null },
      ],
    )
    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText(/members/i)).toBeInTheDocument()
    expect(screen.getByText(/agents/i)).toBeInTheDocument()
  })

  it('shows empty state when session has no participants', async () => {
    mockJoinedRows([], [])
    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText(/no participants in this session/i)).toBeInTheDocument())
  })

  it('does not fetch when sessionId is null', async () => {
    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId={null} />)
    // Brief wait to ensure no fetch fires
    await new Promise(r => setTimeout(r, 50))
    expect(supabaseFrom).not.toHaveBeenCalled()
  })

  it('shows breathing dot and model name for an active agent', async () => {
    // Prime the runtime-state-store with a live ACTIVE/ACTIVE runtime
    const info = create(RuntimeInfoSchema, {
      runtimeId: '05532480',
      agentType: AgentType.CLAUDE_CODE,
      state: RuntimeLifecycle.ACTIVE,
      status: AgentStatus.ACTIVE,
      currentModel: 'claude-opus-4-7',
    })
    useRuntimeStateStore.getState().upsert('05532480', 'dev-a', info)

    mockSheetData(
      ['a-1'],
      [
        {
          id: 'a-1',
          actor_type: 'agent',
          display_name: 'Reviewer',
          member_status: null,
          agent_status: 'idle',
          agent_kind: 'claude',
          last_active_at: null,
        },
      ],
      [{ agent_id: 'a-1', runtime_id: '05532480', status: 'running', current_model: 'claude-opus-4-7' }],
    )

    render(<SessionActorSheet open={true} onOpenChange={() => {}} sessionId="sess-1" />)
    await waitFor(() => expect(screen.getByText('Reviewer')).toBeInTheDocument())

    // Model name appears in subline
    expect(screen.getByText('claude-opus-4-7')).toBeInTheDocument()

    // Status dot has animate-pulse (breathing) class
    const dot = document.querySelector('.animate-pulse.rounded-full')
    expect(dot).toBeTruthy()
  })
})
