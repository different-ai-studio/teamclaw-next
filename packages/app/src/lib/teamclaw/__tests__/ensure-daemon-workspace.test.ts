import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchWorkspaces = vi.fn()
const mockAddWorkspace = vi.fn()
const mockListWorkspacesByIds = vi.fn()
const mockToastError = vi.fn()

vi.mock('@/lib/teamclaw-rpc', () => ({
  fetchWorkspaces: (...args: unknown[]) => mockFetchWorkspaces(...args),
  addWorkspace: (...args: unknown[]) => mockAddWorkspace(...args),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    workspaces: {
      listWorkspacesByIds: (...args: unknown[]) => mockListWorkspacesByIds(...args),
    },
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}))

describe('ensureDaemonWorkspaceRegistered', () => {
  beforeEach(() => {
    mockFetchWorkspaces.mockReset()
    mockAddWorkspace.mockReset()
    mockListWorkspacesByIds.mockReset()
    mockToastError.mockReset()
    mockListWorkspacesByIds.mockResolvedValue([
      { id: 'cloud-ws-1', name: 'Proj', path: '/Users/me/Proj' },
    ])
    mockFetchWorkspaces.mockResolvedValue({ workspaces: [] })
    mockAddWorkspace.mockResolvedValue({
      accepted: true,
      error: '',
      workspace: { workspaceId: 'local01', path: '/Users/me/Proj', displayName: 'Proj' },
    })
  })

  it('returns empty runtimeWorkspaceId when cloud id is empty', async () => {
    const { ensureDaemonWorkspaceRegistered } = await import('../ensure-daemon-workspace')
    const result = await ensureDaemonWorkspaceRegistered({
      targetActorId: 'agent-1',
      teamId: 'team-1',
      cloudWorkspaceId: '',
    })
    expect(result).toEqual({ runtimeWorkspaceId: '' })
    expect(mockFetchWorkspaces).not.toHaveBeenCalled()
  })

  it('skips addWorkspace when daemon already has matching path', async () => {
    mockFetchWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'abc12345', path: '/Users/me/Proj', displayName: 'Proj' }],
    })

    const { ensureDaemonWorkspaceRegistered } = await import('../ensure-daemon-workspace')
    const result = await ensureDaemonWorkspaceRegistered({
      targetActorId: 'agent-1',
      teamId: 'team-1',
      cloudWorkspaceId: 'cloud-ws-1',
    })

    expect(result).toEqual({ runtimeWorkspaceId: 'abc12345' })
    expect(mockAddWorkspace).not.toHaveBeenCalled()
  })

  it('calls addWorkspace when daemon has no matching workspace', async () => {
    const { ensureDaemonWorkspaceRegistered } = await import('../ensure-daemon-workspace')
    const result = await ensureDaemonWorkspaceRegistered({
      targetActorId: 'agent-1',
      teamId: 'team-1',
      cloudWorkspaceId: 'cloud-ws-1',
      agentLabel: 'My Agent',
    })

    expect(mockAddWorkspace).toHaveBeenCalledWith({
      targetActorId: 'agent-1',
      path: '/Users/me/Proj',
    })
    expect(result).toEqual({ runtimeWorkspaceId: 'local01' })
  })

  it('shows toast and throws when addWorkspace fails', async () => {
    mockAddWorkspace.mockRejectedValue(new Error('path is not a directory'))

    const { ensureDaemonWorkspaceRegistered } = await import('../ensure-daemon-workspace')
    await expect(
      ensureDaemonWorkspaceRegistered({
        targetActorId: 'agent-1',
        teamId: 'team-1',
        cloudWorkspaceId: 'cloud-ws-1',
        agentLabel: 'My Agent',
      }),
    ).rejects.toThrow(/addWorkspace failed/)

    expect(mockToastError).toHaveBeenCalledWith(
      'Agent workspace 注册失败',
      expect.objectContaining({
        description: expect.stringContaining('path is not a directory'),
      }),
    )
  })

  it('shows toast when cloud workspace has no path', async () => {
    mockListWorkspacesByIds.mockResolvedValue([{ id: 'cloud-ws-1', name: 'Proj', path: null }])

    const { ensureDaemonWorkspaceRegistered } = await import('../ensure-daemon-workspace')
    await expect(
      ensureDaemonWorkspaceRegistered({
        targetActorId: 'agent-1',
        teamId: 'team-1',
        cloudWorkspaceId: 'cloud-ws-1',
      }),
    ).rejects.toThrow(/no filesystem path/)

    expect(mockToastError).toHaveBeenCalledWith(
      'Workspace 缺少路径',
      expect.any(Object),
    )
    expect(mockFetchWorkspaces).not.toHaveBeenCalled()
  })
})
