import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendMocks = vi.hoisted(() => ({
  listDaemonWorkspaces: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    workspaces: {
      listDaemonWorkspaces: backendMocks.listDaemonWorkspaces,
    },
    runtime: {
      fetchLatestRuntimeForSession: vi.fn(),
    },
    actors: {
      listActorDirectoryByIds: vi.fn().mockResolvedValue([]),
    },
  }),
}))

import {
  resolveAgentRuntimeWorkspaceId,
  resolveCloudWorkspaceIdForLocalPath,
  runtimeStartWorkspaceArgs,
} from '../resolve-runtime-start-workspace'

describe('resolveAgentRuntimeWorkspaceId', () => {
  it('prefers caller hint over session runtime and defaults', () => {
    expect(
      resolveAgentRuntimeWorkspaceId({
        callerWorkspaceId: 'ws-caller',
        sessionWorkspaceId: 'ws-session',
        defaultWorkspaceId: 'ws-default',
        ownedWorkspaceId: 'ws-owned',
      }),
    ).toBe('ws-caller')
  })

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

describe('resolveCloudWorkspaceIdForLocalPath', () => {
  beforeEach(() => {
    backendMocks.listDaemonWorkspaces.mockReset()
    backendMocks.listDaemonWorkspaces.mockResolvedValue([])
  })

  it('matches cloud workspace by daemon path', async () => {
    backendMocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-cloud',
        team_id: 'team-1',
        agent_id: 'agent-1',
        name: 'Main',
        path: '/Users/me/TeamClaw',
        archived: false,
        created_at: '',
        updated_at: '',
      },
    ])

    await expect(
      resolveCloudWorkspaceIdForLocalPath('team-1', '~/TeamClaw'),
    ).resolves.toBe('ws-cloud')
  })
})
