import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())
const workspaceStoreMocks = vi.hoisted(() => ({
  workspacePath: '/workspace-a',
  workspaceReady: true,
}))
const shareStoreMocks = vi.hoisted(() => ({
  status: {
    mode: 'managed_git' as 'managed_git' | 'custom_git' | 'oss' | null,
    gitRemoteUrl: 'https://example.com/repo.git' as string | null,
    gitAuthKind: 'https_token' as string | null,
    enabledAt: null as string | null,
    linkStatus: 'symlink' as 'symlink' | 'real_dir' | 'missing' | undefined,
    globalPath: '/home/me/.amuxd/teams/team-1/teamclaw-team' as string | null,
  },
  refresh: vi.fn(async () => {}),
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
  appShortName: 'teamclaw',
  TEAM_SYNCED_EVENT: 'team-synced',
  TEAM_REPO_DIR: 'teamclaw-team',
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(workspaceStoreMocks as unknown as Record<string, unknown>),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: { team: { id: string } | null }) => unknown) =>
    sel({ team: { id: 'team-1' } }),
}))

vi.mock('@/stores/team-share', () => ({
  useTeamShareStore: (sel: (s: typeof shareStoreMocks) => unknown) =>
    sel(shareStoreMocks),
}))

vi.mock('./TeamSyncPaths', () => ({
  TeamSyncPaths: () => <div>Team Sync Paths</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
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

describe('TeamGitConfig status panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workspaceStoreMocks.workspacePath = '/workspace-a'
    workspaceStoreMocks.workspaceReady = true
    shareStoreMocks.status = {
      mode: 'managed_git',
      gitRemoteUrl: 'https://example.com/repo.git',
      gitAuthKind: 'https_token',
      enabledAt: null,
      linkStatus: 'symlink',
      globalPath: '/home/me/.amuxd/teams/team-1/teamclaw-team',
    }
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        transformCallback: vi.fn(() => 0),
        invoke: vi.fn(async () => null),
      },
      configurable: true,
    })
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'team_shared_git_sync') return { success: true, message: 'Synced' }
      return null
    })
  })

  it('renders the status surface for a configured git-mode team (no legacy local config read)', async () => {
    render(<TeamGitConfig />)

    // Repo URL + managed-git mode label come from the FC share-mode status.
    expect(await screen.findByText('Managed Git')).toBeTruthy()
    expect(screen.getByText('https://example.com/repo.git')).toBeTruthy()
    expect(screen.getByText('Sync Now')).toBeTruthy()
    expect(screen.getByText('Shared Content')).toBeTruthy()
    // Legacy local-config commands are never called.
    expect(mockInvoke).not.toHaveBeenCalledWith('get_team_config', expect.anything())
    expect(mockInvoke).not.toHaveBeenCalledWith('save_team_config', expect.anything())
    // No legacy entry form.
    expect(
      screen.queryByPlaceholderText('https://github.com/team/shared-workspace.git'),
    ).toBeNull()
  })

  it('labels the self-hosted (custom_git) mode and SSH auth', async () => {
    shareStoreMocks.status = {
      mode: 'custom_git',
      gitRemoteUrl: 'git@example.com:team/repo.git',
      gitAuthKind: 'ssh_key',
      enabledAt: null,
      linkStatus: 'symlink',
      globalPath: null,
    }
    render(<TeamGitConfig />)
    expect(await screen.findByText('Self-hosted Git')).toBeTruthy()
    expect(screen.getByText('SSH')).toBeTruthy()
  })

  it('syncs through the daemon proxy with only workspacePath (no gitUrl/token)', async () => {
    render(<TeamGitConfig />)

    const syncButton = await screen.findByText('Sync Now')
    syncButton.click()

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('team_shared_git_sync', {
        config: { workspacePath: '/workspace-a' },
        force: false,
      })
    })
  })
})
