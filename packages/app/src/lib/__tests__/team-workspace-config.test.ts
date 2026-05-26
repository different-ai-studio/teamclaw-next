import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTeamWorkspaceConfig, upsertTeamWorkspaceConfig } from '../team-workspace-config'

const fromMock = vi.fn()
const eqMock = vi.fn()
const maybeSingleMock = vi.fn()
const upsertMock = vi.fn()
const selectMock = vi.fn()
const singleMock = vi.fn()

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}))

beforeEach(() => {
  fromMock.mockReset()
  eqMock.mockReset()
  maybeSingleMock.mockReset()
  upsertMock.mockReset()
  selectMock.mockReset()
  singleMock.mockReset()
})

describe('getTeamWorkspaceConfig', () => {
  it('maps Supabase row fields to camelCase config fields', async () => {
    maybeSingleMock.mockResolvedValue({
      data: {
        team_id: 'team-1',
        git_url: 'https://github.com/team/repo.git',
        git_branch: 'main',
        git_token: 'ghp_secret',
        ai_gateway_endpoint: 'https://gateway.example',
        shared_dir_name: 'shared-team',
        env_secret: 'env-secret',
        last_sync_at: '2026-05-26T01:02:03.000Z',
        last_sync_error: 'sync failed',
        enabled: true,
        updated_at: '2026-05-26T04:05:06.000Z',
      },
      error: null,
    })
    eqMock.mockReturnValue({ maybeSingle: maybeSingleMock })
    const select = vi.fn().mockReturnValue({ eq: eqMock })
    fromMock.mockReturnValue({ select })

    const config = await getTeamWorkspaceConfig('team-1')

    expect(select).toHaveBeenCalledWith(
      'team_id, git_url, git_branch, git_token, ai_gateway_endpoint, shared_dir_name, env_secret, last_sync_at, last_sync_error, enabled, updated_at',
    )
    expect(eqMock).toHaveBeenCalledWith('team_id', 'team-1')
    expect(config).toEqual({
      teamId: 'team-1',
      gitUrl: 'https://github.com/team/repo.git',
      gitBranch: 'main',
      gitToken: 'ghp_secret',
      aiGatewayEndpoint: 'https://gateway.example',
      sharedDirName: 'shared-team',
      envSecret: 'env-secret',
      lastSyncAt: '2026-05-26T01:02:03.000Z',
      lastSyncError: 'sync failed',
      enabled: true,
      updatedAt: '2026-05-26T04:05:06.000Z',
    })
  })

  it('defaults sharedDirName for rows created before the column existed', async () => {
    maybeSingleMock.mockResolvedValue({
      data: {
        team_id: 'team-1',
        git_url: null,
        git_branch: null,
        git_token: null,
        ai_gateway_endpoint: null,
        shared_dir_name: null,
        env_secret: null,
        last_sync_at: null,
        last_sync_error: null,
        enabled: true,
        updated_at: '2026-05-26T04:05:06.000Z',
      },
      error: null,
    })
    eqMock.mockReturnValue({ maybeSingle: maybeSingleMock })
    fromMock.mockReturnValue({ select: vi.fn().mockReturnValue({ eq: eqMock }) })

    const config = await getTeamWorkspaceConfig('team-1')

    expect(config?.sharedDirName).toBe('teamclaw')
  })
})

describe('upsertTeamWorkspaceConfig', () => {
  it('writes shared_dir_name and reads env_secret from the returned row', async () => {
    singleMock.mockResolvedValue({
      data: {
        team_id: 'team-1',
        git_url: 'https://github.com/team/repo.git',
        git_branch: 'main',
        git_token: null,
        ai_gateway_endpoint: null,
        shared_dir_name: 'team-shared',
        env_secret: 'generated-secret',
        last_sync_at: null,
        last_sync_error: null,
        enabled: true,
        updated_at: '2026-05-26T04:05:06.000Z',
      },
      error: null,
    })
    selectMock.mockReturnValue({ single: singleMock })
    upsertMock.mockReturnValue({ select: selectMock })
    fromMock.mockReturnValue({ upsert: upsertMock })

    const config = await upsertTeamWorkspaceConfig({
      teamId: 'team-1',
      gitUrl: 'https://github.com/team/repo.git',
      gitBranch: 'main',
      gitToken: null,
      aiGatewayEndpoint: null,
      sharedDirName: 'team-shared',
      enabled: true,
    })

    expect(upsertMock).toHaveBeenCalledWith({
      team_id: 'team-1',
      git_url: 'https://github.com/team/repo.git',
      git_branch: 'main',
      git_token: null,
      ai_gateway_endpoint: null,
      shared_dir_name: 'team-shared',
      enabled: true,
    })
    expect(selectMock).toHaveBeenCalledWith(
      'team_id, git_url, git_branch, git_token, ai_gateway_endpoint, shared_dir_name, env_secret, last_sync_at, last_sync_error, enabled, updated_at',
    )
    expect(config.envSecret).toBe('generated-secret')
  })
})
