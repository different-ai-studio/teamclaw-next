import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const fileBrowserMock = vi.hoisted(() => vi.fn(() => <div data-testid="file-browser" />))

const workspaceState = vi.hoisted(() => ({
  workspacePath: '/workspace',
  refreshFileTree: vi.fn(),
}))

const teamModeState = vi.hoisted(() => ({
  teamModeType: null as string | null,
}))

const isTauriMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/components/workspace/FileBrowser', () => ({
  FileBrowser: fileBrowserMock,
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: typeof workspaceState) => unknown) => selector(workspaceState),
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: Object.assign(
    (selector: (state: typeof teamModeState) => unknown) => selector(teamModeState),
    {
      setState: vi.fn(),
      getState: () => ({
        loadTeamGitFileSyncStatus: vi.fn(),
      }),
    },
  ),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => isTauriMock(),
}))

vi.mock('@/lib/build-config', () => ({
  TEAM_REPO_DIR: 'teamclaw-team',
}))

vi.mock('@/lib/team-skill-paths', () => ({
  resolveTeamDir: vi.fn(),
}))

import { TeamSharedFilesBrowser } from '../TeamSharedFilesBrowser'

describe('TeamSharedFilesBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workspaceState.workspacePath = '/workspace'
    teamModeState.teamModeType = null
    isTauriMock.mockReturnValue(false)
  })

  it('scopes FileBrowser to the workspace team shared directory', async () => {
    render(<TeamSharedFilesBrowser />)

    await vi.waitFor(() => {
      expect(fileBrowserMock).toHaveBeenCalled()
    })

    const props = fileBrowserMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(props.rootPath).toBe('/workspace/teamclaw-team')
    expect(props.hideGitStatus).toBe(false)
  })

  it('shows unavailable state when workspace path is missing', () => {
    workspaceState.workspacePath = null as unknown as string
    const { container } = render(<TeamSharedFilesBrowser />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows unavailable message when team directory cannot be resolved', async () => {
    isTauriMock.mockReturnValue(true)
    const { exists } = await import('@tauri-apps/plugin-fs')
    vi.mocked(exists).mockResolvedValue(false)
    const { resolveTeamDir } = await import('@/lib/team-skill-paths')
    vi.mocked(resolveTeamDir).mockResolvedValue(null)

    render(<TeamSharedFilesBrowser />)

    expect(
      await screen.findByText(
        'Team shared directory is not set up yet. Enable team share in Settings → Team.',
      ),
    ).toBeTruthy()
  })
})
