import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  listDaemonWorkspaces: vi.fn(),
  getCurrentDaemonWorkspaceAgent: vi.fn(),
  getDaemonProviders: vi.fn(),
  loadTeamProviderFormState: vi.fn(),
  getCustomProviderIds: vi.fn(),
  getCustomProviderConfig: vi.fn(),
}))

vi.mock('@/lib/daemon-workspaces', () => ({
  getCurrentDaemonWorkspaceAgent: mocks.getCurrentDaemonWorkspaceAgent,
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

vi.mock('@/lib/teamclaw-config', () => ({
  getCustomProviderIds: mocks.getCustomProviderIds,
  getCustomProviderConfig: mocks.getCustomProviderConfig,
}))

import {
  resolveDaemonWorkspacePath,
  loadCronDialogProviders,
  loadCronDialogModels,
} from '@/lib/cron-workspace-models'

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
    mocks.getCustomProviderIds.mockReset()
    mocks.getCustomProviderConfig.mockReset()
    mocks.loadTeamProviderFormState.mockResolvedValue(null)
    mocks.getCustomProviderIds.mockResolvedValue([])
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

  it('merges providers from teamclaw.json config when daemon providers only include team', async () => {
    mocks.getDaemonProviders.mockResolvedValue([
      {
        id: 'team',
        display_name: 'Team',
        authenticated: true,
        models: ['gpt-5.2'],
      },
    ])
    mocks.getCustomProviderIds.mockResolvedValue(['scnet'])
    mocks.getCustomProviderConfig.mockResolvedValue({
      name: 'scnet',
      baseURL: 'https://api.scnet.cn/api/llm/v1',
      models: [{ modelId: 'MiniMax-M2.5', modelName: 'MiniMax-M2.5' }],
    })

    const providers = await loadCronDialogProviders('/ws')
    expect(providers.map((p) => p.id)).toEqual(['scnet'])
    expect(providers[0].models[0].id).toBe('MiniMax-M2.5')
  })
})

describe('loadCronDialogModels', () => {
  beforeEach(() => {
    mocks.getCurrentDaemonWorkspaceAgent.mockReset()
    mocks.listDaemonWorkspaces.mockReset()
    mocks.getDaemonProviders.mockReset()
    mocks.loadTeamProviderFormState.mockReset()
    mocks.getCustomProviderIds.mockReset()
    mocks.getCustomProviderConfig.mockReset()
    mocks.loadTeamProviderFormState.mockResolvedValue(null)
    mocks.getCustomProviderIds.mockResolvedValue([])
  })

  it('falls back to cloud daemon default when local registry has no default flag', async () => {
    mocks.getCurrentDaemonWorkspaceAgent.mockResolvedValue({
      id: 'agent-1',
      defaultWorkspaceId: 'cloud-ws-2',
    })
    mocks.listDaemonWorkspaces.mockResolvedValue([
      {
        id: 'cloud-ws-2',
        path: '/Users/me/copilot-ws-v2',
        archived: false,
      },
    ])
    mocks.getCustomProviderIds.mockResolvedValue(['scnet'])
    mocks.getCustomProviderConfig.mockResolvedValue({
      name: 'scnet',
      baseURL: 'https://api.scnet.cn/api/llm/v1',
      models: [{ modelId: 'MiniMax-M2.5', modelName: 'MiniMax-M2.5' }],
    })
    mocks.getDaemonProviders.mockResolvedValue([])

    const result = await loadCronDialogModels({
      activeScope: 'global',
      teamId: 'team-1',
      workspacePath: null,
      localWorkspaces: [
        {
          workspaceId: 'local-1',
          remoteWorkspaceId: 'cloud-ws-2',
          path: '/Users/me/copilot-ws-v2',
          displayName: 'copilot-ws-v2',
          teamId: 'team-1',
          isDefault: false,
        },
      ],
      messages: {
        workspaceNoPath: 'no path',
        globalNoTeam: 'no team',
        globalNoDefault: 'no default',
        globalNoDefaultPath: 'no default path',
        loadFailed: 'load failed',
      },
    })

    expect(result.hint).toBeNull()
    expect(result.providers[0].id).toBe('scnet')
  })
})
