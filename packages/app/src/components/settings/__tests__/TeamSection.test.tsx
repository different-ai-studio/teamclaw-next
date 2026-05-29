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
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))

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
vi.mock('@/stores/team-share', () => ({
  useTeamShareStore: (sel: (s: { status: { mode: unknown } }) => unknown) =>
    sel({ status: { mode: teamShare.mode } }),
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
vi.mock('../team/TeamWebDavConfig', () => ({
  TeamWebDavConfig: () => <div data-testid="webdav-config">webdav</div>,
}))

import { TeamSection } from '../TeamSection'

beforeEach(() => {
  teamMode.teamModeType = null
  teamMode.myRole = null
  currentTeam.teamId = null
  workspace.workspacePath = null
  teamShare.mode = null
})

describe('TeamSection share-mode gating', () => {
  it('shows the onboarding wizard for an unconfigured team with a workspace', () => {
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(screen.getByTestId('onboarding').textContent).toContain(
      'onboarding:team-1:/ws',
    )
    expect(screen.queryByTestId('git-config')).toBeNull()
    expect(screen.queryByTestId('webdav-config')).toBeNull()
  })

  it('falls back to the legacy Git config when there is no team/workspace context', () => {
    render(<TeamSection />)
    expect(screen.getByTestId('git-config')).toBeTruthy()
    expect(screen.queryByTestId('onboarding')).toBeNull()
  })

  it('shows the WebDAV (OSS) config for an already-configured OSS team', () => {
    teamMode.teamModeType = 'webdav'
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(screen.getByTestId('webdav-config')).toBeTruthy()
    expect(screen.queryByTestId('onboarding')).toBeNull()
  })

  it('shows the Git config when a share mode is locked but legacy mode is unset', () => {
    teamShare.mode = 'managed_git'
    currentTeam.teamId = 'team-1'
    workspace.workspacePath = '/ws'
    render(<TeamSection />)
    expect(screen.getByTestId('git-config')).toBeTruthy()
    expect(screen.queryByTestId('onboarding')).toBeNull()
  })
})
