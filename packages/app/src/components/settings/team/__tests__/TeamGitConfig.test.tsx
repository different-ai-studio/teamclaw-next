import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())
const mockUpsertTeamWorkspaceConfig = vi.hoisted(() => vi.fn())
const mockSupabaseRpc = vi.hoisted(() => vi.fn())

const workspaceStoreMocks = vi.hoisted(() => ({
  workspacePath: '/workspace-a',
  workspaceReady: true,
}))

const teamMembersStoreMocks = vi.hoisted(() => ({
  loadMembers: vi.fn(),
  loadMyRole: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOptions === 'string') return fallbackOrOptions
      if (fallbackOrOptions && typeof fallbackOrOptions.defaultValue === 'string') {
        return fallbackOrOptions.defaultValue
      }
      return key
    },
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  copyToClipboard: vi.fn(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/build-config', () => ({
  buildConfig: {
    app: { name: 'TeamClaw' },
    team: {
      llm: { baseUrl: '', models: [] },
    },
  },
  TEAM_SYNCED_EVENT: 'team-synced',
  TEAM_REPO_DIR: 'teamclaw-team',
}))

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
  },
}))

vi.mock('@/lib/team-workspace-config', () => ({
  upsertTeamWorkspaceConfig: (...args: unknown[]) => mockUpsertTeamWorkspaceConfig(...args),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(workspaceStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: () => teamMembersStoreMocks,
}))

vi.mock('./HostLlmConfig', () => ({
  HostLlmConfig: () => <div>Host LLM</div>,
}))

vi.mock('@/components/settings/shared', () => ({
  ToggleSwitch: ({ enabled: _enabled, ...props }: any) => <button {...props} />,
}))

vi.mock('@/components/settings/TeamMemberList', () => ({
  TeamMemberList: () => <div>Team members</div>,
}))

vi.mock('@/components/settings/DeviceIdDisplay', () => ({
  DeviceIdDisplay: () => <div>Device ID</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: any) => <div>{children}</div>,
  CollapsibleContent: ({ children }: any) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: any) => <button>{children}</button>,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { TeamGitConfig } from '../TeamGitConfig'

describe('TeamGitConfig workspace-aware calls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workspaceStoreMocks.workspacePath = '/workspace-a'
    workspaceStoreMocks.workspaceReady = true
    teamMembersStoreMocks.loadMembers.mockReset()
    teamMembersStoreMocks.loadMyRole.mockReset()
    mockUpsertTeamWorkspaceConfig.mockReset()
    mockSupabaseRpc.mockReset()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        transformCallback: vi.fn(() => 0),
        invoke: vi.fn(async () => null),
      },
      configurable: true,
    })
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'team_check_git_installed') return { installed: true, version: 'git version 2.0.0' }
      if (cmd === 'get_team_config') return null
      if (cmd === 'get_device_info') return { nodeId: 'node-123' }
      return null
    })
  })

  it('passes workspacePath when loading the Git team config', async () => {
    render(<TeamGitConfig />)

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_team_config', { workspacePath: '/workspace-a' })
    })
  })

  it('loads configured shared directory without initializing legacy git secrets', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'team_check_git_installed') return { installed: true, version: 'git version 2.0.0' }
      if (cmd === 'get_team_config') {
        return {
          gitUrl: 'https://example.com/repo.git',
          enabled: false,
          lastSyncAt: null,
          sharedDirName: 'teamclaw',
          envSecret: '00'.repeat(32),
          teamId: 'team-123',
        }
      }
      if (cmd === 'get_team_status') return { active: true, llm: null }
      if (cmd === 'get_device_info') return { nodeId: 'node-123' }
      return null
    })

    render(<TeamGitConfig />)

    expect(await screen.findByText('Runtime Details')).toBeTruthy()
    expect(screen.getByText('Workspace Path')).toBeTruthy()
    expect(screen.getByText('/workspace-a')).toBeTruthy()
    expect(screen.getByText('/workspace-a/teamclaw')).toBeTruthy()

    expect(mockInvoke).not.toHaveBeenCalledWith('init_git_team_secrets', expect.anything())
  })

  it('creates a team, sets up the shared git directory, and saves envSecret locally', async () => {
    mockSupabaseRpc.mockImplementation((fn: string) => {
      if (fn === 'create_team') {
        return { single: vi.fn().mockResolvedValue({ data: { id: 'team-123' }, error: null }) }
      }
      return Promise.resolve({ data: null, error: null })
    })
    mockUpsertTeamWorkspaceConfig.mockResolvedValue({
      teamId: 'team-123',
      gitUrl: 'https://example.com/repo.git',
      gitBranch: 'main',
      gitToken: null,
      aiGatewayEndpoint: null,
      sharedDirName: 'teamclaw',
      envSecret: '11'.repeat(32),
      lastSyncAt: null,
      lastSyncError: null,
      enabled: true,
      updatedAt: '2026-05-26T00:00:00.000Z',
    })
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'team_check_git_installed') return { installed: true, version: 'git version 2.0.0' }
      if (cmd === 'get_team_config') return null
      if (cmd === 'team_shared_git_setup') return { sharedDirPath: '/workspace-a/teamclaw' }
      if (cmd === 'save_team_config') return null
      return null
    })

    render(<TeamGitConfig />)

    fireEvent.change(await screen.findByPlaceholderText('My Team'), {
      target: { value: 'My Team' },
    })
    fireEvent.change(screen.getByPlaceholderText('https://github.com/team/shared-workspace.git'), {
      target: { value: 'https://example.com/repo.git' },
    })
    fireEvent.change(screen.getByPlaceholderText('teamclaw'), {
      target: { value: 'teamclaw' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Configure Team Shared Directory/ }))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('team_shared_git_setup', {
        config: {
          workspacePath: '/workspace-a',
          gitUrl: 'https://example.com/repo.git',
          gitBranch: null,
          gitToken: null,
          sharedDirName: 'teamclaw',
        },
      })
    })
    expect(mockInvoke).toHaveBeenCalledWith('save_team_config', {
      team: expect.objectContaining({
        teamId: 'team-123',
        sharedDirName: 'teamclaw',
        envSecret: '11'.repeat(32),
      }),
      workspacePath: '/workspace-a',
    })
    expect(mockInvoke).not.toHaveBeenCalledWith('init_git_team_secrets', expect.anything())
    expect(mockSupabaseRpc).not.toHaveBeenCalledWith('create_team_invite', expect.anything())
  })

  it('syncs configured teams through the shared git command', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'team_check_git_installed') return { installed: true, version: 'git version 2.0.0' }
      if (cmd === 'get_team_config') {
        return {
          gitUrl: 'https://example.com/repo.git',
          gitBranch: 'main',
          gitToken: null,
          enabled: true,
          lastSyncAt: null,
          sharedDirName: 'teamclaw',
          envSecret: '00'.repeat(32),
          teamId: 'team-123',
        }
      }
      if (cmd === 'team_shared_git_sync') return { success: true, message: 'Synced' }
      if (cmd === 'save_team_config') return null
      if (cmd === 'get_team_status') return { active: true, llm: null }
      if (cmd === 'get_device_info') return { nodeId: 'node-123' }
      return null
    })

    render(<TeamGitConfig />)

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('team_shared_git_sync', {
        config: {
          workspacePath: '/workspace-a',
          gitUrl: 'https://example.com/repo.git',
          gitBranch: 'main',
          gitToken: null,
          sharedDirName: 'teamclaw',
        },
        force: false,
      })
    })
  })
})
