import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  listDaemonWorkspaces: vi.fn(),
  getDaemonProviders: vi.fn(),
  loadTeamProviderFormState: vi.fn(),
}))

vi.mock('@/lib/daemon-workspaces', () => ({
  getCurrentDaemonWorkspaceAgent: vi.fn(),
  listDaemonWorkspaces: mocks.listDaemonWorkspaces,
}))

vi.mock('@/lib/daemon-local-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/daemon-local-client')>()
  return {
    ...actual,
    getDaemonProviders: mocks.getDaemonProviders,
    encodeWorkspaceId: (path: string) => `ws:${path}`,
  }
})

vi.mock('@/lib/team-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/team-provider')>()
  return {
    ...actual,
    loadTeamProviderFormState: mocks.loadTeamProviderFormState,
  }
})

import { resolveDaemonWorkspacePath, loadCronDialogProviders } from '@/lib/cron-workspace-models'

describe('resolveDaemonWorkspacePath', () => {
  beforeEach(() => {
    mocks.listDaemonWorkspaces.mockReset()
  })

  it('returns canonical daemon path when local path matches by suffix', async () => {
    mocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'ws-1',
        path: '/Users/me/projects/MyApp',
        teamId: 't1',
        agentId: null,
        createdByMemberId: null,
        name: 'MyApp',
        archived: false,
        createdAt: '',
        updatedAt: '',
      },
    ])

    const resolved = await resolveDaemonWorkspacePath(
      'team-1',
      '~/projects/MyApp',
    )
    expect(resolved).toBe('/Users/me/projects/MyApp')
    expect(mocks.getDaemonProviders).not.toHaveBeenCalled()
  })
})

describe('loadCronDialogProviders', () => {
  beforeEach(() => {
    mocks.getDaemonProviders.mockReset()
    mocks.loadTeamProviderFormState.mockReset()
    mocks.loadTeamProviderFormState.mockResolvedValue(null)
  })

  it('prefers workspace daemon providers over team-only opencode entry', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'team',
        display_name: 'Team',
        authenticated: true,
        models: ['team-model'],
      },
      {
        id: 'anthropic',
        display_name: 'Anthropic',
        authenticated: true,
        models: ['claude-sonnet-4-6'],
      },
    ])

    const providers = await loadCronDialogProviders('/Users/me/projects/MyApp')
    expect(providers.map((p) => p.id)).toEqual(['anthropic'])
    expect(providers[0].models[0].id).toBe('claude-sonnet-4-6')
  })

  it('includes team shared from provider.json alongside workspace providers', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'custom',
        display_name: 'Custom',
        authenticated: true,
        models: ['my-model'],
      },
    ])
    mocks.loadTeamProviderFormState.mockResolvedValue({
      enabled: true,
      baseUrl: 'https://llm.example',
      models: [{ id: 'shared-1', name: 'Shared 1' }],
    })

    const providers = await loadCronDialogProviders('/ws')
    expect(providers.map((p) => p.id)).toEqual(['team', 'custom'])
  })
})
