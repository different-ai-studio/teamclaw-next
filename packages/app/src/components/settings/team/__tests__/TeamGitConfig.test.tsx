import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())
const workspaceStoreMocks = vi.hoisted(() => ({
  workspacePath: '/workspace-a',
  workspaceReady: true,
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

vi.mock('./HostLlmConfig', () => ({
  HostLlmConfig: () => <div>Host LLM</div>,
}))

vi.mock('./TeamSyncPaths', () => ({
  TeamSyncPaths: () => <div>Team Sync Paths</div>,
}))

vi.mock('@/components/settings/shared', () => ({
  ToggleSwitch: ({ enabled: _enabled, ...props }: any) => <button {...props} />,
}))

vi.mock('@/components/settings/DeviceIdDisplay', () => ({
  DeviceIdDisplay: () => <div>Device ID</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
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

describe('TeamGitConfig status panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workspaceStoreMocks.workspacePath = '/workspace-a'
    workspaceStoreMocks.workspaceReady = true
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

  it('shows an unconfigured notice when no team config exists (no entry form)', async () => {
    render(<TeamGitConfig />)

    expect(await screen.findByText('Team Git sync not configured')).toBeTruthy()
    // The old git-URL/token entry form is gone.
    expect(
      screen.queryByPlaceholderText('https://github.com/team/shared-workspace.git'),
    ).toBeNull()
    expect(screen.queryByPlaceholderText('glpat-xxxxxxxxxxxxxxxxxxxx')).toBeNull()
  })

  it('renders the status surface for a configured team', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'team_check_git_installed') return { installed: true, version: 'git version 2.0.0' }
      if (cmd === 'get_team_config') {
        return {
          gitUrl: 'https://example.com/repo.git',
          enabled: false,
          lastSyncAt: null,
          sharedDirName: 'teamclaw',
          envSecret: '00'.repeat(32),
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
    // No legacy entry form / secret init.
    expect(
      screen.queryByPlaceholderText('https://github.com/team/shared-workspace.git'),
    ).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalledWith('init_git_team_secrets', expect.anything())
  })

  it('syncs configured teams through the shared git command without a precheck', async () => {
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
