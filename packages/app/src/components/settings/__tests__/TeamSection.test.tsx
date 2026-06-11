import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Hoisted, mutable store state — each test assigns before render.
// ---------------------------------------------------------------------------
const teamMode = vi.hoisted(() => ({
  teamModeType: null as string | null,
  myRole: null as string | null,
}))
const currentTeam = vi.hoisted(() => ({ teamId: null as string | null }))
const workspace = vi.hoisted(() => ({
  workspacePath: null as string | null,
}))
const teamShare = vi.hoisted(() => ({
  mode: null as 'oss' | 'managed_git' | 'custom_git' | null,
  refresh: vi.fn(),
}))

function mockRefreshFromMode() {
  teamShare.refresh = vi.fn().mockImplementation(() =>
    Promise.resolve({
      mode: teamShare.mode,
      gitRemoteUrl: teamShare.mode ? 'https://example.com/repo.git' : null,
      gitAuthKind: teamShare.mode ? 'https_token' : null,
      enabledAt: teamShare.mode ? '2026-01-01T00:00:00Z' : null,
    }),
  )
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true, cn: (...a: string[]) => a.join(' ') }))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: (sel: (s: typeof teamMode) => unknown) => sel(teamMode),
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (
    sel: (s: { team: { id: string } | null }) => unknown,
  ) => sel({ team: currentTeam.teamId ? { id: currentTeam.teamId } : null }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: typeof workspace) => unknown) => sel(workspace),
}))
vi.mock('@/stores/team-share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/team-share')>()
  return {
    ...actual,
    useTeamShareStore: (
      sel: (s: { status: { mode: unknown }; refresh: unknown }) => unknown,
    ) => sel({ status: { mode: teamShare.mode }, refresh: teamShare.refresh }),
  }
})

vi.mock('@/lib/team-permissions', () => ({
  useTeamPermissions: () => ({ role: 'owner', isOwner: true, canManageTeam: true, canEditFiles: true }),
}))

// Child components are exercised by their own tests — here we only assert which
// branch of TeamSection renders, so stub them with identifiable markers.
vi.mock('../team/TeamShareSection', () => ({
  TeamShareSection: (props: { teamId: string; workspacePath: string }) => (
    <div data-testid="onboarding">
      onboarding:{props.teamId}:{props.workspacePath}
    </div>
  ),
}))
vi.mock('../team/TeamGitConfig', () => ({
  TeamGitConfig: () => <div data-testid="git-config">git</div>,
}))
vi.mock('../team/TeamOssSyncStatus', () => ({
  TeamOssSyncStatus: () => <div data-testid="oss-status">oss</div>,
}))

import { TeamSection } from '../TeamSection'

beforeEach(() => {
  teamMode.teamModeType = null
  teamMode.myRole = null
  currentTeam.teamId = null
  workspace.workspacePath = null
  teamShare.mode = null
  mockRefreshFromMode()
})

describe('TeamSection share-mode gating', () => {
  it('shows the onboarding wizard for an unconfigured team with a workspace', async () => {
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    // share status resolves async (spinner first), then the wizard renders.
    expect((await screen.findByTestId('onboarding')).textContent).toContain(
      'onboarding:team-1:/ws',
    )
    expect(screen.queryByTestId('git-config')).toBeNull()
    expect(screen.queryByTestId('oss-status')).toBeNull()
  })

  it('shows the missing-prereq notice when there is no team/workspace context', () => {
    render(<TeamSection />)
    // PR #224: no team + no workspace surfaces the prereq notice, not the git form.
    expect(screen.queryByTestId('onboarding')).toBeNull()
    expect(screen.queryByTestId('git-config')).toBeNull()
    expect(screen.queryByTestId('oss-status')).toBeNull()
  })

  it("routes shareMode 'oss' to the OSS sync status, not the git form", async () => {
    teamShare.mode = 'oss'
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('oss-status')).toBeTruthy()
    expect(screen.queryByTestId('git-config')).toBeNull()
  })

  it('routes the legacy webdav teamModeType to the OSS sync status when shareMode is absent', async () => {
    teamMode.teamModeType = 'webdav'
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('oss-status')).toBeTruthy()
    expect(screen.queryByTestId('git-config')).toBeNull()
  })

  it('routes legacy git teamModeType without FC shareMode to the onboarding wizard', async () => {
    teamMode.teamModeType = 'git'
    teamShare.mode = null
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('onboarding')).toBeTruthy()
    expect(screen.queryByTestId('git-config')).toBeNull()
  })

  it('shows the Git config for a locked git share mode', async () => {
    teamShare.mode = 'managed_git'
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('git-config')).toBeTruthy()
    expect(screen.queryByTestId('oss-status')).toBeNull()
  })

  it('shows the onboarding wizard when FC returns null even if the store snapshot had git mode', async () => {
    // Regression: routing must follow refresh() result, not a stale zustand value.
    teamShare.mode = null
    teamShare.refresh = vi.fn().mockResolvedValue({
      mode: null,
      gitRemoteUrl: 'https://git.example.com/orphan.git',
      gitAuthKind: 'https_token',
      enabledAt: null,
    })
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(await screen.findByTestId('onboarding')).toBeTruthy()
    expect(screen.queryByTestId('git-config')).toBeNull()
  })
})
