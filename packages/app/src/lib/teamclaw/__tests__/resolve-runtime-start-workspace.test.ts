import { describe, it, expect } from 'vitest'
import {
  resolveAgentRuntimeWorkspaceId,
  runtimeStartWorkspaceArgs,
} from '../resolve-runtime-start-workspace'

describe('resolveAgentRuntimeWorkspaceId', () => {
  it('prefers this-session runtime workspace over defaults', () => {
    expect(
      resolveAgentRuntimeWorkspaceId({
        sessionWorkspaceId: 'ws-session',
        defaultWorkspaceId: 'ws-default',
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-session')
  })

  it('falls back to default_workspace_id then agent-bound workspace', () => {
    expect(
      resolveAgentRuntimeWorkspaceId({
        defaultWorkspaceId: 'ws-default',
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-default')

    expect(
      resolveAgentRuntimeWorkspaceId({
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-owned')
  })

  it('returns empty when no cloud workspace is known', () => {
    expect(resolveAgentRuntimeWorkspaceId({})).toBe('')
  })
})

describe('runtimeStartWorkspaceArgs', () => {
  it('never sends caller worktree', () => {
    expect(runtimeStartWorkspaceArgs('uuid-ws')).toEqual({
      workspaceId: 'uuid-ws',
      worktree: '',
    })
  })
})
